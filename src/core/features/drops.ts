// "Notify me when this drop goes live". Shopify is the home for these
// sign-ups (native email marketing): the backend adds the person as a
// Shopify customer with email-marketing consent and a tag for the drop, and
// Mickey emails that tag from Shopify Email when the drop goes live. The
// backend keeps only a one-way hash per drop, for counting.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso, sha256Hex } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { adminGraphql } from '../shopify';
import * as webflow from '../webflow';
import { siteWording, word, type Wording } from '../wording';
import { dropPledges } from './pledges';

export interface Drop {
  id: string;
  slug: string;
  name: string;
  status: 'upcoming' | 'live' | 'sold_out' | 'unknown';
  onFrontPage: boolean;
  dropDate: string | null;
  quantity: number | null;
  detailsLine: string;
  statement: string;
  leadProductItemId: string | null;
  productItemIds: string[];
}

const CACHE_KEY = 'drops:list';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function statusOf(id: unknown): Drop['status'] {
  if (id === CMS.drops.status.upcoming) return 'upcoming';
  if (id === CMS.drops.status.live) return 'live';
  if (id === CMS.drops.status.soldOut) return 'sold_out';
  return 'unknown';
}

export async function listDrops(env: Env, deps: Deps): Promise<Drop[]> {
  const cached = (await env.CACHE.get(CACHE_KEY, 'json')) as Drop[] | null;
  if (cached) return cached;
  const items = await webflow.listLiveItems(env, deps, CMS.drops.id);
  const drops: Drop[] = items.map((i) => ({
    id: i.id,
    slug: String(i.fieldData.slug || ''),
    name: String(i.fieldData.name || ''),
    status: statusOf(i.fieldData.status),
    onFrontPage: i.fieldData['show-on-front-page'] === true,
    dropDate: typeof i.fieldData['drop-date'] === 'string' ? (i.fieldData['drop-date'] as string) : null,
    quantity: typeof i.fieldData.quantity === 'number' ? (i.fieldData.quantity as number) : null,
    detailsLine: String(i.fieldData['details-line'] || ''),
    statement: String(i.fieldData.statement || ''),
    leadProductItemId: typeof i.fieldData['lead-product'] === 'string' ? (i.fieldData['lead-product'] as string) : null,
    productItemIds: [
      ...new Set([
        ...(typeof i.fieldData['lead-product'] === 'string' ? [i.fieldData['lead-product'] as string] : []),
        ...(Array.isArray(i.fieldData['products-in-this-drop']) ? (i.fieldData['products-in-this-drop'] as string[]) : []),
      ]),
    ],
  }));
  await env.CACHE.put(CACHE_KEY, JSON.stringify(drops), { expirationTtl: 300 });
  return drops;
}

export async function forgetDrops(env: Env): Promise<void> {
  await env.CACHE.delete(CACHE_KEY);
  await env.CACHE.delete('shop:catalog');
  await env.CACHE.delete('product-labels');
}

/** The drop named by its address, or the one shown on the front page. */
export async function findDrop(env: Env, deps: Deps, slug: string | null): Promise<Drop | null> {
  const drops = await listDrops(env, deps);
  if (slug) return drops.find((d) => d.slug === slug) || null;
  return drops.find((d) => d.onFrontPage) || drops.find((d) => d.status === 'upcoming') || null;
}

export const dropTag = (slug: string) => `notify-drop-${slug}`.slice(0, 40);

export async function signUpForDrop(env: Env, deps: Deps, input: { drop?: unknown; email?: unknown }, member: Member | null) {
  const slug = typeof input.drop === 'string' && /^[a-z0-9-]{1,100}$/.test(input.drop) ? input.drop : null;
  const drop = await findDrop(env, deps, slug);
  if (!drop) throw new HttpError(404, 'drop_not_found', 'err-drop-not-found');
  if ((await effectiveStatus(env, deps, drop)) !== 'upcoming') {
    throw new HttpError(409, 'drop_not_upcoming', drop.status === 'live' ? 'err-drop-live' : 'err-drop-closed');
  }
  const email = (member?.email || (typeof input.email === 'string' ? input.email : '')).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'err-invalid-email');

  const hash = await sha256Hex(`drop-signup|${env.LINK_SECRET}|${email}`);
  const now = iso(deps.now());
  const inserted = await env.DB.prepare(
    `INSERT INTO drop_signups (drop_slug, email_hash, member_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (drop_slug, email_hash) DO NOTHING`,
  )
    .bind(drop.slug, hash, member?.id ?? null, now)
    .run();
  if (inserted.meta.changes) {
    await enqueue(env, deps, `drop-signup:${drop.slug}:${hash.slice(0, 32)}`, {
      op: 'shopify.dropSignup',
      email,
      firstName: member?.first_name || null,
      tag: dropTag(drop.slug),
    }).run();
  }
  return { drop: drop.slug, name: drop.name, alreadySignedUp: !inserted.meta.changes };
}

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

async function shopifyIdOf(env: Env, cmsItemId: string | null): Promise<string | null> {
  if (!cmsItemId) return null;
  const r = await env.DB.prepare(`SELECT shopify_id FROM product_sync WHERE cms_item_id = ?1`).bind(cmsItemId).first<{ shopify_id: string }>();
  return r?.shopify_id ?? null;
}

export interface DropStock {
  /** Pieces in the drop: the pieces' edition sizes added up, or the CMS Quantity when a piece has no size. */
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
  const ids = (await Promise.all(drop.productItemIds.map((item) => shopifyIdOf(env, item)))).filter((id): id is string => !!id);
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

/** "100 pieces. Drops December 5 at 12:00 ET. Gone when they're gone.", worded in Webflow ("details-..." keys). */
export function detailsLineFor(drop: Pick<Drop, 'quantity' | 'dropDate'>, status: Drop['status'], w: Wording): string | null {
  if (!drop.quantity || !drop.dropDate) return null;
  const d = new Date(drop.dropDate);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const key = status === 'sold_out' ? 'details-sold-out' : status === 'live' ? 'details-live' : 'details-upcoming';
  return word(w, key, { n: drop.quantity, day, time }) || null;
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
    detailsLine: detailsLineFor({ quantity, dropDate: drop.dropDate }, status, await siteWording(env, deps)) || drop.detailsLine,
    pledges: await dropPledges(env, drop.slug),
  };
}

const STATUS_ID: Record<Exclude<Drop['status'], 'unknown'>, string> = {
  upcoming: CMS.drops.status.upcoming,
  live: CMS.drops.status.live,
  sold_out: CMS.drops.status.soldOut,
};

/**
 * Every tick: keeps each drop's Status and Details line in the CMS in step
 * with its date, quantity and stock, so the page is right even without
 * scripts and Mickey only sets the date, quantity and products.
 */
export async function updateDropsInCms(env: Env, deps: Deps) {
  await forgetDrops(env);
  const drops = await listDrops(env, deps);
  const changed: string[] = [];
  for (const d of drops) {
    if (!d.dropDate) continue;
    const { quantity, left } = await dropStock(env, deps, d).catch(() => NO_STOCK(d));
    const status = await effectiveStatus(env, deps, d, left);
    if (status === 'unknown') continue;
    const line = detailsLineFor({ quantity, dropDate: d.dropDate }, status, await siteWording(env, deps));
    const fieldData: Record<string, unknown> = {};
    if (d.status !== status) fieldData.status = STATUS_ID[status];
    if (line && line !== d.detailsLine) fieldData['details-line'] = line;
    if (!Object.keys(fieldData).length) continue;
    await webflow.updateLiveItem(env, deps, CMS.drops.id, d.id, fieldData);
    changed.push(d.slug);
  }
  if (changed.length) await forgetDrops(env);
  return { changed };
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
    for (const item of d.productItemIds) {
      const productId = await shopifyIdOf(env, item);
      if (!productId) continue;
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
      detailsLine: detailsLineFor({ quantity, dropDate: d.dropDate }, status, await siteWording(env, deps)) || d.detailsLine,
      onFrontPage: d.onFrontPage,
      collection: d.slug,
      pledges: await dropPledges(env, d.slug),
    });
  }
  const current = out.find((d) => d.onFrontPage && d.status !== 'sold_out') || out.find((d) => d.status === 'upcoming' || d.status === 'live') || null;
  const past = out.filter((d) => d !== current && d.status === 'sold_out').sort((a, b) => String(b.dropDate).localeCompare(String(a.dropDate)));
  return { current, past };
}

/**
 * The facts behind each product's scarcity label, by handle. True and specific
 * only; the site words them with the label texts in Webflow's footer
 * (for example "Drop 01 · 64 of 100 left" or "Limited edition · 250 pieces"):
 *   drop pieces          name = the drop's name, size = the piece's edition size
 *   limited editions     name = null, size = Shopify field custom.edition_size
 *   everything else      no label
 * Cached for 60 seconds.
 */
export interface ProductLabel {
  name: string | null;
  size: number | null;
  left: number | null;
  soldOut: boolean;
}

export async function productLabels(env: Env, deps: Deps): Promise<Record<string, ProductLabel>> {
  const cached = (await env.CACHE.get('product-labels', 'json')) as Record<string, ProductLabel> | null;
  if (cached) return cached;
  const r = await adminGraphql<{
    products: { nodes: { id: string; handle: string; tracksInventory: boolean; totalInventory: number; edition: { value: string } | null }[] };
  }>(
    env,
    deps,
    `query { products(first: 100, query: "status:active") { nodes { id handle tracksInventory totalInventory edition: metafield(namespace: "custom", key: "edition_size") { value } } } }`,
  );
  const drops = await listDrops(env, deps);
  const sync = await env.DB.prepare(`SELECT shopify_id, cms_item_id FROM product_sync WHERE cms_item_id IS NOT NULL`).all<{ shopify_id: string; cms_item_id: string }>();
  const dropOf = new Map<string, Drop>();
  const byItem = new Map(sync.results.map((s) => [s.cms_item_id, s.shopify_id]));
  for (const d of drops) for (const item of d.productItemIds) if (byItem.get(item) && !dropOf.has(byItem.get(item)!)) dropOf.set(byItem.get(item)!, d);
  const labels: Record<string, ProductLabel> = {};
  for (const p of r.products.nodes) {
    const left = p.tracksInventory ? Math.max(0, p.totalInventory) : null;
    const size = editionSize(p.edition?.value);
    const d = dropOf.get(p.id);
    if (d) {
      // Each piece with its own size; a one-piece drop without a size uses the drop's Quantity.
      const pieces = size ?? (d.productItemIds.length === 1 ? d.quantity : null);
      const status = await effectiveStatus(env, deps, d);
      const soldOut = status === 'sold_out' || (status === 'live' && left === 0);
      labels[p.handle] = { name: d.name, size: pieces, left: !soldOut && status === 'live' && left !== null && pieces ? Math.min(left, pieces) : null, soldOut };
      continue;
    }
    if (size !== null) {
      labels[p.handle] = { name: null, size, left: left !== null && left > 0 && left < size ? left : null, soldOut: left === 0 };
    }
  }
  await env.CACHE.put('product-labels', JSON.stringify(labels), { expirationTtl: 60 });
  return labels;
}

// ---------------------------------------------------------------------------
// The whole shop in one answer, so the page can draw it at once: the current
// drop, "Available now" and past drops, each with its products (from the
// Shopify collection with the drop's address, or "available-now"), labels
// included. Empty sections are left out. Cached for 60 seconds, and cleared
// when a product or drop changes.
// ---------------------------------------------------------------------------

export const SHOP_CACHE = 'shop:catalog';
export const AVAILABLE_NOW = 'available-now';

interface ShopProduct {
  handle: string;
  title: string;
  image: { url: string; alt: string } | null;
  price: { amount: string; currencyCode: string } | null;
  available: boolean;
  label: ProductLabel | null;
}

async function collectionProducts(env: Env, deps: Deps, handle: string): Promise<Omit<ShopProduct, 'label'>[]> {
  const r = await adminGraphql<{
    collections: {
      nodes: {
        products: {
          nodes: {
            handle: string;
            title: string;
            status: string;
            featuredMedia: { preview: { image: { url: string; altText: string | null } | null } | null } | null;
            priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } } | null;
            variants: { nodes: { availableForSale: boolean }[] };
          }[];
        };
      }[];
    };
  }>(
    env,
    deps,
    `query ($q: String!) { collections(first: 1, query: $q) { nodes { products(first: 48, sortKey: COLLECTION_DEFAULT) { nodes {
       handle title status featuredMedia { preview { image { url altText } } } priceRangeV2 { minVariantPrice { amount currencyCode } }
       variants(first: 20) { nodes { availableForSale } } } } } } }`,
    { q: `handle:${handle}` },
  );
  const c = r.collections.nodes[0];
  if (!c) return [];
  return c.products.nodes
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => ({
      handle: p.handle,
      title: p.title,
      image: p.featuredMedia?.preview?.image ? { url: p.featuredMedia.preview.image.url, alt: p.featuredMedia.preview.image.altText || p.title } : null,
      price: p.priceRangeV2?.minVariantPrice || null,
      available: p.variants.nodes.some((v) => v.availableForSale),
    }));
}

const SHOP_FRESH_MS = 60_000;

async function buildShopCatalog(env: Env, deps: Deps) {
  const { current, past } = await shopDrops(env, deps);
  const labels = await productLabels(env, deps).catch(() => ({}) as Record<string, ProductLabel>);
  const withLabels = (list: Omit<ShopProduct, 'label'>[]): ShopProduct[] => list.map((p) => ({ ...p, label: labels[p.handle] || null }));
  const out = {
    current: current ? { ...current, products: withLabels(await collectionProducts(env, deps, current.collection)) } : null,
    availableNow: withLabels(await collectionProducts(env, deps, AVAILABLE_NOW)),
    past: [] as unknown[],
  };
  for (const d of past) out.past.push({ ...d, products: withLabels(await collectionProducts(env, deps, d.collection)) });
  await env.CACHE.put(SHOP_CACHE, JSON.stringify({ at: deps.now().getTime(), data: out }), { expirationTtl: 86_400 });
  return out;
}

/**
 * The shop, always answered at once: a copy younger than a minute is served
 * as it is; an older copy is served too while a fresh one is made in the
 * background (`later`). Only the very first visit, or the first after a
 * product or drop changed, waits for Shopify.
 */
export async function shopCatalog(env: Env, deps: Deps, later?: (p: Promise<unknown>) => void) {
  const cached = (await env.CACHE.get(SHOP_CACHE, 'json')) as { at: number; data: unknown } | null;
  if (cached && cached.data) {
    if (deps.now().getTime() - cached.at > SHOP_FRESH_MS) {
      const refresh = buildShopCatalog(env, deps).catch(() => undefined);
      if (later) later(refresh);
      else await refresh;
    }
    return cached.data;
  }
  return buildShopCatalog(env, deps);
}

/** Run by the timer so the stored copy stays fresh even when nobody visits. */
export async function warmShop(env: Env, deps: Deps) {
  await buildShopCatalog(env, deps);
  return { warmed: true };
}

/** A product or drop changed: the shop and labels are worked out again on the next visit. */
export async function forgetShop(env: Env): Promise<void> {
  await env.CACHE.delete(SHOP_CACHE);
  await env.CACHE.delete('product-labels');
}
