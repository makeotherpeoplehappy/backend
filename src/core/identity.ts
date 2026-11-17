import type { Deps, Env } from './env';
import { HttpError, UpstreamError, bearer, callUpstream, iso, sha256Hex } from './http';
import { MEMBERSTACK_APP_ID } from './config';
import { linkGuestPledges } from './features/pledges';

/** A signed-in Memberstack member, as verified with Memberstack. */
export interface Account {
  /** Memberstack member ID, mem_... */
  id: string;
  firstName: string | null;
  /** Only set once Memberstack has verified the address. */
  email: string | null;
}

export interface Member {
  id: number;
  /** mem_... (Memberstack), or an old Shopify customer GID until that member signs in again. */
  account_id: string;
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
// not ask Memberstack each time. KV's shortest expiry is 60 seconds.
const TOKEN_CACHE_SECONDS = 60;
const MEMBERSTACK = 'https://admin.memberstack.com';

interface MemberstackMember {
  id: string;
  verified?: boolean;
  auth?: { email?: string | null };
  customFields?: Record<string, string | null | undefined>;
}

/** Reads one member from Memberstack's Admin API (null when there is none). */
export async function memberstackMember(env: Env, deps: Deps, id: string): Promise<Account | null> {
  if (!env.MEMBERSTACK_SECRET_KEY) throw new UpstreamError('memberstack', 503, 'MEMBERSTACK_SECRET_KEY is not set');
  const res = await callUpstream(deps.fetch, 'memberstack', `${MEMBERSTACK}/members/${encodeURIComponent(id)}`, {
    headers: { 'X-API-KEY': env.MEMBERSTACK_SECRET_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new UpstreamError('memberstack', res.status, `Memberstack member lookup answered ${res.status}`);
  const m = ((await res.json()) as { data: MemberstackMember | null }).data;
  if (!m?.id) return null;
  const email = m.auth?.email?.trim().toLowerCase() || null;
  const first = m.customFields?.['first-name'] || m.customFields?.firstName || null;
  return { id: m.id, firstName: first ? String(first).trim().slice(0, 40) || null : null, email: m.verified ? email : null };
}

/**
 * Asks Memberstack who owns this member token. Returns null when Memberstack
 * says the token is not valid, or when it was issued for another Memberstack
 * app (every app's tokens share one signing key). Throws UpstreamError when
 * Memberstack cannot be reached, so an outage is never mistaken for "signed out".
 */
export async function verifyMemberToken(env: Env, deps: Deps, token: string): Promise<Account | null> {
  if (!token || token.length > 4096) return null;
  const cacheKey = `tok:${await sha256Hex(token)}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) return cached as Account;
  if (!env.MEMBERSTACK_SECRET_KEY) throw new UpstreamError('memberstack', 503, 'MEMBERSTACK_SECRET_KEY is not set');
  const res = await callUpstream(deps.fetch, 'memberstack', `${MEMBERSTACK}/members/verify-token`, {
    method: 'POST',
    headers: { 'X-API-KEY': env.MEMBERSTACK_SECRET_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    // A bad member token is "signed out"; a bad secret key is a setup problem.
    if (/invalid.?token/i.test(body.code || '') || !body.code) return null;
    throw new UpstreamError('memberstack', 400, `Memberstack token check failed: ${body.code}`);
  }
  if (!res.ok) throw new UpstreamError('memberstack', res.status, `Memberstack token check answered ${res.status}`);
  const t = ((await res.json()) as { data?: { id?: string; type?: string; aud?: string } }).data;
  if (!t?.id || (t.type && t.type !== 'member') || t.aud !== MEMBERSTACK_APP_ID) return null;
  const account = await memberstackMember(env, deps, t.id);
  if (!account) return null;
  await env.CACHE.put(cacheKey, JSON.stringify(account), { expirationTtl: TOKEN_CACHE_SECONDS });
  return account;
}

/**
 * Creates or refreshes the member row for a Memberstack account. A member from
 * before the move to Memberstack (an old Shopify account) is taken over the
 * first time someone signs in with the same verified email, so their history
 * carries over.
 */
export async function upsertMember(env: Env, deps: Deps, account: Account): Promise<Member> {
  const now = iso(deps.now());
  let row = await env.DB.prepare(`SELECT * FROM members WHERE account_id = ?1`).bind(account.id).first<Member>();
  if (!row && account.email) {
    row = await env.DB.prepare(
      `UPDATE members SET account_id = ?1, updated_at = ?3
       WHERE id = (SELECT id FROM members WHERE email = ?2 AND deleted_at IS NULL AND account_id NOT LIKE 'mem\\_%' ESCAPE '\\' AND account_id NOT LIKE 'deleted:%' ORDER BY id LIMIT 1)
       RETURNING *`,
    )
      .bind(account.id, account.email, now)
      .first<Member>();
  }
  if (row) {
    const first = account.firstName ?? row.first_name;
    const email = account.email ?? row.email;
    if (first !== row.first_name || email !== row.email) {
      row = (await env.DB.prepare(`UPDATE members SET first_name = ?2, email = ?3, updated_at = ?4 WHERE id = ?1 RETURNING *`)
        .bind(row.id, first, email, now)
        .first<Member>())!;
    }
  } else {
    row = await env.DB.prepare(
      `INSERT INTO members (account_id, first_name, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (account_id) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING *`,
    )
      .bind(account.id, account.firstName, account.email, now)
      .first<Member>();
  }
  if (!row) throw new Error('member upsert returned nothing');
  // Shop orders placed with this email join the member once it is verified.
  if (row.email) await linkGuestPledges(env, row);
  return row;
}

/** Returns the signed-in member, or null when no valid token was sent. */
export async function optionalMember(req: Request, env: Env, deps: Deps): Promise<Member | null> {
  const token = bearer(req);
  if (!token) return null;
  const account = await verifyMemberToken(env, deps, token);
  if (!account) return null;
  return upsertMember(env, deps, account);
}

export async function requireMember(req: Request, env: Env, deps: Deps): Promise<Member> {
  const token = bearer(req);
  if (!token) throw signInRequired();
  const account = await verifyMemberToken(env, deps, token);
  if (!account) throw signInRequired();
  return upsertMember(env, deps, account);
}

function signInRequired(): HttpError {
  return new HttpError(401, 'signin_required', 'err-signin-required');
}
