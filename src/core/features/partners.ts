// Partner pledges: any shop (ours is partner 1) registers the pledge that comes
// with an order (one per purchase), server to server, and gets back a "Keep your pledge" link for
// the buyer. Signing in on the foundation with that link makes the pledges the
// member's. No customer data has to be shared; an email is optional and only
// used to attach the pledges automatically to a member with that verified email.

import type { EmailMessage } from '../email';
import type { Deps, Env } from '../env';
import { HttpError, base64url, bearer, hmac, iso, sha256Hex } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { ORDER_LINE, recomputeKeeps } from './pledges';

export const OWN_SHOP = 1;
/** Resend template "hf-pledge-claim", by its ID: its alias became hf-pledge-claim-1 in Resend, and an ID never changes. */
export const CLAIM_TEMPLATE = 'bbdab255-e4eb-40f2-95cf-7081e3f24486';

export interface Partner {
  id: number;
  name: string;
  slug: string;
  active: number;
}

/** The claim code for a partner's order: derived from the server's secret, so it cannot be guessed and is the same on every retry. */
export async function claimCode(env: Env, partnerId: number, orderRef: string): Promise<string> {
  return base64url(await hmac(env.LINK_SECRET, `claim:${partnerId}:${orderRef}`)).slice(0, 24);
}

export function claimUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/join$/, '')}/keep-your-pledge?c=${encodeURIComponent(code)}`;
}

/** The claim for a partner's order (created once), with its code. */
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

/** The partner a request's key belongs to. */
export async function partnerFromRequest(env: Env, req: Request): Promise<Partner> {
  const key = bearer(req);
  if (!key || !key.startsWith('hfp_')) throw new HttpError(401, 'unauthorized', 'Not authorised.');
  const p = await env.DB.prepare(`SELECT id, name, slug, active FROM partners WHERE key_hash = ?1`).bind(await sha256Hex(key)).first<Partner>();
  if (!p || !p.active) throw new HttpError(401, 'unauthorized', 'Not authorised.');
  return p;
}

async function memberIdForEmail(env: Env, email: string | null): Promise<number | null> {
  if (!email) return null;
  const m = await env.DB.prepare(`SELECT id FROM members WHERE email = ?1 AND deleted_at IS NULL ORDER BY id LIMIT 1`).bind(email).first<{ id: number }>();
  return m?.id ?? null;
}

interface PledgeBody {
  order?: unknown;
  orderedAt?: unknown;
  email?: unknown;
}

function invalid(field: string): HttpError {
  return new HttpError(400, 'invalid_pledges', `Invalid "${field}".`);
}

/**
 * POST /api/partners/pledges: registers the pledge of one order (one pledge
 * per purchase): {order, email?, orderedAt?}. Safe to repeat; sending a
 * cancelled order again opens its pledge again.
 */
export async function registerPledges(env: Env, deps: Deps, partner: Partner, body: PledgeBody, baseUrl: string) {
  const order = typeof body.order === 'string' ? body.order.trim() : '';
  if (!order || order.length > 100) throw invalid('order');
  const orderedAt = body.orderedAt === undefined ? iso(deps.now()) : new Date(String(body.orderedAt));
  if (typeof orderedAt !== 'string' && Number.isNaN(orderedAt.getTime())) throw invalid('orderedAt');
  const when = typeof orderedAt === 'string' ? orderedAt : orderedAt.toISOString();
  const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase().slice(0, 254) : null;
  const orderRef = `${partner.slug}:${order}`;
  const claim = await ensureClaim(env, deps, partner.id, orderRef);
  const memberId = await memberIdForEmail(env, email);
  await env.DB.prepare(
    `INSERT INTO pledges (order_ref, line_ref, piece, partner_id, claim_id, buyer_email, member_id, ordered_at, status)
     VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 'open')
     ON CONFLICT (order_ref, line_ref, piece) DO UPDATE SET
       status = CASE WHEN pledges.status = 'cancelled' THEN 'open' ELSE pledges.status END`,
  )
    .bind(orderRef, ORDER_LINE, partner.id, claim.id, memberId ? null : email, memberId, when)
    .run();
  await recomputeOwners(env, orderRef);
  return { order, pledge: 'open', claimUrl: claimUrl(baseUrl, claim.code) };
}

/** POST /api/partners/pledges/cancel: the order was cancelled or refunded in full. */
export async function cancelPledges(env: Env, partner: Partner, body: PledgeBody) {
  const order = typeof body.order === 'string' ? body.order.trim() : '';
  if (!order || order.length > 100) throw invalid('order');
  const orderRef = `${partner.slug}:${order}`;
  const r = await env.DB.prepare(`UPDATE pledges SET status = 'cancelled', kept_by_done_mark_id = NULL WHERE order_ref = ?1 AND status != 'cancelled'`).bind(orderRef).run();
  await recomputeOwners(env, orderRef);
  return { order, cancelled: r.meta.changes ?? 0 };
}

async function recomputeOwners(env: Env, orderRef: string) {
  const owners = await env.DB.prepare(`SELECT DISTINCT member_id FROM pledges WHERE order_ref = ?1 AND member_id IS NOT NULL`).bind(orderRef).all<{ member_id: number }>();
  for (const o of owners.results) await recomputeKeeps(env, o.member_id);
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

// --- /lab: partners -----------------------------------------------------------

export async function listPartners(env: Env) {
  const r = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.active, p.created_at AS createdAt, p.key_hash IS NOT NULL AS hasKey,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.status != 'cancelled') AS pledges,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.member_id IS NOT NULL AND x.status != 'cancelled') AS claimed,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.status = 'kept') AS kept
     FROM partners p ORDER BY p.id`,
  ).all();
  return { partners: r.results };
}

/** Adds a partner; its key is returned once and only its hash is kept. */
export async function addPartner(env: Env, deps: Deps, by: string, body: { name?: unknown }) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'invalid_partner', 'Please give the partner a name.');
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'partner';
  if (await env.DB.prepare(`SELECT 1 FROM partners WHERE slug = ?1`).bind(slug).first()) slug = `${slug}-${Date.now().toString(36)}`;
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const key = `hfp_${base64url(raw)}`;
  await env.DB.prepare(`INSERT INTO partners (name, slug, key_hash, active, created_by, created_at) VALUES (?1, ?2, ?3, 1, ?4, ?5)`)
    .bind(name, slug, await sha256Hex(key), by, iso(deps.now()))
    .run();
  return { ...(await listPartners(env)), key, slug };
}

export async function setPartnerActive(env: Env, body: { id?: unknown; active?: unknown }) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id === OWN_SHOP || typeof body.active !== 'boolean') throw new HttpError(400, 'invalid_partner', 'That partner cannot be changed here.');
  await env.DB.prepare(`UPDATE partners SET active = ?2 WHERE id = ?1`).bind(id, body.active ? 1 : 0).run();
  return listPartners(env);
}
