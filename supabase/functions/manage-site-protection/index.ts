const allowedOrigins = new Set([
  'https://vortexes.top',
  'https://www.vortexes.top',
  'https://allanfetzer379-hub.github.io',
]);
const maxAddresses = 30;
const ruleRef = 'nk_landing_protection';
const ruleDescription = 'NK landing protection (managed by NK admin)';
const customPhase = 'http_request_firewall_custom';
const hostFilter = 'http.host in {"ateliser.top" "www.ateliser.top"}';
const phoneFilter = '(http.user_agent contains "iPhone" or (http.user_agent contains "Android" and http.user_agent contains "Mobile"))';
const botFilter = 'cf.verified_bot_category in {"AI Crawler" "AI Assistant"}';

type Protection = { enabled: boolean; whitelist: string[] };
type CloudflareRule = { id: string; ref?: string; action: string; enabled: boolean; expression: string };
type CloudflareRuleset = { id: string; rules?: CloudflareRule[] };

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return address.split('.').every(part => Number(part) <= 255) ? address : null;
  }
  if (!address.includes(':') || !/^[0-9a-f:.]{2,45}$/i.test(address)) return null;
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function normalizeWhitelist(values: unknown[]): string[] {
  if (values.length > maxAddresses) {
    throw new RequestError(400, `白名单最多支持 ${maxAddresses} 个 IP 地址。`);
  }
  const addresses = values.map(normalizeAddress);
  if (addresses.some(address => address === null)) {
    throw new RequestError(400, '请输入有效的 IPv4 或 IPv6 地址，每项填写一个完整 IP。');
  }
  return [...new Set(addresses as string[])];
}

function expressionFor(whitelist: string[]): string {
  const checks = [hostFilter];
  if (whitelist.length) checks.push(`not ip.src in {${whitelist.join(' ')}}`);
  checks.push(`(ip.src.country ne "TW" or not ${phoneFilter} or ${botFilter})`);
  return `(${checks.join(' and ')})`;
}

function managedRule(ruleset: CloudflareRuleset | null): CloudflareRule | null {
  const matches = (ruleset?.rules ?? []).filter(rule => rule.ref === ruleRef);
  if (matches.length > 1) throw new RequestError(409, 'Cloudflare 存在多条 NK 防护规则，请先检查规则列表。');
  return matches[0] ?? null;
}

function protectionFrom(rule: CloudflareRule | null): Protection {
  if (!rule) return { enabled: false, whitelist: [] };
  try {
    const whitelistClause = /\s+and\s+not\s+ip\.src\s+in\s+\{([^{}]+)\}/;
    const entries = rule.expression.match(whitelistClause)?.[1];
    const whitelist = entries ? normalizeWhitelist(entries.trim().split(/\s+/)) : [];
    const base = rule.expression.replace(whitelistClause, '').trim().replace(/\s+/g, ' ');
    if (rule.action !== 'block' || typeof rule.enabled !== 'boolean' ||
        base !== expressionFor([])) {
      throw new Error('Unexpected managed rule');
    }
    return { enabled: rule.enabled, whitelist };
  } catch {
    throw new RequestError(409, 'Cloudflare 的 NK 防护规则已在后台外修改，请核对规则后再继续。');
  }
}

function sameProtection(left: Protection, right: Protection): boolean {
  return left.enabled === right.enabled && left.whitelist.length === right.whitelist.length &&
    left.whitelist.every(address => right.whitelist.includes(address));
}

async function requireAdmin(authorization: string | null) {
  if (!authorization || !/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/i.test(authorization)) {
    throw new RequestError(401, '请登录后台后再操作。');
  }
  const url = Deno.env.get('SUPABASE_URL');
  const apikey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !apikey) throw new RequestError(503, '管理员身份验证暂不可用。');

  const headers = { apikey, authorization };
  const user = await fetch(`${url}/auth/v1/user`, { headers, signal: AbortSignal.timeout(7000) });
  if (user.status === 401 || user.status === 403) throw new RequestError(401, '登录已过期，请重新登录。');
  if (!user.ok) throw new RequestError(502, '暂时无法验证登录身份，请稍后重试。');

  const admin = await fetch(`${url}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(7000),
  });
  if (admin.status === 401) throw new RequestError(401, '登录已过期，请重新登录。');
  if (admin.status === 403) throw new RequestError(403, '此账号没有管理落地页防护的权限。');
  if (!admin.ok) throw new RequestError(502, '暂时无法验证管理权限，请稍后重试。');
  if (await admin.json() !== true) throw new RequestError(403, '此账号没有管理落地页防护的权限。');
}

function cloudflareClient() {
  const zoneId = Deno.env.get('NK_CLOUDFLARE_ZONE_ID');
  const token = Deno.env.get('NK_CLOUDFLARE_WAF_TOKEN');
  if (!zoneId || !/^[a-f0-9]{32}$/i.test(zoneId) || !token) {
    throw new RequestError(503, '落地页防护尚未连接 Cloudflare。');
  }
  const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets`;
  const entrypoint = `/phases/${customPhase}/entrypoint`;

  return async (path = entrypoint, method = 'GET', body?: unknown): Promise<CloudflareRuleset | null> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    if (method === 'GET' && response.status === 404) return null;
    const envelope = await response.json();
    if (!response.ok || envelope.success !== true || !/^[a-f0-9]{32}$/i.test(envelope.result?.id ?? '')) {
      const codes = Array.isArray(envelope.errors) ? envelope.errors.map((error: { code: number }) => error.code) : [];
      console.warn('Cloudflare rulesets request failed', method, response.status, codes);
      throw new RequestError(502, 'Cloudflare 未能完成防护操作，请稍后重试。');
    }
    return envelope.result as CloudflareRuleset;
  };
}

async function readProtection(request: Request): Promise<Protection> {
  const text = await request.text();
  if (text.length > 4096) throw new RequestError(413, '白名单内容过长。');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError(400, '防护设置格式无效。');
  }
  if (typeof value?.enabled !== 'boolean' || !Array.isArray(value.whitelist)) {
    throw new RequestError(400, '防护设置格式无效。');
  }
  return { enabled: value.enabled, whitelist: normalizeWhitelist(value.whitelist) };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin');
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (origin && !allowedOrigins.has(origin)) return reply({ message: '此来源无权访问后台设置。' }, 403);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
  headers.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET' && request.method !== 'PUT') return reply({ message: '请求方式无效。' }, 405);

  try {
    await requireAdmin(request.headers.get('authorization'));
    const next = request.method === 'PUT' ? await readProtection(request) : null;
    const cloudflare = cloudflareClient();
    const entry = await cloudflare();
    const rule = managedRule(entry);
    const current = protectionFrom(rule);
    if (!next) return reply(current);

    const expression = expressionFor(next.whitelist);
    if (sameProtection(current, next)) return reply(current);

    const definition = {
      ref: ruleRef,
      description: ruleDescription,
      expression,
      action: 'block',
      enabled: next.enabled,
    };
    let updated;
    if (!entry) {
      updated = await cloudflare('', 'POST', {
        name: 'NK zone custom rules',
        kind: 'zone',
        phase: customPhase,
        rules: [definition],
      });
    } else if (!rule) {
      updated = await cloudflare(`/${entry.id}/rules`, 'POST', definition);
    } else {
      if (!/^[a-f0-9]{32}$/i.test(rule.id)) throw new RequestError(502, '无法核对 Cloudflare 规则 ID。');
      updated = await cloudflare(`/${entry.id}/rules/${rule.id}`, 'PATCH', definition);
    }
    const saved = managedRule(updated);
    const effective = protectionFrom(saved);
    if (!saved || !sameProtection(effective, next)) {
      throw new RequestError(502, 'Cloudflare 尚未确认防护设置，请刷新后核对。');
    }
    return reply(effective);
  } catch (error) {
    if (error instanceof RequestError) return reply({ message: error.message }, error.status);
    console.warn('NK protection request failed', error instanceof Error ? error.name : 'unknown');
    return reply({ message: '暂时无法连接防护服务，请稍后重试。' }, 502);
  }
});
