begin;

create function public.staff_load_deleted_orders(p_limit integer, p_offset integer)
returns table (
  id text, display_id text, created_at timestamptz, deleted_at timestamptz,
  product text, quantity integer, price integer, status text
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if public.nk_current_role() is distinct from 'staff' then
    raise exception '无权限' using errcode = '42501';
  end if;

  return query
  with page as (
    select o.id, o.created_at, o.deleted_at, o.product, o.quantity, o.price, o.status,
      (o.created_at at time zone 'Asia/Taipei')::date as order_date
    from public.orders o
    where o.assigned_staff_id = auth.uid() and o.deleted_at is not null
    order by o.deleted_at desc, o.id
    limit least(greatest(coalesce(p_limit, 500), 1), 500)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select p.id, private.order_display_id(p.order_date, (
      select count(*)
      from public.orders o
      where o.created_at >= (p.order_date::timestamp at time zone 'Asia/Taipei')
        and (o.created_at, o.id) <= (p.created_at, p.id)
    )), p.created_at, p.deleted_at, p.product, p.quantity, p.price, p.status
  from page p
  order by p.deleted_at desc, p.id;
end;
$$;

revoke all on function public.staff_load_deleted_orders(integer, integer) from public, anon, authenticated;
grant execute on function public.staff_load_deleted_orders(integer, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
