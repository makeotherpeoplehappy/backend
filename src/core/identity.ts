import type { Deps, Env } from './env';
import { HttpError, UpstreamError, bearer, callUpstream, iso, sha256Hex } from './http';
import { linkGuestPledges } from './features/pledges';

export interface Customer {
  /** gid://shopify/Customer/123 */
  id: string;
  firstName: string | null;
  email: string | null;
}

export interface Member {
  id: number;
  shopify_customer_id: string;
  first_name: string | null;
  email: string | null;
  notify_invite_summary: number;
  notify_story_approved: number;
  notify_suggestion_live: number;
  notify_pledge_reminder: number;
  created_at: string;
  share_name?: string | null;
  inviter_id?: number | null;
  inviter_joined_at?: string | null;
  deleted_at?: string | null;
}

// Verified tokens are remembered briefly so a page making several calls does
// not ask Shopify each time. KV's shortest expiry is 60 seconds.
const TOKEN_CACHE_SECONDS = 60;

const CUSTOMER_QUERY = 'query { customer { id firstName emailAddress { emailAddress } } }';

async function customerApiUrl(env: Env, deps: Deps): Promise<string> {
  const cacheKey = `cfg:customer-api:${env.SHOPIFY_STORE_DOMAIN}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;
  const res = await callUpstream(
    deps.fetch,
    'shopify',
    `https://${env.SHOPIFY_STORE_DOMAIN}/.well-known/customer-account-api`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new UpstreamError('shopify', res.status, `Customer Account API discovery failed: ${res.status}`);
  const body = (await res.json()) as { graphql_api?: string };
  if (!body.graphql_api) throw new UpstreamError('shopify', 502, 'Customer Account API discovery returned no graphql_api');
  await env.CACHE.put(cacheKey, body.graphql_api, { expirationTtl: 86_400 });
  return body.graphql_api;
}

/**
 * Asks Shopify who owns this customer token. Returns null when Shopify says
 * the token is not valid (forged, expired or revoked). Throws UpstreamError
 * when Shopify cannot be reached, so a Shopify outage is never mistaken for
 * "signed out".
 */
export async function verifyCustomerToken(env: Env, deps: Deps, token: string): Promise<Customer | null> {
  if (!token || token.length > 4096) return null;
  const cacheKey = `tok:${await sha256Hex(token)}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached as Customer;

  const url = await customerApiUrl(env, deps);
  const res = await callUpstream(deps.fetch, 'shopify', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: token },
    body: JSON.stringify({ query: CUSTOMER_QUERY }),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new UpstreamError('shopify', res.status, `Customer Account API answered ${res.status}`);
  const body = (await res.json()) as {
    data?: { customer?: { id: string; firstName?: string | null; emailAddress?: { emailAddress?: string | null } | null } | null };
    errors?: { message?: string; extensions?: { code?: string } }[];
  };
  const customer = body.data?.customer;
  if (!customer?.id) {
    const unauthorised = body.errors?.some((e) => /UNAUTHORI[SZ]ED|ACCESS_DENIED/i.test(e.extensions?.code || '') || /unauthori/i.test(e.message || ''));
    if (unauthorised || !body.errors) return null;
    throw new UpstreamError('shopify', 502, `Customer Account API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const result: Customer = {
    id: customer.id,
    firstName: customer.firstName?.trim() || null,
    email: customer.emailAddress?.emailAddress?.trim().toLowerCase() || null,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: TOKEN_CACHE_SECONDS });
  return result;
}

/** Creates or refreshes the member row from verified Shopify data. */
export async function upsertMember(env: Env, deps: Deps, customer: Customer): Promise<Member> {
  const now = iso(deps.now());
  const row = await env.DB.prepare(
    `INSERT INTO members (shopify_customer_id, first_name, email, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (shopify_customer_id) DO UPDATE SET
       first_name = excluded.first_name,
       email = excluded.email,
       updated_at = CASE WHEN members.first_name IS excluded.first_name AND members.email IS excluded.email
                         THEN members.updated_at ELSE excluded.updated_at END
     RETURNING *`,
  )
    .bind(customer.id, customer.firstName, customer.email, now)
    .first<Member>();
  if (!row) throw new Error('member upsert returned nothing');
  // Orders placed without an account join the member when that email signs in.
  if (row.email) await linkGuestPledges(env, row);
  return row;
}

/** Returns the signed-in member, or null when no valid token was sent. */
export async function optionalMember(req: Request, env: Env, deps: Deps): Promise<Member | null> {
  const token = bearer(req);
  if (!token) return null;
  const customer = await verifyCustomerToken(env, deps, token);
  if (!customer) return null;
  return upsertMember(env, deps, customer);
}

export async function requireMember(req: Request, env: Env, deps: Deps): Promise<Member> {
  const token = bearer(req);
  if (!token) throw signInRequired();
  const customer = await verifyCustomerToken(env, deps, token);
  if (!customer) throw signInRequired();
  return upsertMember(env, deps, customer);
}

function signInRequired(): HttpError {
  return new HttpError(401, 'signin_required', 'err-signin-required');
}
