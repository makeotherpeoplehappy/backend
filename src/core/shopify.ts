import type { Deps, Env } from './env';
import { UpstreamError, callUpstream, retryAfterSeconds, sha256Hex } from './http';

export const DEFAULT_ADMIN_API_VERSION = '2026-07';

/**
 * Admin API access token for a Shopify Dev Dashboard app. The app's client ID
 * and secret are exchanged for a token (client credentials grant) that lasts
 * about 24 hours; it is cached in the key-value store and renewed before it
 * runs out, or straight away if Shopify stops accepting it.
 */
async function adminToken(env: Env, deps: Deps, forceNew = false): Promise<string> {
  const cacheKey = `shopify:admin-token:${(await sha256Hex(`${env.SHOPIFY_STORE_DOMAIN}|${env.SHOPIFY_CLIENT_ID}`)).slice(0, 16)}`;
  if (!forceNew) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return cached;
  }
  const res = await callUpstream(deps.fetch, 'shopify', `https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError('shopify', res.status, `Shopify token request failed (${res.status}): ${text.slice(0, 300)}`, retryAfterSeconds(res));
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new UpstreamError('shopify', 502, 'Shopify token response had no access_token');
  // Renew 10 minutes early; KV needs at least 60 seconds.
  const ttl = Math.max(60, (body.expires_in ?? 3600) - 600);
  await env.CACHE.put(cacheKey, body.access_token, { expirationTtl: ttl });
  return body.access_token;
}

export async function adminGraphql<T>(env: Env, deps: Deps, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const version = env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_ADMIN_API_VERSION;
  const call = async (token: string) =>
    callUpstream(
      deps.fetch,
      'shopify',
      `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${version}/graphql.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      },
      20_000,
    );
  let res = await call(await adminToken(env, deps));
  if (res.status === 401) res = await call(await adminToken(env, deps, true));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError('shopify', res.status, `Shopify Admin API failed (${res.status}): ${text.slice(0, 500)}`, retryAfterSeconds(res));
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    throw new UpstreamError('shopify', throttled ? 429 : 502, `Shopify Admin API error: ${body.errors.map((e) => e.message).join('; ')}`, throttled ? 2 : undefined);
  }
  return body.data as T;
}

export function customerGid(id: string | number): string {
  const s = String(id);
  return s.startsWith('gid://') ? s : `gid://shopify/Customer/${s}`;
}
