begin;

create table private.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true
);
alter table private.staff_members enable row level security;
revoke all on private.staff_members from public, anon, authenticated;

alter table public.orders
  add column assigned_staff_id uuid references private.staff_members(user_id) on delete set null;
create index orders_assigned_staff on public.orders (assigned_staff_id, created_at desc, id);

create function public.nk_current_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when public.is_admin() then 'admin'
    when exists (
      select 1 from private.staff_members
      where user_id = auth.uid() and enabled
    ) then 'staff'
  end
$$;

create function private.assign_new_order_to_single_staff()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  staff_ids uuid[];
begin
  if new.assigned_staff_id is null then
    select array_agg(user_id) into staff_ids
    from (select user_id from private.staff_members where enabled limit 2) as active_staff;
    if cardinality(staff_ids) = 1 then
      new.assigned_staff_id := staff_ids[1];
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.assign_new_order_to_single_staff() from public, anon, authenticated;
create trigger assign_new_order_to_single_staff
before insert on public.orders
for each row execute function private.assign_new_order_to_single_staff();

create function public.staff_load_orders(p_limit integer, p_offset integer)
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
  where o.assigned_staff_id = auth.uid()
  order by o.created_at desc, o.id
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

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
  where o.id = p_id and (actor_role = 'admin' or o.assigned_staff_id = auth.uid());

  if not found then
    raise exception '订单不存在或无权限';
  end if;
end;
$$;

create function public.admin_list_staff()
returns table (id uuid, email text, enabled boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;

  return query
  select s.user_id, u.email::text, s.enabled
  from private.staff_members s
  join auth.users u on u.id = s.user_id
  order by u.email, s.user_id;
end;
$$;

create function public.admin_set_staff_enabled(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;
  if p_enabled is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id and not exists (
      select 1 from private.admin_members a where lower(a.email) = lower(u.email)
    )
  ) then
    raise exception '员工账号无效';
  end if;

  insert into private.staff_members (user_id, enabled)
  values (p_user_id, p_enabled)
  on conflict (user_id) do update set enabled = excluded.enabled;
end;
$$;

create function public.admin_assign_order(p_id text, p_staff_id uuid)
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
  where o.id = p_id;

  if not found then
    raise exception '订单不存在';
  end if;
end;
$$;

revoke all on function
  public.nk_current_role(),
  public.staff_load_orders(integer, integer),
  public.update_order(text, text, text, text),
  public.admin_list_staff(),
  public.admin_set_staff_enabled(uuid, boolean),
  public.admin_assign_order(text, uuid)
from public, anon, authenticated;

grant execute on function
  public.nk_current_role(),
  public.staff_load_orders(integer, integer),
  public.update_order(text, text, text, text),
  public.admin_list_staff(),
  public.admin_set_staff_enabled(uuid, boolean),
  public.admin_assign_order(text, uuid)
to authenticated;

commit;
