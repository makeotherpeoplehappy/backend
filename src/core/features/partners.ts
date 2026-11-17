// Partner pledges (the Pledge API): a partner shop asks for one pledge per
// purchase, server to server, and gets back our pledge reference and a "Keep
// your pledge" link for the buyer. The partner sends no customer data at all:
// no order number, no email. Signing in on the foundation with the link makes
// the pledge the member's. Partners see their results only as numbers (a
// monthly report). Our own Shopify shop is partner 1 and works through the
// Shopify webhook instead (pledges.ts).

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

/** The partner's pledge reference: ours, random (or derived from the request's Idempotency-Key, so a retry gets the same pledge). */
async function pledgeRef(env: Env, partnerId: number, idempotencyKey: string | null): Promise<string> {
  if (idempotencyKey) return `pl_${base64url(await hmac(env.LINK_SECRET, `pledge:${partnerId}:${idempotencyKey}`)).slice(0, 22)}`;
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return `pl_${base64url(raw)}`;
}

const PLEDGE_REF = /^pl_[\w-]{16,40}$/;
/** Fields the Pledge API used to take and now refuses: no customer data. */
const CUSTOMER_DATA = ['order', 'email', 'orderedAt', 'customer', 'name', 'phone'];

/**
 * POST /api/partners/pledges: one pledge for one purchase. The body is empty
 * (or {}); order numbers and emails are refused. Send an Idempotency-Key header
 * to make retries safe. Answer: {pledge, status, claimUrl}.
 */
export async function registerPledges(env: Env, deps: Deps, partner: Partner, body: Record<string, unknown>, baseUrl: string, idempotencyKey: string | null) {
  if (body && typeof body === 'object' && CUSTOMER_DATA.some((k) => k in body)) {
    throw new HttpError(400, 'no_customer_data', 'Send no customer data: no order number, no email.');
  }
  const key = idempotencyKey && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 200) : null;
  const pledge = await pledgeRef(env, partner.id, key);
  const ref = `${partner.slug}:${pledge}`;
  const claim = await ensureClaim(env, deps, partner.id, ref);
  await env.DB.prepare(
    `INSERT INTO pledges (order_ref, line_ref, piece, partner_id, claim_id, buyer_email, member_id, ordered_at, status)
     VALUES (?1, ?2, 1, ?3, ?4, NULL, NULL, ?5, 'open')
     ON CONFLICT (order_ref, line_ref, piece) DO NOTHING`,
  )
    .bind(ref, ORDER_LINE, partner.id, claim.id, iso(deps.now()))
    .run();
  const row = await env.DB.prepare(`SELECT status FROM pledges WHERE order_ref = ?1`).bind(ref).first<{ status: string }>();
  return { pledge, status: row?.status ?? 'open', claimUrl: claimUrl(baseUrl, claim.code) };
}

/** POST /api/partners/pledges/cancel: {pledge}. The purchase was cancelled or refunded in full. */
export async function cancelPledges(env: Env, partner: Partner, body: { pledge?: unknown }) {
  const pledge = typeof body.pledge === 'string' ? body.pledge.trim() : '';
  if (!PLEDGE_REF.test(pledge)) throw new HttpError(400, 'invalid_pledge', 'Invalid "pledge".');
  const ref = `${partner.slug}:${pledge}`;
  const r = await env.DB.prepare(`UPDATE pledges SET status = 'cancelled', kept_by_done_mark_id = NULL WHERE order_ref = ?1 AND partner_id = ?2 AND status != 'cancelled'`)
    .bind(ref, partner.id)
    .run();
  await recomputeOwners(env, ref);
  return { pledge, cancelled: r.meta.changes ?? 0 };
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

// --- Partner reports: numbers only ----------------------------------------------

/** Resend template "Partner monthly report" (variables below), by its ID, which never changes. */
export const REPORT_TEMPLATE = '3a5888f8-c8b8-4046-9863-b7ebb9023c71';

/** "2026-10" for the month before the given date. */
export function lastMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** A partner's pledges in numbers: for one month ("YYYY-MM") and in total. Never who. */
export async function partnerReport(env: Env, partnerId: number, month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'invalid_month', 'Invalid "month".');
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, m, 1)).toISOString();
  const count = async (where: string, ...args: unknown[]) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM pledges WHERE partner_id = ?1 AND status != 'cancelled' ${where}`).bind(partnerId, ...args).first<{ n: number }>())?.n ?? 0;
  const inMonth = `AND ordered_at >= ?2 AND ordered_at < ?3`;
  return {
    month,
    given: await count(inMonth, from, to),
    claimed: await count(`${inMonth} AND member_id IS NOT NULL`, from, to),
    kept: await count(`${inMonth} AND status = 'kept'`, from, to),
    total: { given: await count(''), claimed: await count('AND member_id IS NOT NULL'), kept: await count(`AND status = 'kept'`) },
  };
}

/** Job: on the first days of a month, each partner with a report email gets last month's numbers (once). */
export async function partnerReports(env: Env, deps: Deps) {
  const month = lastMonth(deps.now());
  const due = await env.DB.prepare(
    `SELECT id, name, report_email AS email FROM partners
     WHERE id != ?1 AND active = 1 AND report_email IS NOT NULL AND (last_report_month IS NULL OR last_report_month < ?2)`,
  )
    .bind(OWN_SHOP, month)
    .all<{ id: number; name: string; email: string }>();
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  for (const p of due.results) {
    const r = await partnerReport(env, p.id, month);
    const message: EmailMessage = {
      to: p.email,
      template: {
        id: REPORT_TEMPLATE,
        variables: { PARTNER: p.name, MONTH: label, GIVEN: r.given, CLAIMED: r.claimed, KEPT: r.kept, TOTAL_GIVEN: r.total.given, TOTAL_CLAIMED: r.total.claimed, TOTAL_KEPT: r.total.kept },
      },
      tags: [{ name: 'kind', value: 'partner_report' }],
    };
    await env.DB.batch([
      enqueue(env, deps, `partner-report:${p.id}:${month}`, { op: 'email.send', message }),
      env.DB.prepare(`UPDATE partners SET last_report_month = ?2 WHERE id = ?1`).bind(p.id, month),
    ]);
  }
  return { sent: due.results.length, month };
}

// --- /lab: partners -----------------------------------------------------------

export async function listPartners(env: Env) {
  const r = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.active, p.created_at AS createdAt, p.key_hash IS NOT NULL AS hasKey, p.report_email AS reportEmail,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.status != 'cancelled') AS pledges,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.member_id IS NOT NULL AND x.status != 'cancelled') AS claimed,
       (SELECT COUNT(*) FROM pledges x WHERE x.partner_id = p.id AND x.status = 'kept') AS kept
     FROM partners p ORDER BY p.id`,
  ).all();
  return { partners: r.results };
}

/** Adds a partner; its key is returned once and only its hash is kept. */
function reportEmailOf(v: unknown): string | null {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new HttpError(400, 'invalid_partner', 'That report email does not look right.');
  return e;
}

export async function addPartner(env: Env, deps: Deps, by: string, body: { name?: unknown; reportEmail?: unknown }) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const reportEmail = reportEmailOf(body.reportEmail);
  if (!name) throw new HttpError(400, 'invalid_partner', 'Please give the partner a name.');
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'partner';
  if (await env.DB.prepare(`SELECT 1 FROM partners WHERE slug = ?1`).bind(slug).first()) slug = `${slug}-${Date.now().toString(36)}`;
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const key = `hfp_${base64url(raw)}`;
  await env.DB.prepare(`INSERT INTO partners (name, slug, key_hash, active, created_by, created_at, report_email) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)`)
    .bind(name, slug, await sha256Hex(key), by, iso(deps.now()), reportEmail)
    .run();
  return { ...(await listPartners(env)), key, slug };
}

export async function setPartnerActive(env: Env, body: { id?: unknown; active?: unknown; reportEmail?: unknown }) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id === OWN_SHOP) throw new HttpError(400, 'invalid_partner', 'That partner cannot be changed here.');
  if ('reportEmail' in body) await env.DB.prepare(`UPDATE partners SET report_email = ?2 WHERE id = ?1`).bind(id, reportEmailOf(body.reportEmail)).run();
  if ('active' in body) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'invalid_partner', 'That partner cannot be changed here.');
    await env.DB.prepare(`UPDATE partners SET active = ?2 WHERE id = ?1`).bind(id, body.active ? 1 : 0).run();
  }
  return listPartners(env);
}
