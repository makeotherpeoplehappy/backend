// Try before sign-up: a visitor without an account can mark "I did this".
//
// The browser makes a random guest key and keeps it (localStorage and a
// cookie). The server stores only a hash of it, as a member row with the
// account ID "guest:<hash>". So a guest's done marks are ordinary done marks:
// public counts, the ripple and undo all work unchanged. On sign-in the
// guest's marks move to the member, and the guest row is closed.
//
// Unclaimed guests expire after 30 days without activity: the key stops
// working ("expired:<id>"), and the marks stay in the public totals.

import type { Deps, Env } from '../env';
import { HttpError, iso, sha256Hex, utcDay } from '../http';
import { requireMember, type Member } from '../identity';
import { recomputeKeeps } from './pledges';

export const GUEST_HEADER = 'X-HF-Guest';
export const GUEST_DAYS = 30;
/** New guests per network per day: enough for a shared office or school, not for a script. */
export const GUEST_NEW_PER_IP = 30;

const KEY = /^[A-Za-z0-9-]{20,64}$/;
const DAY = 24 * 60 * 60 * 1000;

export const isGuest = (m: Pick<Member, 'account_id'>) => m.account_id.startsWith('guest:');

/** SQL condition for rows that are real accounts (not guests, not closed guests). */
export const REAL_MEMBER = `account_id NOT LIKE 'guest:%' AND account_id NOT LIKE 'expired:%' AND account_id NOT LIKE 'merged:%'`;

function guestKey(req: Request): string | null {
  const k = req.headers.get(GUEST_HEADER);
  return k && KEY.test(k) ? k : null;
}

/**
 * The guest for this request's key, or null. With `create`, a first "I did this"
 * makes the guest (within the per-network limit).
 */
export async function guestFromRequest(req: Request, env: Env, deps: Deps, create: boolean): Promise<Member | null> {
  const key = guestKey(req);
  if (!key) return null;
  const accountId = `guest:${await sha256Hex(key)}`;
  const row = await env.DB.prepare(`SELECT * FROM members WHERE account_id = ?1`).bind(accountId).first<Member>();
  if (row || !create) return row;
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const limitKey = `guestnew:${utcDay(deps.now())}:${(await sha256Hex(ip)).slice(0, 16)}`;
  const made = Number((await env.CACHE.get(limitKey)) || 0);
  if (made >= GUEST_NEW_PER_IP) throw new HttpError(429, 'guest_limit', 'err-guest-limit');
  await env.CACHE.put(limitKey, String(made + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  const now = iso(deps.now());
  return env.DB.prepare(
    `INSERT INTO members (account_id, created_at, updated_at) VALUES (?1, ?2, ?2)
     ON CONFLICT (account_id) DO UPDATE SET updated_at = excluded.updated_at RETURNING *`,
  )
    .bind(accountId, now)
    .first<Member>();
}

/** The signed-in member when a token is sent; otherwise the guest (null when neither). */
export async function memberOrGuest(req: Request, env: Env, deps: Deps, create: boolean): Promise<Member | null> {
  if (req.headers.get('Authorization')) return requireMember(req, env, deps);
  return guestFromRequest(req, env, deps, create);
}

/** Keeps an active guest from expiring. */
export async function touchGuest(env: Env, deps: Deps, guest: Member): Promise<void> {
  await env.DB.prepare(`UPDATE members SET updated_at = ?2 WHERE id = ?1`).bind(guest.id, iso(deps.now())).run();
}

/** A guest marks an action done at most once a day, so public totals can't be pushed up by repeat clicks. */
export async function assertGuestCanMark(env: Env, deps: Deps, guest: Member, actionId: string): Promise<void> {
  const today = utcDay(deps.now());
  const r = await env.DB.prepare(`SELECT 1 AS x FROM done_marks WHERE member_id = ?1 AND action_id = ?2 AND substr(done_at, 1, 10) = ?3 LIMIT 1`)
    .bind(guest.id, actionId, today)
    .first();
  if (r) throw new HttpError(429, 'guest_done_today', 'err-guest-done-today');
}

/**
 * Moves the guest's marks (and ripple links) to the signed-in member, then closes
 * the guest. A guest mark for an action the member already marked that same day
 * is the same deed, so it is dropped rather than counted twice.
 */
export async function claimGuest(env: Env, deps: Deps, member: Member, guest: Member | null) {
  if (!guest || !isGuest(guest) || guest.id === member.id) return { merged: 0 };
  const now = iso(deps.now());
  const actions = await env.DB.prepare(`SELECT DISTINCT action_id FROM done_marks WHERE member_id = ?1`).bind(guest.id).all<{ action_id: string }>();
  const dup = await env.DB.prepare(
    `DELETE FROM done_marks WHERE member_id = ?1 AND EXISTS (
       SELECT 1 FROM done_marks m WHERE m.member_id = ?2 AND m.action_id = done_marks.action_id AND substr(m.done_at, 1, 10) = substr(done_marks.done_at, 1, 10))`,
  )
    .bind(guest.id, member.id)
    .run();
  const moved = await env.DB.prepare(`UPDATE done_marks SET member_id = ?2 WHERE member_id = ?1`).bind(guest.id, member.id).run();
  const guestRef = await env.DB.prepare(`SELECT ref_code FROM members WHERE id = ?1`).bind(guest.id).first<{ ref_code: string | null }>();
  await env.DB.batch([
    // Who brought the guest here now brought the member (unless someone already had).
    env.DB.prepare(
      `UPDATE members SET inviter_id = (SELECT inviter_id FROM members WHERE id = ?1), inviter_joined_at = (SELECT inviter_joined_at FROM members WHERE id = ?1)
       WHERE id = ?2 AND inviter_id IS NULL AND (SELECT inviter_id FROM members WHERE id = ?1) IS NOT NULL AND (SELECT inviter_id FROM members WHERE id = ?1) != ?2`,
    ).bind(guest.id, member.id),
    // People the guest brought here now hang on the member.
    env.DB.prepare(`UPDATE members SET inviter_id = ?2 WHERE inviter_id = ?1 AND id != ?2`).bind(guest.id, member.id),
    env.DB.prepare(`UPDATE OR IGNORE invite_joins SET member_id = ?2 WHERE member_id = ?1`).bind(guest.id, member.id),
    env.DB.prepare(`DELETE FROM invite_joins WHERE member_id = ?1`).bind(guest.id),
    env.DB.prepare(`UPDATE OR IGNORE invites SET inviter_id = ?2 WHERE inviter_id = ?1`).bind(guest.id, member.id),
    // Links the guest shared now count for the member (their code moves if the member has none).
    env.DB.prepare(`UPDATE done_marks SET parent_member_id = ?2 WHERE parent_member_id = ?1 AND member_id != ?2`).bind(guest.id, member.id),
    env.DB.prepare(`UPDATE done_marks SET parent_member_id = NULL WHERE parent_member_id = ?1`).bind(guest.id),
    env.DB.prepare(`UPDATE members SET ref_code = NULL WHERE id = ?1`).bind(guest.id),
    env.DB.prepare(`UPDATE members SET ref_code = ?2 WHERE id = ?1 AND ref_code IS NULL AND ?2 IS NOT NULL`).bind(member.id, guestRef?.ref_code ?? null),
    env.DB.prepare(`UPDATE members SET account_id = 'merged:' || id, inviter_id = NULL, deleted_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(guest.id, now),
  ]);
  for (const a of actions.results) await env.CACHE.delete(`count:${a.action_id}`);
  await env.CACHE.delete('most-done');
  await env.CACHE.delete(`ripple:${member.id}`);
  await recomputeKeeps(env, member.id);
  return { merged: moved.meta.changes, duplicates: dup.meta.changes };
}

/** Daily: guests not seen for 30 days can no longer be claimed. Their marks stay counted. */
export async function expireGuests(env: Env, deps: Deps) {
  const cutoff = iso(new Date(deps.now().getTime() - GUEST_DAYS * DAY));
  const r = await env.DB.prepare(`UPDATE members SET account_id = 'expired:' || id WHERE account_id LIKE 'guest:%' AND updated_at < ?1`).bind(cutoff).run();
  return { expired: r.meta.changes };
}
