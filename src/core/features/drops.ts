// Drops (in Shopify): the list, state, stock and scheduled release. "Notify
// me" sign-ups are the shop theme's native Shopify form (customer tag
// notify-drop-<handle>); writeDropSignupToShopify only finishes sign-ups that
// were queued before the shop moved to Shopify.

import type { Deps, Env } from '../env';
import { HttpError, iso, sha256Hex } from '../http';
import { adminGraphql } from '../shopify';
import { word } from '../wording';
import { dropPledges } from './pledges';

/**
 * A drop is a Shopify collection with a drop date (collection field
 * custom.drop_date). Its pieces are the collection's products; each piece's
 * size is its edition size (product field custom.edition_size). Status comes
 * from the date and the stock, so nothing is set by hand.
 */
export interface Drop {
  id: string;
  slug: string;
  name: string;
  status: 'upcoming' | 'live' | 'sold_out' | 'unknown';
  dropDate: string | null;
  /** Fallback size when the pieces have no edition size: not used for Shopify drops. */
  quantity: number | null;
  detailsLine: string;
  statement: string;
  productIds: string[];
}

const CACHE_KEY = 'drops:list';
const LAST_KEY = 'drops:last';

interface DropCollection {
  id: string;
  handle: string;
  title: string;
  description: string;
  dropDate: { value: string } | null;
  products: { nodes: { id: string }[] };
}

/** Every drop: the shop's collections that have a drop date, oldest first. Cached 60 seconds. */
export async function listDrops(env: Env, deps: Deps): Promise<Drop[]> {
  const cached = (await env.CACHE.get(CACHE_KEY, 'json')) as Drop[] | null;
  if (cached) return cached;
  let r: { collections: { nodes: DropCollection[] } };
  try {
    r = await adminGraphql<{ collections: { nodes: DropCollection[] } }>(
      env,
      deps,
      `query { collections(first: 100) { nodes { id handle title description
         dropDate: metafield(namespace: "custom", key: "drop_date") { value }
         products(first: 50) { nodes { id } } } } }`,
    );
  } catch (e) {
    // Shopify unreachable: the last known list (kept a day) keeps sign-ups and pages working.
    const last = (await env.CACHE.get(LAST_KEY, 'json')) as Drop[] | null;
    if (last) return last;
    throw e;
  }
  const drops: Drop[] = r.collections.nodes
    .filter((c) => c.dropDate?.value && Number.isFinite(Date.parse(c.dropDate.value)))
    .map((c) => ({
      id: c.id,
      slug: c.handle,
      name: c.title,
      status: 'unknown' as const,
      dropDate: new Date(c.dropDate!.value).toISOString(),
      quantity: null,
      detailsLine: '',
      statement: c.description || '',
      productIds: c.products.nodes.map((p) => p.id),
    }))
    .sort((a, b) => a.dropDate!.localeCompare(b.dropDate!));
  await env.CACHE.put(CACHE_KEY, JSON.stringify(drops), { expirationTtl: 60 });
  await env.CACHE.put(LAST_KEY, JSON.stringify(drops), { expirationTtl: 86_400 });
  return drops;
}

export async function forgetDrops(env: Env): Promise<void> {
  await env.CACHE.delete(CACHE_KEY);
}

/**
 * The drop named by its address, or else the current one: the newest drop on
 * sale now, else the next one coming up, else the most recent one.
 */
export async function findDrop(env: Env, deps: Deps, slug: string | null): Promise<Drop | null> {
  const drops = await listDrops(env, deps);
  if (slug) return drops.find((d) => d.slug === slug) || null;
  const now = deps.now().getTime();
  const started = drops.filter((d) => Date.parse(d.dropDate!) <= now).reverse();
  for (const d of started) if ((await effectiveStatus(env, deps, d)) === 'live') return d;
  return drops.find((d) => Date.parse(d.dropDate!) > now) || started[0] || null;
}

/** The next drop coming up: where "Notify me" goes when no drop is named. */
async function nextDrop(env: Env, deps: Deps): Promise<Drop | null> {
  const now = deps.now().getTime();
  return (await listDrops(env, deps)).find((d) => Date.parse(d.dropDate!) > now) || null;
}

/** The Shopify customer tag for "Notify me" sign-ups to a drop (the theme's native form sets it). */
export const dropTag = (slug: string) => `notify-drop-${slug}`.slice(0, 40);

/**
 * Run by the queue: adds or updates the Shopify customer, subscribes them
 * to email marketing and tags them for the drop.
 */
export async function writeDropSignupToShopify(env: Env, deps: Deps, op: { email: string; firstName: string | null; tag: string }) {
  const found = await adminGraphql<{ customers: { nodes: { id: string; tags: string[]; emailMarketingConsent: { marketingState: string } | null }[] } }>(
    env,
    deps,
    `query ($q: String!) { customers(first: 1, query: $q) { nodes { id tags emailMarketingConsent { marketingState } } } }`,
    { q: `email:"${op.email.replace(/"/g, '')}"` },
  );
  const consent = { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: iso(deps.now()) };
  const existing = found.customers.nodes[0];
  if (!existing) {
    const r = await adminGraphql<{ customerCreate: { userErrors: { message: string }[] } }>(
      env,
      deps,
      `mutation ($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
      { input: { email: op.email, firstName: op.firstName || undefined, tags: [op.tag], emailMarketingConsent: consent } },
    );
    if (r.customerCreate.userErrors.length) throw new Error(`Shopify customerCreate: ${r.customerCreate.userErrors.map((e) => e.message).join('; ')}`);
    return;
  }
  if (!existing.tags.includes(op.tag)) {
    const t = await adminGraphql<{ tagsAdd: { userErrors: { message: string }[] } }>(
      env,
      deps,
      `mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: existing.id, tags: [op.tag] },
    );
    if (t.tagsAdd.userErrors.length) throw new Error(`Shopify tagsAdd: ${t.tagsAdd.userErrors.map((e) => e.message).join('; ')}`);
  }
  if (existing.emailMarketingConsent?.marketingState !== 'SUBSCRIBED') {
    const c = await adminGraphql<{ customerEmailMarketingConsentUpdate: { userErrors: { message: string }[] } }>(
      env,
      deps,
      `mutation ($input: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $input) { userErrors { message } } }`,
      { input: { customerId: existing.id, emailMarketingConsent: consent } },
    );
    const errs = c.customerEmailMarketingConsentUpdate.userErrors;
    if (errs.length) throw new Error(`Shopify consent update: ${errs.map((e) => e.message).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Drop state (Phase 3): stock, status and pledges, worked out from the drop's
// date and quantity and from Shopify, so nothing has to be updated by hand.
// ---------------------------------------------------------------------------

export interface DropStock {
  /** Pieces in the drop: the pieces' edition sizes added up (null when a piece has no size). */
  quantity: number | null;
  /** Pieces left across every piece of the drop; null when any piece's stock is not tracked. */
  left: number | null;
}

/** An edition size from Shopify (custom.edition_size), or null. */
function editionSize(value: string | null | undefined): number | null {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Size and stock of every piece in the drop, added up. Each piece's size is
 * its Shopify edition size (custom.edition_size); a piece's stock counts up
 * to its size. Cached 60 seconds.
 */
export async function dropStock(env: Env, deps: Deps, drop: Drop): Promise<DropStock> {
  const key = `drop-stock:${drop.slug}`;
  const cached = (await env.CACHE.get(key, 'json')) as DropStock | null;
  if (cached && typeof cached === 'object') return cached;
  const ids = drop.productIds;
  const r = ids.length
    ? await adminGraphql<{ nodes: ({ id: string; tracksInventory: boolean; totalInventory: number; edition: { value: string } | null } | null)[] }>(
        env,
        deps,
        `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id tracksInventory totalInventory edition: metafield(namespace: "custom", key: "edition_size") { value } } } }`,
        { ids },
      )
    : { nodes: [] };
  const pieces = r.nodes
    .filter((n): n is NonNullable<typeof n> => !!n && !!n.id)
    .map((n) => {
      const size = editionSize(n.edition?.value);
      const stock = n.tracksInventory ? Math.max(0, n.totalInventory) : null;
      return { size, left: stock === null ? null : size === null ? stock : Math.min(stock, size) };
    });
  const stock: DropStock = {
    quantity: pieces.length && pieces.every((p) => p.size !== null) ? pieces.reduce((n, p) => n + p.size!, 0) : drop.quantity,
    left: pieces.length && pieces.every((p) => p.left !== null) ? pieces.reduce((n, p) => n + p.left!, 0) : null,
  };
  await env.CACHE.put(key, JSON.stringify(stock), { expirationTtl: 60 });
  return stock;
}

const NO_STOCK = (drop: Drop): DropStock => ({ quantity: drop.quantity, left: null });

/** Upcoming before the drop date, sold out once every piece is gone, live otherwise. */
export async function effectiveStatus(env: Env, deps: Deps, drop: Drop, left?: number | null): Promise<Drop['status']> {
  const at = drop.dropDate ? Date.parse(drop.dropDate) : NaN;
  if (Number.isFinite(at)) {
    if (deps.now().getTime() < at) return 'upcoming';
    const l = left === undefined ? (await dropStock(env, deps, drop).catch(() => NO_STOCK(drop))).left : left;
    return l === 0 ? 'sold_out' : 'live';
  }
  return drop.status;
}

const ET = 'America/New_York';

/** "100 pieces. Drops December 5 at 12:00 ET. Gone when they're gone.", worded in src/wording/en.json ("details-..." keys). */
export function detailsLineFor(drop: Pick<Drop, 'quantity' | 'dropDate'>, status: Drop['status']): string | null {
  if (!drop.quantity || !drop.dropDate) return null;
  const d = new Date(drop.dropDate);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const key = status === 'sold_out' ? 'details-sold-out' : status === 'live' ? 'details-live' : 'details-upcoming';
  return word(key, { n: drop.quantity, day, time }) || null;
}

/** What the drop hero needs: status, countdown target, stock and pledges. */
export async function dropState(env: Env, deps: Deps, slug: string | null) {
  const drop = await findDrop(env, deps, slug);
  if (!drop) throw new HttpError(404, 'drop_not_found', 'err-drop-not-found');
  const { quantity, left } = await dropStock(env, deps, drop).catch(() => NO_STOCK(drop));
  const status = await effectiveStatus(env, deps, drop, left);
  return {
    drop: drop.slug,
    name: drop.name,
    status,
    dropDate: drop.dropDate,
    quantity,
    left,
    detailsLine: detailsLineFor({ quantity, dropDate: drop.dropDate }, status) || drop.detailsLine,
    pledges: await dropPledges(env, drop.slug),
  };
}

/**
 * Holds each upcoming drop's products back in Shopify until the drop's date
 * and time, using Shopify's scheduled publishing, so nobody can buy early
 * through a direct link or the shop's own checkout. Needs the Shopify app
 * scopes read_publications and write_publications.
 */
export async function scheduleDropReleases(env: Env, deps: Deps) {
  try {
    return await scheduleReleases(env, deps);
  } catch (e) {
    // Until the Shopify app has the publications scopes, say so plainly (in
    // the jobs result and /lab) instead of failing every hour.
    if (/access denied|ACCESS_DENIED/i.test((e as Error).message)) {
      await env.CACHE.put('drop-releases:needs-scopes', '1', { expirationTtl: 2 * 3600 });
      return { scheduled: [], needsScopes: ['read_publications', 'write_publications'] };
    }
    throw e;
  }
}

async function scheduleReleases(env: Env, deps: Deps) {
  const drops = await listDrops(env, deps);
  const now = deps.now().getTime();
  const scheduled: string[] = [];
  for (const d of drops) {
    const at = d.dropDate ? Date.parse(d.dropDate) : NaN;
    if (!Number.isFinite(at) || at <= now) continue;
    const releaseAt = new Date(at).toISOString();
    for (const productId of d.productIds) {
      const done = await env.DB.prepare(`SELECT release_at FROM drop_releases WHERE product_id = ?1`).bind(productId).first<{ release_at: string }>();
      if (done?.release_at === releaseAt) continue;
      // Only the channels the product is on (or scheduled for) today: a drop
      // must never put a product on a channel Mickey has not chosen.
      const pubs = await adminGraphql<{ product: { resourcePublications: { nodes: { isPublished: boolean; publishDate: string | null; publication: { id: string } }[] } } | null }>(
        env,
        deps,
        `query ($id: ID!) { product(id: $id) { resourcePublications(first: 20, onlyPublished: false) { nodes { isPublished publishDate publication { id } } } } }`,
        { id: productId },
      );
      const publications = (pubs.product?.resourcePublications.nodes || []).filter((n) => n.isPublished || n.publishDate).map((n) => n.publication.id);
      if (!publications.length) continue;
      const un = await adminGraphql<{ publishableUnpublish: { userErrors: { message: string }[] } }>(
        env,
        deps,
        `mutation ($id: ID!, $input: [PublicationInput!]!) { publishableUnpublish(id: $id, input: $input) { userErrors { message } } }`,
        { id: productId, input: publications.map((publicationId) => ({ publicationId })) },
      );
      const pub = await adminGraphql<{ publishablePublish: { userErrors: { message: string }[] } }>(
        env,
        deps,
        `mutation ($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
        { id: productId, input: publications.map((publicationId) => ({ publicationId, publishDate: releaseAt })) },
      );
      const errs = [...un.publishableUnpublish.userErrors, ...pub.publishablePublish.userErrors];
      if (errs.length) throw new Error(`Shopify could not schedule ${productId}: ${errs.map((e) => e.message).join('; ')}`);
      await env.DB.prepare(
        `INSERT INTO drop_releases (product_id, drop_slug, release_at, scheduled_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (product_id) DO UPDATE SET drop_slug = excluded.drop_slug, release_at = excluded.release_at, scheduled_at = excluded.scheduled_at`,
      )
        .bind(productId, d.slug, releaseAt, iso(deps.now()))
        .run();
      scheduled.push(productId);
    }
  }
  return { scheduled };
}

/**
 * Every drop for the shop page: the current one first, then past (sold out)
 * drops, newest first. Each drop's products are the Shopify collection with
 * the drop's address as its handle (for example "drop-01").
 */
export async function shopDrops(env: Env, deps: Deps) {
  const drops = await listDrops(env, deps);
  const out = [];
  for (const d of drops) {
    const { quantity, left } = await dropStock(env, deps, d).catch(() => NO_STOCK(d));
    const status = await effectiveStatus(env, deps, d, left);
    out.push({
      drop: d.slug,
      name: d.name,
      statement: d.statement,
      status,
      dropDate: d.dropDate,
      quantity,
      left,
      detailsLine: detailsLineFor({ quantity, dropDate: d.dropDate }, status) || d.detailsLine,
      collection: d.slug,
      pledges: await dropPledges(env, d.slug),
    });
  }
  const cur = await findDrop(env, deps, null);
  const current = (cur && out.find((d) => d.drop === cur.slug)) || null;
  const past = out.filter((d) => d !== current && d.status === 'sold_out').sort((a, b) => String(b.dropDate).localeCompare(String(a.dropDate)));
  return { current, past };
}
