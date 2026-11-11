begin;

alter table public.orders
  add column ip_country text not null default '',
  add column ip_city text not null default '';

create table private.nk_ip_locations (
  ip_start inet primary key,
  ip_end inet not null,
  city text not null,
  check (family(ip_start) = family(ip_end) and ip_start <= ip_end),
  check (masklen(ip_start) = case family(ip_start) when 4 then 32 else 128 end),
  check (masklen(ip_end) = case family(ip_end) when 4 then 32 else 128 end),
  check (length(city) <= 80 and city !~ '[[:cntrl:]]')
);
alter table private.nk_ip_locations enable row level security;
revoke all on private.nk_ip_locations from public, anon, authenticated;

create index nk_ip_locations_family_start
  on private.nk_ip_locations (family(ip_start), ip_start desc);

-- The imported ranges contain Taiwan entries only. Check the upper bound so
-- an IP in a gap between imported ranges is not treated as a Taiwan address.
create function private.nk_order_ip_location(p_ip inet)
returns table (ip_country text, ip_city text)
language sql stable strict
set search_path = ''
as $$
  select 'TW'::text, candidate.city
  from (
    select r.ip_end, r.city
    from private.nk_ip_locations r
    where family(r.ip_start) = family(p_ip) and r.ip_start <= p_ip
    order by r.ip_start desc
    limit 1
  ) candidate
  where p_ip <= candidate.ip_end
$$;

create function private.set_new_order_ip_location()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  select l.ip_country, l.ip_city into new.ip_country, new.ip_city
  from private.nk_order_ip_location(new.ip) l;
  new.ip_country := coalesce(new.ip_country, '');
  new.ip_city := coalesce(new.ip_city, '');
  return new;
end;
$$;

revoke all on function private.nk_order_ip_location(inet), private.set_new_order_ip_location()
from public, anon, authenticated;

create trigger set_new_order_ip_location
before insert on public.orders
for each row execute function private.set_new_order_ip_location();

-- This projection is shared by the employee list and single-order reads.
create view private.staff_order_summary as
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
from public.orders o;

revoke all on private.staff_order_summary from public, anon, authenticated;

create function private.order_display_id(order_date date, daily_number bigint)
returns text
language sql stable
set search_path = ''
as $$
  select 'NK-' || to_char(order_date, 'YYYYMMDD') || '-' ||
    lpad(daily_number::text, greatest(3, length(daily_number::text)), '0')
$$;

revoke all on function private.order_display_id(date, bigint) from public, anon, authenticated;

create function public.staff_load_orders_v2(p_limit integer, p_offset integer)
returns table (
  id text, display_id text, name text, phone text, created_at timestamptz,
  source text, ad_id text, product text, quantity integer, price integer,
  status text, notes text, invalid_reason text, is_duplicate boolean,
  ip_country text, ip_city text
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if public.nk_current_role() is distinct from 'staff' then
    raise exception '无权限' using errcode = '42501';
  end if;

  return query
  with numbered as (
    select o.id, row_number() over (
      partition by (o.created_at at time zone 'Asia/Taipei')::date
      order by o.created_at, o.id
    ) as daily_number
    from public.orders o
  )
  select s.id, private.order_display_id(s.order_date, n.daily_number),
    s.name, s.phone, s.created_at, s.source, s.ad_id, s.product, s.quantity,
    s.price, s.status, s.notes, s.invalid_reason, s.is_duplicate, s.ip_country, s.ip_city
  from private.staff_order_summary s
  join numbered n on n.id = s.id
  where s.assigned_staff_id = auth.uid()
  order by s.created_at desc, s.id
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create function public.staff_load_orders_by_ids(p_ids text[])
returns table (
  id text, display_id text, name text, phone text, created_at timestamptz,
  source text, ad_id text, product text, quantity integer, price integer,
  status text, notes text, invalid_reason text, is_duplicate boolean,
  ip_country text, ip_city text
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if public.nk_current_role() is distinct from 'staff' then
    raise exception '无权限' using errcode = '42501';
  end if;
  if cardinality(p_ids) > 50 then
    raise exception '每次最多读取 50 笔订单' using errcode = '22023';
  end if;

  return query
  select s.id, private.order_display_id(s.order_date, (
      select count(*)
      from public.orders o
      where o.created_at >= (s.order_date::timestamp at time zone 'Asia/Taipei')
        and (o.created_at, o.id) <= (s.created_at, s.id)
    )),
    s.name, s.phone, s.created_at, s.source, s.ad_id, s.product, s.quantity,
    s.price, s.status, s.notes, s.invalid_reason, s.is_duplicate, s.ip_country, s.ip_city
  from private.staff_order_summary s
  where s.assigned_staff_id = auth.uid() and s.id = any(p_ids)
  order by s.created_at desc, s.id;
end;
$$;

create function public.save_order_notes(p_id text, p_notes text, p_expected_notes text)
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
  where o.id = p_id and (actor_role = 'admin' or o.assigned_staff_id = auth.uid())
    and o.notes = p_expected_notes;
  if found then return; end if;

  if exists (
    select 1 from public.orders o
    where o.id = p_id and (actor_role = 'admin' or o.assigned_staff_id = auth.uid())
  ) then
    raise exception '备注已被其他人更新，请重新核对后保存。' using errcode = 'PT409';
  end if;
  raise exception '订单不存在或无权限' using errcode = '42501';
end;
$$;

create function public.save_order_status(p_id text, p_status text, p_reason text default '')
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
  where o.id = p_id and (actor_role = 'admin' or o.assigned_staff_id = auth.uid());
  if not found then
    raise exception '订单不存在或无权限' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.staff_load_orders_v2(integer, integer), public.staff_load_orders_by_ids(text[]),
  public.save_order_notes(text, text, text), public.save_order_status(text, text, text)
from public, anon, authenticated;
grant execute on function public.staff_load_orders_v2(integer, integer), public.staff_load_orders_by_ids(text[]),
  public.save_order_notes(text, text, text), public.save_order_status(text, text, text)
to authenticated;

create policy nk_order_broadcast_read on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and topic = (select realtime.topic())
  and case (select public.nk_current_role())
    when 'admin' then (select realtime.topic()) = 'nk-orders:admin'
    when 'staff' then (select realtime.topic()) = 'nk-orders:staff:' || (select auth.uid())::text
    else false
  end
);

create function private.broadcast_order_change(p_id text, p_type text, p_topic text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('id', p_id, 'type', p_type), 'order_changed', p_topic, true);
exception when others then
  -- A transport failure must never roll back a checkout or a saved edit.
  raise warning 'Could not broadcast an NK order change (%).', sqlstate;
end;
$$;

create function private.broadcast_order_updates()
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

  change_type := case when tg_op = 'DELETE' then 'remove' else lower(tg_op) end;
  order_id := case when tg_op = 'DELETE' then old.id else new.id end;
  perform private.broadcast_order_change(order_id, change_type, 'nk-orders:admin');

  if tg_op <> 'INSERT' and exists (
    select 1 from private.staff_members s where s.user_id = old.assigned_staff_id and s.enabled
  ) then
    if tg_op = 'DELETE' or old.assigned_staff_id is distinct from new.assigned_staff_id then
      perform private.broadcast_order_change(order_id, 'remove', 'nk-orders:staff:' || old.assigned_staff_id::text);
    end if;
  end if;
  if tg_op <> 'DELETE' and exists (
    select 1 from private.staff_members s where s.user_id = new.assigned_staff_id and s.enabled
  ) then
    -- An assignment update refreshes the list without claiming a new checkout.
    perform private.broadcast_order_change(order_id, change_type, 'nk-orders:staff:' || new.assigned_staff_id::text);
  end if;
  return null;
end;
$$;

revoke all on function private.broadcast_order_change(text, text, text), private.broadcast_order_updates()
from public, anon, authenticated;

create trigger broadcast_order_updates
after insert or update or delete on public.orders
for each row execute function private.broadcast_order_updates();

commit;
