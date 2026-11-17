// Pledges (Phase 3): one per piece sold, taken from Shopify orders. A pledge
// is kept when the buyer marks an action done after the order date; one done
// mark keeps one pledge, oldest open pledge first.

import type { Deps, Env } from '../env';
import { iso } from '../http';
import type { Member } from '../identity';
import { memberEmail } from '../email';
import { enqueue } from '../queue';
import { adminGraphql } from '../shopify';
import { listDrops } from './drops';
import { OWN_SHOP, ensureClaim } from './partners';

export interface OrderLine {
  lineId: string;
  productId: string | null;
  quantity: number;
  refunded: number;
}

export interface Order {
  orderId: string;
  email: string | null;
  customerId: string | null;
  orderedAt: string;
  cancelled: boolean;
  lines: OrderLine[];
}

const gid = (kind: string, id: unknown): string | null => {
  if (id === null || id === undefined || id === '') return null;
  const s = String(id);
  return s.startsWith('gid://') ? s : `gid://shopify/${kind}/${s}`;
};

/** An order from a Shopify webhook (REST shape). */
export function orderFromWebhook(body: Record<string, unknown>): Order | null {
  const id = gid('Order', body.admin_graphql_api_id || body.id);
  if (!id) return null;
  const customer = (body.customer || {}) as Record<string, unknown>;
  const refunded = new Map<string, number>();
  for (const r of (body.refunds as { refund_line_items?: { line_item_id: unknown; quantity: number }[] }[] | undefined) || []) {
    for (const rl of r.refund_line_items || []) {
      const k = gid('LineItem', rl.line_item_id)!;
      refunded.set(k, (refunded.get(k) || 0) + Number(rl.quantity || 0));
    }
  }
  const lines = ((body.line_items as Record<string, unknown>[] | undefined) || [])
    .filter((l) => !l.gift_card)
    .map((l) => {
      const lineId = gid('LineItem', l.admin_graphql_api_id || l.id)!;
      return { lineId, productId: gid('Product', l.product_id), quantity: Number(l.quantity || 0), refunded: refunded.get(lineId) || 0 };
    });
  const email = String(body.email || body.contact_email || customer.email || '').trim().toLowerCase() || null;
  return {
    orderId: id,
    email,
    customerId: gid('Customer', customer.admin_graphql_api_id || customer.id),
    orderedAt: new Date(String(body.processed_at || body.created_at || Date.now())).toISOString(),
    cancelled: !!body.cancelled_at,
    lines,
  };
}

/** Which drop each Shopify product belongs to (by drop slug). */
async function dropOfProduct(env: Env, deps: Deps): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const drops = await listDrops(env, deps);
  const rows = await env.DB.prepare(`SELECT shopify_id, cms_item_id FROM product_sync WHERE cms_item_id IS NOT NULL`).all<{ shopify_id: string; cms_item_id: string }>();
  const byItem = new Map(rows.results.map((r) => [r.cms_item_id, r.shopify_id]));
  for (const d of drops) {
    for (const item of d.productItemIds) {
      const p = byItem.get(item);
      if (p && !map.has(p)) map.set(p, d.slug);
    }
  }
  return map;
}

// The shop's customer accounts are separate from foundation members
// (Memberstack), so an order joins the member with the same verified email.
async function memberFor(env: Env, order: Order): Promise<number | null> {
  if (order.email) {
    const m = await env.DB.prepare(`SELECT id FROM members WHERE email = ?1 AND deleted_at IS NULL ORDER BY id LIMIT 1`).bind(order.email).first<{ id: number }>();
    if (m) return m.id;
  }
  return null;
}

/**
 * Records an order's pledges, or brings them up to date after a cancellation
 * or refund. Safe to run again for the same order.
 */
export async function ingestOrder(env: Env, deps: Deps, order: Order) {
  const memberId = await memberFor(env, order);
  const drops = await dropOfProduct(env, deps);
  const stmts: D1PreparedStatement[] = [];
  const affectedDrops = new Set<string>();
  for (const line of order.lines) {
    const drop = line.productId ? drops.get(line.productId) || null : null;
    if (drop) affectedDrops.add(drop);
    const live = order.cancelled ? 0 : Math.max(0, line.quantity - line.refunded);
    for (let piece = 1; piece <= line.quantity; piece++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO pledges (order_ref, line_ref, piece, drop_id, buyer_email, member_id, ordered_at, status, product_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8)
           ON CONFLICT (order_ref, line_ref, piece) DO UPDATE SET
             member_id = COALESCE(pledges.member_id, excluded.member_id),
             drop_id = COALESCE(excluded.drop_id, pledges.drop_id)`,
        ).bind(order.orderId, line.lineId, piece, drop, memberId ? null : order.email, memberId, order.orderedAt, line.productId),
      );
    }
    // Refunded or cancelled pieces come out, the highest piece numbers first.
    stmts.push(
      env.DB.prepare(
        `UPDATE pledges SET status = 'cancelled', kept_by_done_mark_id = NULL
         WHERE order_ref = ?1 AND line_ref = ?2 AND piece > ?3 AND status != 'cancelled'`,
      ).bind(order.orderId, line.lineId, live),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // Our shop is partner 1: the order's pledges get a claim link for the buyer.
  const claim = await ensureClaim(env, deps, OWN_SHOP, order.orderId);
  await env.DB.prepare(`UPDATE pledges SET claim_id = ?1, partner_id = ?2 WHERE order_ref = ?3 AND claim_id IS NULL`).bind(claim.id, OWN_SHOP, order.orderId).run();
  const owners = await env.DB.prepare(`SELECT DISTINCT member_id FROM pledges WHERE order_ref = ?1 AND member_id IS NOT NULL`)
    .bind(order.orderId)
    .all<{ member_id: number }>();
  for (const o of owners.results) await recomputeKeeps(env, o.member_id);
  for (const d of affectedDrops) await env.CACHE.delete(`drop-pledges:${d}`);
  const counts = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM pledges WHERE order_ref = ?1 GROUP BY status`).bind(order.orderId).all<{ status: string; n: number }>();
  return { order: order.orderId, member: memberId, pledges: Object.fromEntries(counts.results.map((c) => [c.status, c.n])) };
}

/** A refund webhook: the order is re-read from Shopify so the counts are exact. */
export async function refundOrder(env: Env, deps: Deps, orderId: unknown) {
  const id = gid('Order', orderId);
  if (!id) return { ignored: 'no order id' };
  const order = await fetchOrder(env, deps, id);
  return order ? ingestOrder(env, deps, order) : { ignored: 'order not found' };
}

const ORDER_FIELDS = `id email createdAt processedAt cancelledAt customer { id }
  lineItems(first: 100) { nodes { id quantity product { id } } }
  refunds { refundLineItems(first: 100) { nodes { quantity lineItem { id } } } }`;

interface GqlOrder {
  id: string;
  email: string | null;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  customer: { id: string } | null;
  lineItems: { nodes: { id: string; quantity: number; product: { id: string } | null }[] };
  refunds: { refundLineItems: { nodes: { quantity: number; lineItem: { id: string } }[] } }[];
}

function orderFromGraphql(o: GqlOrder): Order {
  const refunded = new Map<string, number>();
  for (const r of o.refunds || []) for (const rl of r.refundLineItems.nodes) refunded.set(rl.lineItem.id, (refunded.get(rl.lineItem.id) || 0) + rl.quantity);
  return {
    orderId: o.id,
    email: o.email?.trim().toLowerCase() || null,
    customerId: o.customer?.id || null,
    orderedAt: new Date(o.processedAt || o.createdAt).toISOString(),
    cancelled: !!o.cancelledAt,
    lines: o.lineItems.nodes.map((l) => ({ lineId: l.id, productId: l.product?.id || null, quantity: l.quantity, refunded: refunded.get(l.id) || 0 })),
  };
}

async function fetchOrder(env: Env, deps: Deps, id: string): Promise<Order | null> {
  const r = await adminGraphql<{ order: GqlOrder | null }>(env, deps, `query ($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
  return r.order ? orderFromGraphql(r.order) : null;
}

/**
 * Safety net for missed webhooks: re-reads orders changed in the last few
 * days (and, the first time, every order Shopify lets the app see).
 */
export async function syncRecentOrders(env: Env, deps: Deps, opts: { days?: number } = {}) {
  const since = new Date(deps.now().getTime() - (opts.days ?? 3) * 86_400_000).toISOString();
  let after: string | null = null;
  let orders = 0;
  for (let page = 0; page < 20; page++) {
    const r: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlOrder[] } } = await adminGraphql(
      env,
      deps,
      `query ($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
         pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`,
      { q: `updated_at:>='${since}'`, after },
    );
    for (const o of r.orders.nodes) {
      await ingestOrder(env, deps, orderFromGraphql(o));
      orders++;
    }
    if (!r.orders.pageInfo.hasNextPage) break;
    after = r.orders.pageInfo.endCursor;
  }
  return { orders };
}

/**
 * Works out which of a member's pledges are kept: each done mark, in time
 * order, keeps the oldest open pledge ordered before it.
 */
export async function recomputeKeeps(env: Env, memberId: number): Promise<void> {
  const pledges = await env.DB.prepare(
    `SELECT id, ordered_at, status, kept_by_done_mark_id AS keptBy FROM pledges WHERE member_id = ?1 AND status != 'cancelled' ORDER BY ordered_at, id`,
  )
    .bind(memberId)
    .all<{ id: number; ordered_at: string; status: string; keptBy: number | null }>();
  if (!pledges.results.length) return;
  const marks = await env.DB.prepare(`SELECT id, done_at FROM done_marks WHERE member_id = ?1 ORDER BY done_at, id`).bind(memberId).all<{ id: number; done_at: string }>();
  const keptBy = new Map<number, number>();
  const open = [...pledges.results];
  for (const m of marks.results) {
    const i = open.findIndex((p) => p.ordered_at < m.done_at);
    if (i < 0) continue;
    keptBy.set(open[i].id, m.id);
    open.splice(i, 1);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const p of pledges.results) {
    const k = keptBy.get(p.id) ?? null;
    const status = k ? 'kept' : 'open';
    if (p.status !== status || p.keptBy !== k) {
      stmts.push(env.DB.prepare(`UPDATE pledges SET status = ?2, kept_by_done_mark_id = ?3 WHERE id = ?1`).bind(p.id, status, k));
    }
  }
  if (stmts.length) {
    await env.DB.batch(stmts);
    const drops = await env.DB.prepare(`SELECT DISTINCT drop_id FROM pledges WHERE member_id = ?1 AND drop_id IS NOT NULL`).bind(memberId).all<{ drop_id: string }>();
    for (const d of drops.results) await env.CACHE.delete(`drop-pledges:${d.drop_id}`);
  }
}

/** Guest orders join the member when that email signs in. */
export async function linkGuestPledges(env: Env, member: Member): Promise<void> {
  if (!member.email) return;
  const r = await env.DB.prepare(`UPDATE pledges SET member_id = ?1, buyer_email = NULL WHERE member_id IS NULL AND buyer_email = ?2`).bind(member.id, member.email).run();
  if (r.meta.changes) await recomputeKeeps(env, member.id);
}

/** "100 pledges made, 64 kept" for a drop. */
export async function dropPledges(env: Env, dropSlug: string): Promise<{ made: number; kept: number }> {
  const key = `drop-pledges:${dropSlug}`;
  const cached = (await env.CACHE.get(key, 'json')) as { made: number; kept: number } | null;
  if (cached) return cached;
  const r = await env.DB.prepare(
    `SELECT SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS made, SUM(CASE WHEN status = 'kept' THEN 1 ELSE 0 END) AS kept
     FROM pledges WHERE drop_id = ?1`,
  )
    .bind(dropSlug)
    .first<{ made: number | null; kept: number | null }>();
  const out = { made: r?.made ?? 0, kept: r?.kept ?? 0 };
  await env.CACHE.put(key, JSON.stringify(out), { expirationTtl: 60 });
  return out;
}

/** A member's pledges for the account page. */
export async function memberPledges(env: Env, memberId: number) {
  const r = await env.DB.prepare(
    `SELECT p.id, p.ordered_at AS orderedAt, p.status, p.drop_id AS dropSlug,
       d.action_title AS keptByTitle, d.done_at AS keptOn, a.slug AS keptBySlug
     FROM pledges p LEFT JOIN done_marks d ON d.id = p.kept_by_done_mark_id LEFT JOIN actions a ON a.cms_item_id = d.action_id AND a.status = 'published'
     WHERE p.member_id = ?1 AND p.status != 'cancelled' ORDER BY p.ordered_at DESC, p.id DESC LIMIT 200`,
  )
    .bind(memberId)
    .all();
  return r.results;
}

const WEEK = 7 * 86_400_000;

/**
 * One reminder per order when its pledges are still open 7 days later.
 * Never a second one, and none for members who turned these emails off.
 */
export async function pledgeReminders(env: Env, deps: Deps, baseUrl: string) {
  const cutoff = iso(new Date(deps.now().getTime() - WEEK));
  const due = await env.DB.prepare(
    `SELECT p.member_id AS memberId, p.order_ref AS orderId FROM pledges p
     WHERE p.status = 'open' AND p.reminder_sent_at IS NULL AND p.member_id IS NOT NULL AND p.ordered_at <= ?1
     GROUP BY p.member_id, p.order_ref LIMIT 100`,
  )
    .bind(cutoff)
    .all<{ memberId: number; orderId: string }>();
  const site = baseUrl.replace(/\/join$/, '');
  let sent = 0;
  for (const d of due.results) {
    const member = await env.DB.prepare(`SELECT * FROM members WHERE id = ?1`).bind(d.memberId).first<Member>();
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE pledges SET reminder_sent_at = ?3 WHERE member_id = ?1 AND order_ref = ?2`).bind(d.memberId, d.orderId, iso(deps.now())),
    ];
    const msg = member && !member.deleted_at ? await memberEmail(env, member, 'pledge_reminder', { actionUrl: `${site}/actions` }, baseUrl) : null;
    if (msg) {
      stmts.push(enqueue(env, deps, `pledge-reminder:${d.orderId}:${d.memberId}`, { op: 'email.send', message: msg }, d.memberId));
      sent++;
    }
    await env.DB.batch(stmts);
  }
  return { sent, checked: due.results.length };
}
