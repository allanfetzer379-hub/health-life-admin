begin;

alter table public.orders add column deleted_at timestamptz;

create index orders_deleted_at
  on public.orders (deleted_at desc, id)
  where deleted_at is not null;

-- Older dashboards also get only active rows from the table endpoint.
alter policy admin_read on public.orders
  using (public.is_admin() and deleted_at is null);

create function public.admin_load_deleted_orders(p_limit integer, p_offset integer)
returns setof public.orders
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;

  return query
  select o.*
  from public.orders o
  where o.deleted_at is not null
  order by o.deleted_at desc, o.id
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Include retired orders in the daily sequence so deletion cannot renumber other orders.
-- The unnamed row argument exposes a PostgREST computed field rather than a named RPC.
create function public.display_id(public.orders)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  order_date date := ($1).created_at at time zone 'Asia/Taipei';
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;

  return private.order_display_id(order_date, (
    select count(*)
    from public.orders o
    where o.created_at >= (order_date::timestamp at time zone 'Asia/Taipei')
      and (o.created_at, o.id) <= (($1).created_at, ($1).id)
  ));
end;
$$;

create function public.set_order_deleted(p_id text, p_deleted boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_deleted is null then
    raise exception '删除状态无效' using errcode = '22023';
  end if;

  update public.orders o
  set deleted_at = case when p_deleted then now() else null end,
      logs = o.logs || jsonb_build_array(jsonb_build_object(
        'at', now(),
        'text', case when p_deleted then '删除订单' else '恢复订单' end,
        'actor', auth.uid()
      ))
  where o.id = p_id and (o.deleted_at is not null) <> p_deleted;

  if not found and not exists (select 1 from public.orders o where o.id = p_id) then
    raise exception '订单不存在' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.admin_load_deleted_orders(integer, integer),
  public.display_id(public.orders), public.set_order_deleted(text, boolean)
from public, anon, authenticated;
grant execute on function public.admin_load_deleted_orders(integer, integer),
  public.display_id(public.orders), public.set_order_deleted(text, boolean)
to authenticated;

-- This projection protects both current staff list and by-ID reads.

create or replace view private.staff_order_summary as
select
  o.id, o.assigned_staff_id, o.name, o.phone, o.created_at,
  (o.created_at at time zone 'Asia/Taipei')::date as order_date,
  case lower(btrim(o.source))
    when 'facebook' then 'Facebook'
    when 'fb' then 'Facebook'
    when 'meta' then 'Facebook'
    when 'tiktok' then 'TikTok'
    when 'tk' then 'TikTok'
    when '' then '直接访问'
    when '直接访问' then '直接访问'
    else '其他来源'
  end as source,
  case when o.ad_id ~ '^[A-Za-z0-9_-]+$' then o.ad_id else '' end as ad_id,
  o.product, o.quantity, o.price, o.status, o.notes, o.invalid_reason,
  jsonb_array_length(o.matches) > 0 as is_duplicate,
  o.ip_country, o.ip_city
from public.orders o
where o.deleted_at is null;

create or replace function public.staff_load_orders(p_limit integer, p_offset integer)
returns table (
  id text,
  display_id text,
  name text,
  phone text,
  created_at timestamptz,
  source text,
  ad_id text,
  product text,
  quantity integer,
  price integer,
  status text,
  notes text,
  invalid_reason text,
  is_duplicate boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if public.nk_current_role() is distinct from 'staff' then
    raise exception '无权限' using errcode = '42501';
  end if;

  -- Number all orders within each Taipei date, then return the employee's rows.
  return query
  with numbered as (
    select
      o.id,
      (o.created_at at time zone 'Asia/Taipei')::date as order_date,
      row_number() over (
        partition by (o.created_at at time zone 'Asia/Taipei')::date
        order by o.created_at, o.id
      )::text as daily_number
    from public.orders o
  )
  select
    o.id,
    'NK-' || to_char(n.order_date, 'YYYYMMDD') || '-' ||
      lpad(n.daily_number, greatest(3, length(n.daily_number)), '0'),
    o.name,
    o.phone,
    o.created_at,
    case lower(btrim(o.source))
      when 'facebook' then 'Facebook'
      when 'fb' then 'Facebook'
      when 'meta' then 'Facebook'
      when 'tiktok' then 'TikTok'
      when 'tk' then 'TikTok'
      when '' then '直接访问'
      when '直接访问' then '直接访问'
      else '其他来源'
    end,
    case when o.ad_id ~ '^[A-Za-z0-9_-]+$' then o.ad_id else '' end,
    o.product,
    o.quantity,
    o.price,
    o.status,
    o.notes,
    o.invalid_reason,
    jsonb_array_length(o.matches) > 0
  from public.orders o
  join numbered n on n.id = o.id
  where o.assigned_staff_id = auth.uid() and o.deleted_at is null
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Block edits against deleted records, including stale tabs and legacy clients.
create or replace function public.update_order(
  p_id text,
  p_status text,
  p_notes text,
  p_reason text default ''
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_role text := public.nk_current_role();
  reason_to_save text := case when p_status = 'invalid' then coalesce(p_reason, '') else '' end;
begin
  if actor_role is null then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'contacted', 'confirmed', 'shipped', 'completed', 'cancelled', 'invalid')
    or p_notes is null or length(p_notes) > 2000 or length(coalesce(p_reason, '')) > 100 then
    raise exception '输入无效';
  end if;
  if p_status = 'invalid' and btrim(reason_to_save) = '' then
    raise exception '请选择无效原因';
  end if;

  update public.orders o
  set status = p_status,
      notes = p_notes,
      invalid_reason = reason_to_save,
      logs = o.logs || jsonb_build_array(jsonb_build_object(
        'at', now(),
        'text', case
          when o.status is distinct from p_status or o.invalid_reason is distinct from reason_to_save
            then '更新状态：' || p_status ||
              case when reason_to_save <> '' then '；原因：' || reason_to_save else '' end
          else '更新备注'
        end,
        'actor', auth.uid()
      ))
  where o.id = p_id and o.deleted_at is null
    and (actor_role = 'admin' or o.assigned_staff_id = auth.uid());

  if not found then
    raise exception '订单不存在或无权限';
  end if;
end;
$$;

create or replace function public.save_order_notes(p_id text, p_notes text, p_expected_notes text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_role text := public.nk_current_role();
begin
  if actor_role is null then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_notes is null or p_expected_notes is null or length(p_notes) > 2000 then
    raise exception '备注内容无效';
  end if;

  update public.orders o
  set notes = p_notes,
      logs = case when o.notes is distinct from p_notes then
        o.logs || jsonb_build_array(jsonb_build_object(
          'at', now(), 'text', '更新备注', 'actor', auth.uid()
        )) else o.logs end
  where o.id = p_id and o.deleted_at is null
    and (actor_role = 'admin' or o.assigned_staff_id = auth.uid())
    and o.notes = p_expected_notes;
  if found then return; end if;

  if exists (
    select 1 from public.orders o
    where o.id = p_id and o.deleted_at is null
      and (actor_role = 'admin' or o.assigned_staff_id = auth.uid())
  ) then
    raise exception '备注已被其他人更新，请重新核对后保存。' using errcode = 'PT409';
  end if;
  raise exception '订单不存在或无权限' using errcode = '42501';
end;
$$;

create or replace function public.save_order_status(p_id text, p_status text, p_reason text default '')
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  actor_role text := public.nk_current_role();
  reason_to_save text := case when p_status = 'invalid' then coalesce(p_reason, '') else '' end;
begin
  if actor_role is null then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'contacted', 'confirmed', 'shipped', 'completed', 'cancelled', 'invalid')
    or length(coalesce(p_reason, '')) > 100 then
    raise exception '输入无效';
  end if;
  if p_status = 'invalid' and btrim(reason_to_save) = '' then
    raise exception '请选择无效原因';
  end if;

  update public.orders o
  set status = p_status, invalid_reason = reason_to_save,
      logs = case when o.status is distinct from p_status or o.invalid_reason is distinct from reason_to_save then
        o.logs || jsonb_build_array(jsonb_build_object(
          'at', now(), 'text', '更新状态：' || p_status ||
            case when reason_to_save <> '' then '；原因：' || reason_to_save else '' end,
          'actor', auth.uid()
        )) else o.logs end
  where o.id = p_id and o.deleted_at is null
    and (actor_role = 'admin' or o.assigned_staff_id = auth.uid());
  if not found then
    raise exception '订单不存在或无权限' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.admin_assign_order(p_id text, p_staff_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_staff_id is not null and not exists (
    select 1 from private.staff_members s where s.user_id = p_staff_id and s.enabled
  ) then
    raise exception '请选择已启用的员工';
  end if;

  update public.orders o
  set assigned_staff_id = p_staff_id,
      logs = case when o.assigned_staff_id is distinct from p_staff_id
        then o.logs || jsonb_build_array(jsonb_build_object(
          'at', now(),
          'text', case when p_staff_id is null then '取消员工分配' else '分配给员工' end,
          'actor', auth.uid(),
          'staff', p_staff_id
        ))
        else o.logs
      end
  where o.id = p_id and o.deleted_at is null;

  if not found then
    raise exception '订单不存在';
  end if;
end;
$$;

create or replace function private.broadcast_order_updates()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  change_type text;
  order_id text;
begin
  if tg_op = 'UPDATE' then
    if old is not distinct from new then return null; end if;
    if (old.ip_country, old.ip_city) is distinct from (new.ip_country, new.ip_city)
      and (to_jsonb(old) - array['ip_country', 'ip_city']) is not distinct from
        (to_jsonb(new) - array['ip_country', 'ip_city']) then
      return null;
    end if;
  end if;

  change_type := case
    when tg_op = 'DELETE' then 'remove'
    when tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then 'remove'
    else lower(tg_op)
  end;
  order_id := case when tg_op = 'DELETE' then old.id else new.id end;
  perform private.broadcast_order_change(order_id, change_type, 'nk-orders:admin');

  -- A deleted order disappears from the assigned staff list without exposing its details.
  if tg_op <> 'INSERT' and old.deleted_at is null and exists (
    select 1 from private.staff_members s where s.user_id = old.assigned_staff_id and s.enabled
  ) then
    if change_type = 'remove' or old.assigned_staff_id is distinct from new.assigned_staff_id then
      perform private.broadcast_order_change(order_id, 'remove', 'nk-orders:staff:' || old.assigned_staff_id::text);
    end if;
  end if;
  if tg_op <> 'DELETE' and new.deleted_at is null and exists (
    select 1 from private.staff_members s where s.user_id = new.assigned_staff_id and s.enabled
  ) then
    -- Restoring or reassigning refreshes the list without claiming a new checkout.
    perform private.broadcast_order_change(order_id, change_type, 'nk-orders:staff:' || new.assigned_staff_id::text);
  end if;
  return null;
end;
$$;

notify pgrst, 'reload schema';

commit;
