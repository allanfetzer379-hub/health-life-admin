begin;
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create table if not exists private.admin_members(email text primary key);
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.admin_members where lower(email)=lower(auth.jwt()->>'email')) and auth.uid() is not null
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
create table if not exists public.orders(
 id text primary key default ('NK-'||gen_random_uuid()::text), request_id uuid not null unique,
 created_at timestamptz not null default now(),name text not null check(length(name) between 1 and 80),
 name_key text not null,phone text not null check(phone ~ '^09[0-9]{8}$'),
 product text not null default '龙阳丸',quantity integer not null default 1,price integer not null default 1389,
 source text not null default '直接访问',ad_id text not null default '',ip inet,device text not null default '',
 source_url text not null default '',attribution jsonb not null default '{}',
 status text not null default 'new' check(status in ('new','contacted','confirmed','shipped','completed','cancelled','invalid')),
 notes text not null default '',invalid_reason text not null default '',matches jsonb not null default '[]',logs jsonb not null default '[]'
);
create index if not exists orders_name_key on public.orders(name_key);
create index if not exists orders_phone on public.orders(phone);
create index if not exists orders_created on public.orders(created_at desc);
create index if not exists orders_ip_time on public.orders(ip,created_at desc);
create index if not exists orders_ad on public.orders(ad_id);
alter table public.orders enable row level security;
revoke all on public.orders from anon,authenticated;
grant select on public.orders to authenticated;
drop policy if exists admin_read on public.orders;
create policy admin_read on public.orders for select to authenticated using(public.is_admin());
create table if not exists private.settings(key text primary key,value jsonb not null);
insert into private.settings values('pixels','{"facebook":[],"tiktok":[]}') on conflict do nothing;
create or replace function public.get_pixel_config() returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object('facebook',coalesce((select jsonb_agg(p) from jsonb_array_elements(value->'facebook') p where p->>'enabled'='true'),'[]'),'tiktok',coalesce((select jsonb_agg(p) from jsonb_array_elements(value->'tiktok') p where p->>'enabled'='true'),'[]')) from private.settings where key='pixels'
$$;
revoke all on function public.get_pixel_config() from public;
grant execute on function public.get_pixel_config() to anon,authenticated;
create or replace function public.admin_pixel_config() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
if not public.is_admin() then raise exception '无权限';end if;
return (select value from private.settings where key='pixels');end$$;
create or replace function public.save_pixel_config(p_value jsonb) returns void language plpgsql security definer set search_path='' as $$declare p jsonb; platform text;begin
if not public.is_admin() then raise exception '无权限';end if;
foreach platform in array array['facebook','tiktok'] loop
if jsonb_typeof(p_value->platform) is distinct from 'array' or jsonb_array_length(p_value->platform)>20 then raise exception '配置格式错误';end if;
for p in select * from jsonb_array_elements(p_value->platform) loop
if jsonb_typeof(p->'enabled') is distinct from 'boolean' or length(p->>'id')>100 or coalesce(p->>'id','') !~ (case when platform='facebook' then '^[0-9]+$' else '^[A-Za-z0-9]+$' end) then raise exception '像素 ID 格式错误';end if;
end loop;
if (select count(*)<>count(distinct v->>'id') from jsonb_array_elements(p_value->platform) v) then raise exception '像素 ID 重复';end if;
end loop;
update private.settings set value=p_value where key='pixels';end$$;
create or replace function public.update_order(p_id text,p_status text,p_notes text,p_reason text default '') returns void language plpgsql security definer set search_path='' as $$begin
if not public.is_admin() then raise exception '无权限';end if;
if p_status not in ('new','contacted','confirmed','shipped','completed','cancelled','invalid') or length(p_notes)>2000 or length(p_reason)>100 then raise exception '输入无效';end if;
if p_status='invalid' and coalesce(trim(p_reason),'')='' then raise exception '请选择无效原因';end if;
update public.orders set status=p_status,notes=p_notes,invalid_reason=case when p_status='invalid' then p_reason else '' end,
logs=logs||jsonb_build_array(jsonb_build_object('at',now(),'text','更新状态：'||p_status||case when p_reason<>'' then '；原因：'||p_reason else '' end,'actor',auth.uid())) where id=p_id;
if not found then raise exception '订单不存在';end if;end$$;
revoke all on function public.admin_pixel_config(),public.save_pixel_config(jsonb),public.update_order(text,text,text,text) from public;
grant execute on function public.admin_pixel_config(),public.save_pixel_config(jsonb),public.update_order(text,text,text,text) to authenticated;
create or replace function public.submit_order(p jsonb,p_ip text,p_device text) returns jsonb language plpgsql security definer set search_path='' as $$
declare phone_norm text;name_norm text;oid text;prior jsonb;client_ip inet;request uuid;
begin
request:=(p->>'request_id')::uuid;
perform pg_advisory_xact_lock(71310801);
select id into oid from public.orders where request_id=request;
if oid is not null then return jsonb_build_object('ok',true,'id',oid);end if;
phone_norm:=regexp_replace(normalize(p->>'phone',NFKC),'[^0-9]','','g');
if phone_norm like '886%' then phone_norm:='0'||substr(phone_norm,4);end if;
name_norm:=lower(regexp_replace(normalize(p->>'name',NFKC),'[[:space:]]','','g'));
if name_norm is null or name_norm='' or length(p->>'name')>80 or phone_norm !~ '^09[0-9]{8}$' then raise exception '输入无效';end if;
begin client_ip:=nullif(p_ip,'')::inet;exception when others then client_ip:=null;end;
if client_ip is null then raise exception '无法确认请求来源';end if;
if (select count(*) from public.orders where ip=client_ip and created_at>now()-interval '10 minutes')>=10 then raise exception '提交频繁，请稍后再试';end if;
select coalesce(jsonb_agg(jsonb_build_object('id',id,'reason',case when name_key=name_norm and phone=phone_norm then '姓名及电话' when name_key=name_norm then '姓名' else '电话' end) order by created_at),'[]') into prior from public.orders where name_key=name_norm or phone=phone_norm;
insert into public.orders(request_id,name,name_key,phone,source,ad_id,ip,device,source_url,attribution,matches)
values(request,p->>'name',name_norm,phone_norm,left(coalesce(p->>'source','直接访问'),100),left(coalesce(p->>'ad_id',''),150),client_ip,left(coalesce(p_device,''),600),left(coalesce(p->>'source_url',''),2000),coalesce(p->'attribution','{}'),prior) returning id into oid;
return jsonb_build_object('ok',true,'id',oid);end$$;
revoke all on function public.submit_order(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.submit_order(jsonb,text,text) to service_role;
commit;
