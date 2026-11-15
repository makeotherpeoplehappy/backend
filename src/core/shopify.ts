import type { Deps, Env } from './env';
import { UpstreamError, callUpstream, retryAfterSeconds } from './http';

export const DEFAULT_ADMIN_API_VERSION = '2026-07';

export async function adminGraphql<T>(env: Env, deps: Deps, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const version = env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_ADMIN_API_VERSION;
  const res = await callUpstream(
    deps.fetch,
    'shopify',
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${version}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
    20_000,
  );
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
