// The shop, run from this site. Shopify keeps the products, stock, checkout and
// fulfilment; Memberstack keeps the members. This file:
//
// - copies drops (Shopify collections with a drop date) and active products into
//   the Webflow Drops and Shop products collections, so the shop and product pages
//   are native Webflow pages (Shopify is the source of truth; nothing is typed twice);
// - answers a product page with what only Shopify knows live: sizes, stock and
//   whether this visitor can buy now;
// - starts checkout: the backend creates the Shopify cart (Storefront API, private
//   token), with the member's email filled in and the member on the order, and
//   enforces early access: Active members can buy EARLY_ACCESS_HOURS before a
//   drop, one of each piece, and everyone else from the drop date;
// - keeps "Notify me" with the member and emails them when they can buy.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, callUpstream, iso, sha256Hex } from '../http';
import type { Member } from '../identity';
import { enqueue, registerTask } from '../queue';
import { DEFAULT_ADMIN_API_VERSION, adminGraphql } from '../shopify';
import * as webflow from '../webflow';
import { earlyAccessAt, forgetDrops, listDrops, type Drop } from './drops';
import { ORDER_MEMBER_ATTRIBUTE, memberTag } from './order-member';

// ---------------------------------------------------------------------------
// Shopify → Webflow
// ---------------------------------------------------------------------------

interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  descriptionHtml: string | null;
  seo: { description: string | null } | null;
  edition: { value: string } | null;
  tracksInventory: boolean;
  totalInventory: number;
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
  media: { nodes: { preview: { image: { url: string; altText: string | null } | null } | null }[] };
}

interface ShopifyDrop {
  id: string;
  handle: string;
  title: string;
  description: string;
  image: { url: string; altText: string | null } | null;
  dropDate: { value: string } | null;
  /** The words across the home page hero; *word* marks the accent word. */
  heroHeadline: { value: string } | null;
  /** The hero photo: the home page shows the drop hero only once a drop has one. */
  heroImage: { reference: { image: { url: string; altText: string | null } | null } | null } | null;
  /** The piece the hero leads with (else the collection's first piece). */
  lead: { reference: { id: string } | null } | null;
  products: { nodes: { id: string }[] };
}

const PRODUCTS = `query ($cursor: String) { products(first: 50, after: $cursor, query: "status:active") {
  pageInfo { hasNextPage endCursor }
  nodes { id handle title status descriptionHtml seo { description } tracksInventory totalInventory
    edition: metafield(namespace: "custom", key: "edition_size") { value }
    priceRangeV2 { minVariantPrice { amount currencyCode } }
    media(first: 8) { nodes { preview { image { url altText } } } } } } }`;
const DROPS = `query { collections(first: 100) { nodes { id handle title description image { url altText }
  dropDate: metafield(namespace: "custom", key: "drop_date") { value }
  heroHeadline: metafield(namespace: "custom", key: "hero_headline") { value }
  heroImage: metafield(namespace: "custom", key: "hero_image") { reference { ... on MediaImage { image { url altText } } } }
  lead: metafield(namespace: "custom", key: "lead_product") { reference { ... on Product { id } } }
  products(first: 50) { nodes { id } } } } }`;

/** Plain text from Shopify's HTML, with a space wherever a paragraph or line ends. */
export function plainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortDescription(p: ShopifyProduct): string {
  const seo = p.seo?.description?.trim();
  if (seo) return seo.slice(0, 300);
  const text = p.descriptionHtml ? plainText(p.descriptionHtml) : '';
  if (text.length <= 160) return text;
  const cut = text.slice(0, 160);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 100 ? cut.lastIndexOf(' ') : 160).trim()}…`;
}

/** "$45" or "$45.50", in the shop's currency. */
export function priceText(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function editionSize(value: string | null | undefined): number | null {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const image = (i: { url: string; altText: string | null } | null | undefined, alt: string) => (i ? { url: i.url, alt: i.altText || alt } : null);

/**
 * The hero headline in three parts, so Webflow can set the accent word apart:
 * "Happiness is felt by making other people *happy*." → before "Happiness is
 * felt by making other people ", accent "happy", after ".". Without a marked
 * word the whole line is "before".
 */
export function splitHeadline(line: string): { before: string; accent: string; after: string } {
  const m = /^([^*]*)\*([^*]+)\*(.*)$/.exec(line.trim());
  if (!m) return { before: line.trim(), accent: '', after: '' };
  return { before: m[1], accent: m[2].trim(), after: m[3] };
}

/** A piece as the hero needs it: its page, name and price. */
interface Piece { productId: string; itemId: string; handle: string; title: string; price: string; left: number | null }

/** Pieces left of one product: its stock up to its edition size; null when stock isn't tracked. */
function piecesLeft(p: ShopifyProduct): number | null {
  if (!p.tracksInventory) return null;
  const stock = Math.max(0, p.totalInventory);
  const size = editionSize(p.edition?.value);
  return size === null ? stock : Math.min(stock, size);
}

function dropFields(d: ShopifyDrop, pieces: Piece[] | null) {
  const date = new Date(d.dropDate!.value).toISOString();
  const base = {
    name: d.title.slice(0, 256),
    slug: d.handle,
    'shopify-id': d.id,
    'drop-date': date,
    'early-access': earlyAccessAt(date),
    description: d.description || '',
    image: image(d.image, d.title),
  };
  if (!pieces) return base;
  const head = splitHeadline(d.heroHeadline?.value?.trim() || d.title);
  const leadId = d.lead?.reference?.id;
  const lead = pieces.find((p) => p.productId === leadId) || pieces[0] || null;
  // Sold out once every piece is counted and none is left.
  const soldOut = pieces.length > 0 && pieces.every((p) => p.left === 0);
  const heroImage = image(d.heroImage?.reference?.image, d.title);
  // Webflow shows or hides the home page parts with these (native conditional visibility).
  const heroOn = !!heroImage && !soldOut;
  return {
    ...base,
    'hero-before': head.before.slice(0, 256),
    'hero-accent': head.accent.slice(0, 256),
    'hero-after': head.after.slice(0, 256),
    'hero-image': heroImage,
    'lead-name': lead?.title.slice(0, 256) || '',
    'lead-price': lead?.price || '',
    'lead-slug': lead?.handle || '',
    pieces: pieces.map((p) => p.itemId),
    'piece-count': pieces.length,
    'sold-out': soldOut,
    open: !soldOut,
    'hero-on': heroOn,
    'hero-off': !heroOn,
  };
}

function productFields(p: ShopifyProduct, dropItemId: string | null) {
  const images = p.media.nodes.map((m) => m.preview?.image).filter((i): i is { url: string; altText: string | null } => !!i);
  return {
    name: p.title.slice(0, 256),
    slug: p.handle,
    'shopify-id': p.id,
    description: p.descriptionHtml || '',
    'short-description': shortDescription(p),
    image: image(images[0], p.title),
    gallery: images.slice(1).map((i) => image(i, p.title)),
    price: priceText(p.priceRangeV2.minVariantPrice.amount, p.priceRangeV2.minVariantPrice.currencyCode),
    'edition-size': editionSize(p.edition?.value),
    drop: dropItemId,
  };
}

interface SyncRow { shopify_id: string; cms_item_id: string | null; source_hash: string | null; state: string }

export interface ShopSyncResult { created: number; updated: number; unchanged: number; removed: number; errors: { item: string; error: string }[] }

async function fetchProducts(env: Env, deps: Deps): Promise<ShopifyProduct[]> {
  const all: ShopifyProduct[] = [];
  let cursor: string | null = null;
  do {
    const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProduct[] } } = await adminGraphql(env, deps, PRODUCTS, { cursor });
    all.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

async function itemsByShopifyId(env: Env, deps: Deps, collectionId: string) {
  const map = new Map<string, webflow.WebflowItem>();
  for (const i of await webflow.listAllItems(env, deps, collectionId)) {
    const sid = typeof i.fieldData?.['shopify-id'] === 'string' ? (i.fieldData['shopify-id'] as string) : '';
    if (sid) map.set(sid, i);
  }
  return map;
}

/**
 * Brings the Webflow Drops and Shop products collections in line with Shopify:
 * every drop and every active product is created or updated and published; the
 * rest are taken off the site (kept as drafts). Both Shopify lists load in full
 * before anything is taken off.
 */
export async function syncShop(env: Env, deps: Deps): Promise<ShopSyncResult> {
  const result: ShopSyncResult = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: [] };
  const dropsData = await adminGraphql<{ collections: { nodes: ShopifyDrop[] } }>(env, deps, DROPS);
  const products = await fetchProducts(env, deps);
  const drops = dropsData.collections.nodes.filter((c) => c.dropDate?.value && Number.isFinite(Date.parse(c.dropDate.value)));
  const rows = new Map(
    (await env.DB.prepare(`SELECT shopify_id, cms_item_id, source_hash, state FROM product_sync`).all<SyncRow>()).results.map((r) => [r.shopify_id, r]),
  );

  async function put(collectionId: string, shopifyId: string, label: string, fields: Record<string, unknown> & { name: string; slug: string }, existing: webflow.WebflowItem | undefined): Promise<string | null> {
    try {
      const hash = await sha256Hex(JSON.stringify(fields));
      const row = rows.get(shopifyId);
      if (existing && row?.source_hash === hash && row.state === 'live' && !existing.isDraft) {
        result.unchanged++;
        return existing.id;
      }
      let id: string;
      if (existing) {
        await webflow.updateAndPublishItem(env, deps, collectionId, existing.id, fields);
        id = existing.id;
        result.updated++;
      } else {
        id = (await webflow.createLiveItem(env, deps, collectionId, fields)).id;
        result.created++;
      }
      await saveRow(env, deps, shopifyId, id, hash, 'live');
      return id;
    } catch (e) {
      result.errors.push({ item: label, error: (e as Error).message.slice(0, 300) });
      return existing?.id ?? null;
    }
  }

  async function takeOff(collectionId: string, items: Map<string, webflow.WebflowItem>, keep: Set<string>) {
    for (const [sid, item] of items) {
      if (keep.has(sid)) continue;
      try {
        if (!item.isDraft) {
          await webflow.unpublishItem(env, deps, collectionId, item.id);
          result.removed++;
        }
        await saveRow(env, deps, sid, item.id, null, 'removed');
      } catch (e) {
        result.errors.push({ item: String(item.fieldData?.slug || sid), error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  // Products point at their drop, and a drop lists its pieces: a new drop is
  // created first with its own fields, then the products, then every drop in full.
  const dropItems = await itemsByShopifyId(env, deps, CMS.drops.id);
  const dropItemId = new Map<string, string>();
  for (const d of drops) {
    const existing = dropItems.get(d.id);
    if (existing) { dropItemId.set(d.id, existing.id); continue; }
    try {
      const created = await webflow.createLiveItem(env, deps, CMS.drops.id, dropFields(d, null));
      dropItemId.set(d.id, created.id);
      dropItems.set(d.id, { ...created, isDraft: false } as webflow.WebflowItem);
      result.created++;
    } catch (e) {
      result.errors.push({ item: d.handle, error: (e as Error).message.slice(0, 300) });
    }
  }
  const dropItemOfProduct = new Map<string, string>();
  for (const d of drops) {
    const id = dropItemId.get(d.id);
    if (id) for (const p of d.products.nodes) if (!dropItemOfProduct.has(p.id)) dropItemOfProduct.set(p.id, id);
  }
  const productItems = await itemsByShopifyId(env, deps, CMS.products.id);
  const pieceOf = new Map<string, Piece>();
  for (const p of products) {
    const fields = productFields(p, dropItemOfProduct.get(p.id) ?? null);
    const itemId = await put(CMS.products.id, p.id, p.handle, fields, productItems.get(p.id));
    if (itemId) pieceOf.set(p.id, { productId: p.id, itemId, handle: p.handle, title: p.title, price: fields.price, left: piecesLeft(p) });
  }
  for (const d of drops) {
    if (!dropItemId.has(d.id)) continue;
    const pieces = d.products.nodes.map((n) => pieceOf.get(n.id)).filter((x): x is Piece => !!x);
    await put(CMS.drops.id, d.id, d.handle, dropFields(d, pieces), dropItems.get(d.id));
  }

  await takeOff(CMS.drops.id, dropItems, new Set(drops.map((d) => d.id)));
  await takeOff(CMS.products.id, productItems, new Set(products.map((p) => p.id)));
  await forgetDrops(env);
  return result;
}

async function saveRow(env: Env, deps: Deps, shopifyId: string, itemId: string | null, hash: string | null, state: 'live' | 'removed') {
  await env.DB.prepare(
    `INSERT INTO product_sync (shopify_id, cms_item_id, source_hash, state, synced_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (shopify_id) DO UPDATE SET cms_item_id = excluded.cms_item_id, source_hash = excluded.source_hash, state = excluded.state, synced_at = excluded.synced_at`,
  )
    .bind(shopifyId, itemId, hash, state, iso(deps.now()))
    .run();
}

/** A product or collection changed in Shopify: sync once, shortly after (several webhooks in a minute become one). */
export function queueShopSync(env: Env, deps: Deps) {
  return enqueue(env, deps, `shop-sync:${iso(deps.now()).slice(0, 16)}`, { op: 'task', name: 'shop.sync', target: 'webflow', args: {} });
}
registerTask('shop.sync', async (env, deps) => {
  const r = await syncShop(env, deps);
  if (r.errors.length) throw new Error(`Shop sync: ${r.errors.length} item(s) failed: ${r.errors.map((e) => `${e.item}: ${e.error}`).join('; ').slice(0, 500)}`);
  return 'ok';
});

// ---------------------------------------------------------------------------
// A product, live: sizes, stock and whether this visitor can buy
// ---------------------------------------------------------------------------

export type SaleStatus = 'upcoming' | 'early' | 'live' | 'sold_out' | 'not_for_sale';

interface LiveProduct {
  id: string;
  handle: string;
  status: string;
  tracksInventory: boolean;
  totalInventory: number;
  edition: { value: string } | null;
  variants: { nodes: { id: string; title: string; availableForSale: boolean; inventoryQuantity: number | null; price: string }[] };
}

async function liveProduct(env: Env, deps: Deps, handle: string): Promise<LiveProduct | null> {
  const r = await adminGraphql<{ productByIdentifier: LiveProduct | null }>(
    env,
    deps,
    `query ($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id handle status tracksInventory totalInventory
      edition: metafield(namespace: "custom", key: "edition_size") { value }
      variants(first: 30) { nodes { id title availableForSale inventoryQuantity price } } } }`,
    { handle },
  );
  return r.productByIdentifier;
}

function dropOf(drops: Drop[], productId: string): Drop | null {
  return drops.find((d) => d.productIds.includes(productId)) || null;
}

/** Where a product stands now, from its drop's dates and its stock. */
export function saleStatus(now: number, drop: Drop | null, left: number | null, active: boolean): SaleStatus {
  if (!active) return 'not_for_sale';
  if (left === 0) return 'sold_out';
  if (drop?.dropDate) {
    const at = Date.parse(drop.dropDate);
    if (now < Date.parse(earlyAccessAt(drop.dropDate))) return 'upcoming';
    if (now < at) return 'early';
  }
  return 'live';
}

async function boughtBefore(env: Env, memberId: number, productId: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 FROM pledges WHERE member_id = ?1 AND product_id = ?2 AND status != 'cancelled' LIMIT 1`).bind(memberId, productId).first();
  return !!r;
}

async function isActive(env: Env, memberId: number): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT active FROM members WHERE id = ?1`).bind(memberId).first<{ active: number }>();
  return r?.active === 1;
}

/** What the visitor may do now: buy, wait for early access or the drop, or nothing. */
async function access(env: Env, status: SaleStatus, member: Member | null, productId: string) {
  if (status === 'live') return { canBuy: true, reason: null };
  if (status !== 'early') return { canBuy: false, reason: status };
  if (!member) return { canBuy: false, reason: 'early_sign_in' };
  if (!(await isActive(env, member.id))) return { canBuy: false, reason: 'early_not_active' };
  if (await boughtBefore(env, member.id, productId)) return { canBuy: false, reason: 'early_one_each' };
  return { canBuy: true, reason: null };
}

/** GET /api/shop/products/:handle — the live part of a product page. */
export async function productState(env: Env, deps: Deps, handle: string, member: Member | null) {
  const p = await liveProduct(env, deps, handle);
  if (!p) throw new HttpError(404, 'product_not_found', 'err-product-not-found');
  const drop = dropOf(await listDrops(env, deps), p.id);
  const size = editionSize(p.edition?.value);
  const stock = p.tracksInventory ? Math.max(0, p.totalInventory) : null;
  const left = stock === null ? null : size === null ? stock : Math.min(stock, size);
  const status = saleStatus(deps.now().getTime(), drop, left, p.status === 'ACTIVE');
  const me = await access(env, status, member, p.id);
  const notified = member && drop ? !!(await env.DB.prepare(`SELECT 1 FROM drop_notify WHERE member_id = ?1 AND drop_slug = ?2`).bind(member.id, drop.slug).first()) : false;
  return {
    product: p.handle,
    status,
    edition: size,
    left,
    drop: drop ? { slug: drop.slug, name: drop.name, dropDate: drop.dropDate, earlyAt: drop.dropDate ? earlyAccessAt(drop.dropDate) : null } : null,
    variants: p.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      available: v.availableForSale && (v.inventoryQuantity === null || v.inventoryQuantity > 0 || !p.tracksInventory),
    })),
    canBuy: me.canBuy,
    reason: me.reason,
    notified,
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function storefront<T>(env: Env, deps: Deps, query: string, variables: Record<string, unknown>, buyerIp: string | null): Promise<T> {
  if (!env.SHOPIFY_STOREFRONT_TOKEN) throw new HttpError(409, 'shop_not_ready', 'err-shop-not-ready');
  const version = env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_ADMIN_API_VERSION;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Shopify-Storefront-Private-Token': env.SHOPIFY_STOREFRONT_TOKEN };
  if (buyerIp) headers['Shopify-Storefront-Buyer-IP'] = buyerIp;
  const res = await callUpstream(deps.fetch, 'shopify', `https://${env.SHOPIFY_STORE_DOMAIN}/api/${version}/graphql.json`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !body?.data) throw new Error(`Shopify Storefront ${res.status}: ${(body?.errors || []).map((e) => e.message).join('; ').slice(0, 300)}`);
  return body.data;
}

/**
 * POST /api/shop/checkout {variant}: a Shopify checkout for one piece. During
 * early access only Active members get one, once per piece. Signed-in buyers get
 * their email filled in and their account on the order (the pledge joins it).
 */
export async function startCheckout(env: Env, deps: Deps, member: Member | null, body: { variant?: unknown }, buyerIp: string | null) {
  const variant = typeof body.variant === 'string' && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(body.variant) ? body.variant : null;
  if (!variant) throw new HttpError(400, 'invalid_variant', 'err-invalid-variant');
  const v = await adminGraphql<{ productVariant: { id: string; product: { handle: string } } | null }>(
    env,
    deps,
    `query ($id: ID!) { productVariant(id: $id) { id product { handle } } }`,
    { id: variant },
  );
  if (!v.productVariant) throw new HttpError(404, 'product_not_found', 'err-product-not-found');
  const state = await productState(env, deps, v.productVariant.product.handle, member);
  if (!state.canBuy) throw new HttpError(403, `cannot_buy_${state.reason}`, 'err-buy-' + String(state.reason).replace(/_/g, '-'));
  if (!state.variants.some((x) => x.id === variant && x.available)) throw new HttpError(409, 'sold_out', 'err-buy-sold-out');

  const email = member ? (await env.DB.prepare(`SELECT email FROM members WHERE id = ?1`).bind(member.id).first<{ email: string | null }>())?.email : null;
  const input: Record<string, unknown> = { lines: [{ merchandiseId: variant, quantity: 1 }] };
  if (member) input.attributes = [{ key: ORDER_MEMBER_ATTRIBUTE, value: await memberTag(env, member.id) }];
  if (email) input.buyerIdentity = { email };
  const r = await storefront<{ cartCreate: { cart: { id: string; checkoutUrl: string } | null; userErrors: { message: string }[] } }>(
    env,
    deps,
    `mutation ($input: CartInput!) { cartCreate(input: $input) { cart { id checkoutUrl } userErrors { message } } }`,
    { input },
    buyerIp,
  );
  if (!r.cartCreate.cart) throw new Error(`Shopify cart: ${r.cartCreate.userErrors.map((e) => e.message).join('; ')}`);
  await env.DB.prepare(`INSERT INTO checkouts (member_id, variant_id, product_handle, status_at_start, cart_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(member?.id ?? null, variant, state.product, state.status, r.cartCreate.cart.id, iso(deps.now()))
    .run();
  return { checkoutUrl: r.cartCreate.cart.checkoutUrl };
}

// ---------------------------------------------------------------------------
// Notify me
// ---------------------------------------------------------------------------

async function knownDrop(env: Env, deps: Deps, slug: unknown): Promise<Drop> {
  const s = typeof slug === 'string' ? slug : '';
  const d = (await listDrops(env, deps)).find((x) => x.slug === s);
  if (!d) throw new HttpError(404, 'drop_not_found', 'err-drop-not-found');
  return d;
}

/** POST /api/shop/notify {drop, on}: tell me when I can buy this drop (or stop). */
export async function setNotify(env: Env, deps: Deps, member: Member, body: { drop?: unknown; on?: unknown }) {
  const d = await knownDrop(env, deps, body.drop);
  if (body.on === false) {
    await env.DB.prepare(`DELETE FROM drop_notify WHERE member_id = ?1 AND drop_slug = ?2`).bind(member.id, d.slug).run();
    return { drop: d.slug, notified: false };
  }
  await env.DB.prepare(`INSERT INTO drop_notify (member_id, drop_slug, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (member_id, drop_slug) DO NOTHING`)
    .bind(member.id, d.slug, iso(deps.now()))
    .run();
  return { drop: d.slug, notified: true };
}

/** Resend template for "You can buy now": variables DROP, URL, EARLY ("yes" for early access). */
export const DROP_OPEN_TEMPLATE = 'hf-drop-open';

/**
 * Every tick: once early access opens, Active members who asked are emailed;
 * once the drop opens to everyone, the rest are. Each member once per drop.
 */
export async function dropNotifications(env: Env, deps: Deps, baseUrl: string) {
  const now = deps.now().getTime();
  const site = baseUrl.replace(/\/join$/, '');
  let sent = 0;
  for (const d of await listDrops(env, deps)) {
    if (!d.dropDate) continue;
    const earlyOpen = now >= Date.parse(earlyAccessAt(d.dropDate));
    const open = now >= Date.parse(d.dropDate);
    if (!earlyOpen) continue;
    const due = await env.DB.prepare(
      `SELECT n.member_id AS id, m.email, m.active FROM drop_notify n JOIN members m ON m.id = n.member_id
       WHERE n.drop_slug = ?1 AND n.notified_at IS NULL AND m.email IS NOT NULL AND m.deleted_at IS NULL AND (?2 = 1 OR m.active = 1) LIMIT 100`,
    )
      .bind(d.slug, open ? 1 : 0)
      .all<{ id: number; email: string; active: number }>();
    for (const m of due.results) {
      const early = !open && m.active === 1;
      await env.DB.batch([
        enqueue(env, deps, `drop-open:${d.slug}:${m.id}`, {
          op: 'email.send',
          message: { to: m.email, template: { id: DROP_OPEN_TEMPLATE, variables: { DROP: d.name, URL: `${site}/shop`, EARLY: early ? 'yes' : 'no' } }, tags: [{ name: 'kind', value: 'drop_open' }] },
        }, m.id),
        env.DB.prepare(`UPDATE drop_notify SET notified_at = ?3 WHERE member_id = ?1 AND drop_slug = ?2`).bind(m.id, d.slug, iso(deps.now())),
      ]);
      sent++;
    }
  }
  return { sent };
}
