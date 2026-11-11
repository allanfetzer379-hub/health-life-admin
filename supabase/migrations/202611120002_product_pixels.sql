begin;

insert into private.settings (key, value)
values ('pixels-lyw', '{"facebook":[],"tiktok":[]}')
on conflict (key) do nothing;

create function private.product_pixel_key(p_product text)
returns text
language plpgsql immutable
set search_path = ''
as $$
begin
  case p_product
    when 'emperor' then return 'pixels';
    when 'lyw' then return 'pixels-lyw';
    else raise exception '商品无效' using errcode = '22023';
  end case;
end;
$$;

create function private.read_product_pixels(p_product text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select value from private.settings where key = private.product_pixel_key(p_product)),
    '{"facebook":[],"tiktok":[]}'::jsonb
  )
$$;

create function public.get_product_pixel_config(p_product text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  with config as (select private.read_product_pixels(p_product) as value)
  select jsonb_build_object(
    'facebook', coalesce((
      select jsonb_agg(pixel order by position)
      from jsonb_array_elements(config.value->'facebook') with ordinality as fb(pixel, position)
      where pixel->'enabled' = 'true'::jsonb
    ), '[]'::jsonb),
    'tiktok', coalesce((
      select jsonb_agg(pixel order by position)
      from jsonb_array_elements(config.value->'tiktok') with ordinality as tk(pixel, position)
      where pixel->'enabled' = 'true'::jsonb
    ), '[]'::jsonb)
  )
  from config
$$;

create function public.admin_product_pixel_config(p_product text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;
  return private.read_product_pixels(p_product);
end;
$$;

create function public.save_product_pixel_config(p_product text, p_value jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  setting_key text;
  other_config jsonb;
  platform text;
  platform_pixels jsonb;
  pixel jsonb;
  id_pattern text;
  normalized jsonb := '{}'::jsonb;
  normalized_pixels jsonb;
begin
  if not public.is_admin() then
    raise exception '无权限' using errcode = '42501';
  end if;
  setting_key := private.product_pixel_key(p_product);

  -- Lock both rows in a consistent order to serialize cross-product ID checks.
  perform 1 from private.settings
  where key in ('pixels', 'pixels-lyw')
  order by key for update;
  other_config := private.read_product_pixels(case p_product when 'emperor' then 'lyw' else 'emperor' end);

  foreach platform in array array['facebook', 'tiktok'] loop
    platform_pixels := p_value->platform;
    if jsonb_typeof(platform_pixels) is distinct from 'array' then
      raise exception '配置格式错误' using errcode = '22023';
    end if;
    if jsonb_array_length(platform_pixels) > 20 then
      raise exception '每个平台最多保存 20 个像素' using errcode = '22023';
    end if;
    id_pattern := case platform when 'facebook' then '^[0-9]+$' else '^[A-Za-z0-9]+$' end;
    normalized_pixels := '[]'::jsonb;
    for pixel in select value from jsonb_array_elements(platform_pixels) loop
      if jsonb_typeof(pixel->'enabled') is distinct from 'boolean'
        or length(pixel->>'id') > 100
        or coalesce(pixel->>'id', '') !~ id_pattern then
        raise exception '像素 ID 格式错误' using errcode = '22023';
      end if;
      normalized_pixels := normalized_pixels || jsonb_build_array(jsonb_build_object(
        'id', pixel->>'id', 'label', left(coalesce(pixel->>'label', ''), 100), 'enabled', pixel->'enabled'
      ));
    end loop;
    if exists (
      select 1 from jsonb_array_elements(normalized_pixels) as candidate
      group by lower(candidate->>'id') having count(*) > 1
    ) then
      raise exception '像素 ID 重复' using errcode = 'PT409';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(normalized_pixels) as candidate
      join jsonb_array_elements(other_config->platform) as other
        on lower(candidate->>'id') = lower(other->>'id')
      where candidate->'enabled' = 'true'::jsonb and other->'enabled' = 'true'::jsonb
    ) then
      raise exception '% 像素已在另一款商品启用，请使用不同的像素 ID。',
        case platform when 'facebook' then 'FB' else 'TikTok' end using errcode = 'PT409';
    end if;
    normalized := jsonb_set(normalized, array[platform], normalized_pixels);
  end loop;

  update private.settings set value = normalized where key = setting_key;
end;
$$;

-- Legacy clients still save Emperor pixels, with the same cross-product guard.
create or replace function public.save_pixel_config(p_value jsonb)
returns void
language sql security definer
set search_path = ''
as $$
  select public.save_product_pixel_config('emperor', p_value)
$$;

revoke all on function private.product_pixel_key(text), private.read_product_pixels(text)
from public, anon, authenticated;
revoke all on function public.get_product_pixel_config(text), public.admin_product_pixel_config(text),
  public.save_product_pixel_config(text, jsonb), public.save_pixel_config(jsonb)
from public, anon, authenticated;
grant execute on function public.get_product_pixel_config(text) to anon, authenticated;
grant execute on function public.admin_product_pixel_config(text), public.save_product_pixel_config(text, jsonb),
  public.save_pixel_config(jsonb) to authenticated;

commit;
