begin;

create function public.admin_delete_orders(p_ids text[])
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  order_id text;
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;

  if coalesce(cardinality(p_ids), 0) = 0 or exists (
    select 1 from unnest(p_ids) as requested(id)
    where requested.id is null or requested.id = ''
  ) then
    raise exception '请选择有效的订单' using errcode = '22023';
  end if;

  -- Lock orders in a consistent order across overlapping batches.
  for order_id in
    select distinct requested.id
    from unnest(p_ids) as requested(id)
    order by requested.id
  loop
    perform public.set_order_deleted(order_id, true);
  end loop;
end;
$$;

revoke all on function public.admin_delete_orders(text[]) from public, anon, authenticated;
grant execute on function public.admin_delete_orders(text[]) to authenticated;

notify pgrst, 'reload schema';

commit;
