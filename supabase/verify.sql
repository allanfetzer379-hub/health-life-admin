begin;
do $$
declare a jsonb; b jsonb; c jsonb; d jsonb; token uuid:=gen_random_uuid(); n text:='数据库验收-'||gen_random_uuid();
begin
 a:=public.submit_order(jsonb_build_object('request_id',token,'name',n,'phone','0900000011'),'192.0.2.211','transaction test');
 if a<>public.submit_order(jsonb_build_object('request_id',token,'name',n,'phone','0900000011'),'192.0.2.211','transaction test') then raise exception 'retry is not idempotent';end if;
 b:=public.submit_order(jsonb_build_object('request_id',gen_random_uuid(),'name',n,'phone','0900000012'),'192.0.2.211','transaction test');
 c:=public.submit_order(jsonb_build_object('request_id',gen_random_uuid(),'name',n||'另一人','phone','0900000011'),'192.0.2.211','transaction test');
 d:=public.submit_order(jsonb_build_object('request_id',gen_random_uuid(),'name',n,'phone','0900000011'),'192.0.2.211','transaction test');
 if not exists(select 1 from public.orders o,jsonb_array_elements(o.matches) m where o.id=b->>'id' and m->>'id'=a->>'id' and m->>'reason'='姓名') then raise exception 'name matching failed';end if;
 if not exists(select 1 from public.orders o,jsonb_array_elements(o.matches) m where o.id=c->>'id' and m->>'id'=a->>'id' and m->>'reason'='电话') then raise exception 'phone matching failed';end if;
 if not exists(select 1 from public.orders o,jsonb_array_elements(o.matches) m where o.id=d->>'id' and m->>'id'=a->>'id' and m->>'reason'='姓名及电话') then raise exception 'combined matching failed';end if;
 if has_table_privilege('anon','public.orders','SELECT') or has_table_privilege('anon','public.orders','INSERT') or has_function_privilege('anon','public.submit_order(jsonb,text,text)','EXECUTE') then raise exception 'anonymous order permissions are too broad';end if;
end $$;
select 'PASS: name OR phone, combined matches, idempotency, anonymous permissions. Test writes are rolled back.' as verification;
rollback;
