// "Keep your pledge" links: every order from our shop comes with a pledge to make
// someone happy. When the order did not join a member by email, the buyer is emailed
// a claim link; signing in with it makes the pledge theirs. Pledges are only for
// this site's own shop (there are no outside partners).

import type { EmailMessage } from '../email';
import type { Deps, Env } from '../env';
import { HttpError, base64url, hmac, iso, sha256Hex } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { recomputeKeeps } from './pledges';

/** Our own shop. Claims and pledges keep this id (partner_id 1) in the database. */
export const OWN_SHOP = 1;
/** Resend template "hf-pledge-claim", by its ID: its alias became hf-pledge-claim-1 in Resend, and an ID never changes. */
export const CLAIM_TEMPLATE = 'bbdab255-e4eb-40f2-95cf-7081e3f24486';

/** The claim code for an order: derived from the server's secret, so it cannot be guessed and is the same on every retry. */
export async function claimCode(env: Env, partnerId: number, orderRef: string): Promise<string> {
  return base64url(await hmac(env.LINK_SECRET, `claim:${partnerId}:${orderRef}`)).slice(0, 24);
}

export function claimUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/join$/, '')}/keep-your-pledge?c=${encodeURIComponent(code)}`;
}

/** The claim for an order (created once), with its code. */
export async function ensureClaim(env: Env, deps: Deps, partnerId: number, orderRef: string): Promise<{ id: number; code: string }> {
  const code = await claimCode(env, partnerId, orderRef);
  const row = await env.DB.prepare(
    `INSERT INTO pledge_claims (partner_id, order_ref, code_hash, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (partner_id, order_ref) DO UPDATE SET order_ref = excluded.order_ref
     RETURNING id`,
  )
    .bind(partnerId, orderRef, await sha256Hex(code), iso(deps.now()))
    .first<{ id: number }>();
  return { id: row!.id, code };
}

/** POST /api/pledges/claim: a signed-in member keeps the pledges of a claim link. */
export async function claimPledges(env: Env, deps: Deps, member: Member, body: { code?: unknown }) {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > 64) throw new HttpError(404, 'claim_not_found', 'err-claim-invalid');
  const claim = await env.DB.prepare(`SELECT id, member_id FROM pledge_claims WHERE code_hash = ?1`).bind(await sha256Hex(code)).first<{ id: number; member_id: number | null }>();
  if (!claim) throw new HttpError(404, 'claim_not_found', 'err-claim-invalid');
  const taken = await env.DB.prepare(`SELECT 1 FROM pledges WHERE claim_id = ?1 AND member_id IS NOT NULL AND member_id != ?2 LIMIT 1`).bind(claim.id, member.id).first();
  if ((claim.member_id && claim.member_id !== member.id) || taken) throw new HttpError(409, 'claim_taken', 'err-claim-taken');
  const now = iso(deps.now());
  await env.DB.batch([
    env.DB.prepare(`UPDATE pledge_claims SET member_id = ?2, claimed_at = COALESCE(claimed_at, ?3) WHERE id = ?1`).bind(claim.id, member.id, now),
    env.DB.prepare(`UPDATE pledges SET member_id = ?2, buyer_email = NULL WHERE claim_id = ?1`).bind(claim.id, member.id),
  ]);
  await recomputeKeeps(env, member.id);
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pledges WHERE claim_id = ?1 AND status != 'cancelled'`).bind(claim.id).first<{ n: number }>();
  return { claimed: n?.n ?? 0 };
}

/**
 * Job: emails buyers from our own shop their "Keep your pledge" link (Resend
 * template hf-pledge-claim, CLAIM_TEMPLATE), when the order did not join a member by email.
 */
export async function claimEmails(env: Env, deps: Deps, baseUrl: string) {
  const due = await env.DB.prepare(
    `SELECT c.id, c.order_ref AS orderRef, MIN(p.buyer_email) AS email, COUNT(*) AS n
     FROM pledge_claims c JOIN pledges p ON p.claim_id = c.id
     WHERE c.partner_id = ?1 AND c.email_sent_at IS NULL AND c.member_id IS NULL
       AND p.member_id IS NULL AND p.buyer_email IS NOT NULL AND p.status != 'cancelled'
     GROUP BY c.id LIMIT 50`,
  )
    .bind(OWN_SHOP)
    .all<{ id: number; orderRef: string; email: string; n: number }>();
  for (const c of due.results) {
    const message: EmailMessage = {
      to: c.email,
      template: { id: CLAIM_TEMPLATE, variables: { CLAIM_URL: claimUrl(baseUrl, await claimCode(env, OWN_SHOP, c.orderRef)), COUNT: c.n } },
      tags: [{ name: 'kind', value: 'pledge_claim' }],
    };
    await env.DB.batch([
      enqueue(env, deps, `pledge-claim:${c.id}`, { op: 'email.send', message }),
      env.DB.prepare(`UPDATE pledge_claims SET email_sent_at = ?2 WHERE id = ?1`).bind(c.id, iso(deps.now())),
    ]);
  }
  return { sent: due.results.length };
}
