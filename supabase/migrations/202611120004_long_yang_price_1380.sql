begin;

create or replace function public.submit_order(p jsonb, p_ip text, p_device text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  phone_norm text;
  name_norm text;
  oid text;
  prior jsonb;
  client_ip inet;
  request uuid;
  sku text := coalesce(p->>'sku', '');
  order_product text;
  order_price integer;
begin
  request := (p->>'request_id')::uuid;
  perform pg_advisory_xact_lock(71310801);

  select id into oid from public.orders where request_id = request;
  if oid is not null then
    return jsonb_build_object('ok', true, 'id', oid);
  end if;

  -- Accept the offer identifier, while choosing the product and price on the server.
  case sku
    when 'nk-emperor-deer' then
      order_product := '帝皇鹿精丸';
      order_price := 1380;
    when 'nk-long-yang-wan' then
      order_product := '龙阳丸';
      order_price := 1380;
    when '' then
      order_product := '龙阳丸';
      order_price := 1389;
    else
      raise exception '商品无效';
  end case;

  phone_norm := regexp_replace(normalize(p->>'phone', NFKC), '[^0-9]', '', 'g');
  if phone_norm like '886%' then
    phone_norm := '0' || substr(phone_norm, 4);
  end if;
  name_norm := lower(regexp_replace(normalize(p->>'name', NFKC), '[[:space:]]', '', 'g'));
  if name_norm is null or name_norm = '' or length(p->>'name') > 80 or phone_norm !~ '^09[0-9]{8}$' then
    raise exception '输入无效';
  end if;

  begin
    client_ip := nullif(p_ip, '')::inet;
  exception when others then
    client_ip := null;
  end;
  if client_ip is null then
    raise exception '无法确认请求来源';
  end if;
  if (select count(*) from public.orders where ip = client_ip and created_at > now() - interval '10 minutes') >= 10 then
    raise exception '提交频繁，请稍后再试';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'reason', case
      when name_key = name_norm and phone = phone_norm then '姓名及电话'
      when name_key = name_norm then '姓名'
      else '电话'
    end
  ) order by created_at), '[]') into prior
  from public.orders
  where name_key = name_norm or phone = phone_norm;

  insert into public.orders (
    request_id, name, name_key, phone, product, price, source, ad_id,
    ip, device, source_url, attribution, matches
  ) values (
    request, p->>'name', name_norm, phone_norm, order_product, order_price,
    left(coalesce(p->>'source', '直接访问'), 100), left(coalesce(p->>'ad_id', ''), 150),
    client_ip, left(coalesce(p_device, ''), 600), left(coalesce(p->>'source_url', ''), 2000),
    coalesce(p->'attribution', '{}'), prior
  ) returning id into oid;

  return jsonb_build_object('ok', true, 'id', oid);
end;
$$;

revoke all on function public.submit_order(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.submit_order(jsonb, text, text) to service_role;

commit;
