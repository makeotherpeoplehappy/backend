// Shopify → Webflow product sync. Shopify is the source of truth for each
// product's name, address (its handle, which the product page uses to load
// live price and stock), description, short description and image. Fields
// set by hand in Webflow, such as "Goes with these actions", are never
// touched. Active products are published; archived, draft or deleted ones
// are taken off the site and kept as drafts, so references to them stay.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { iso, sha256Hex } from '../http';
import { adminGraphql, customerGid } from '../shopify';
import * as webflow from '../webflow';

const FIELDS = `id handle title status descriptionHtml description
  seo { description }
  featuredMedia { preview { image { url altText } } }`;
const PAGE_QUERY = `query ($cursor: String) { products(first: 50, after: $cursor, query: "status:active") { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;
const ONE_QUERY = `query ($id: ID!) { product(id: $id) { ${FIELDS} } }`;

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  descriptionHtml: string | null;
  description: string | null;
  seo: { description: string | null } | null;
  featuredMedia: { preview: { image: { url: string; altText: string | null } | null } | null } | null;
}

export interface ProductSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: { product: string; error: string }[];
}

export const productGid = (id: string | number) => {
  const s = String(id);
  return s.startsWith('gid://') ? s : `gid://shopify/Product/${s}`;
};

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
  // Shopify's own plain-text description runs paragraphs together, so the
  // text is taken from the HTML instead.
  const text = p.descriptionHtml ? plainText(p.descriptionHtml) : (p.description || '').replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  const cut = text.slice(0, 160);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 100 ? cut.lastIndexOf(' ') : 160).trim()}…`;
}

function fieldsFor(p: ShopifyProduct) {
  const image = p.featuredMedia?.preview?.image;
  return {
    name: p.title.slice(0, 256),
    slug: p.handle,
    'shopify-id': p.id,
    description: p.descriptionHtml || '',
    'short-description': shortDescription(p),
    image: image ? { url: image.url, alt: image.altText || p.title } : null,
  };
}

async function fetchActiveProducts(env: Env, deps: Deps): Promise<ShopifyProduct[]> {
  const all: ShopifyProduct[] = [];
  let cursor: string | null = null;
  do {
    const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProduct[] } } = await adminGraphql(env, deps, PAGE_QUERY, { cursor });
    all.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

interface SyncRow {
  shopify_id: string;
  cms_item_id: string | null;
  source_hash: string | null;
  state: string;
}

async function saveRow(env: Env, deps: Deps, shopifyId: string, itemId: string | null, hash: string | null, state: 'live' | 'removed') {
  await env.DB.prepare(
    `INSERT INTO product_sync (shopify_id, cms_item_id, source_hash, state, synced_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (shopify_id) DO UPDATE SET cms_item_id = excluded.cms_item_id, source_hash = excluded.source_hash, state = excluded.state, synced_at = excluded.synced_at`,
  )
    .bind(shopifyId, itemId, hash, state, iso(deps.now()))
    .run();
}

/** Writes one active product to Webflow: creates, updates or leaves it. */
async function upsert(
  env: Env,
  deps: Deps,
  p: ShopifyProduct,
  existing: webflow.WebflowItem | undefined,
  row: SyncRow | undefined,
  result: ProductSyncResult,
) {
  const fields = fieldsFor(p);
  const hash = await sha256Hex(JSON.stringify(fields));
  if (existing && row?.source_hash === hash && row.state === 'live' && !existing.isDraft) {
    result.unchanged++;
    return;
  }
  if (existing) {
    await webflow.updateAndPublishItem(env, deps, CMS.products.id, existing.id, fields);
    await saveRow(env, deps, p.id, existing.id, hash, 'live');
    result.updated++;
  } else {
    const item = await webflow.createLiveItem(env, deps, CMS.products.id, fields);
    await saveRow(env, deps, p.id, item.id, hash, 'live');
    result.created++;
  }
}

async function remove(env: Env, deps: Deps, shopifyId: string, item: webflow.WebflowItem | undefined, result: ProductSyncResult) {
  if (item && !item.isDraft) {
    await webflow.unpublishItem(env, deps, CMS.products.id, item.id);
    result.removed++;
  }
  await saveRow(env, deps, shopifyId, item?.id ?? null, null, 'removed');
}

async function cmsItemsByShopifyId(env: Env, deps: Deps): Promise<Map<string, webflow.WebflowItem>> {
  const items = await webflow.listAllItems(env, deps, CMS.products.id);
  const map = new Map<string, webflow.WebflowItem>();
  for (const i of items) {
    const sid = typeof i.fieldData?.['shopify-id'] === 'string' ? (i.fieldData['shopify-id'] as string) : '';
    if (sid) map.set(sid, i);
  }
  return map;
}

async function rowsById(env: Env): Promise<Map<string, SyncRow>> {
  const rows = await env.DB.prepare(`SELECT shopify_id, cms_item_id, source_hash, state FROM product_sync`).all<SyncRow>();
  return new Map(rows.results.map((r) => [r.shopify_id, r]));
}

/** Full sync: every active Shopify product, and removal of the rest. */
export async function syncAllProducts(env: Env, deps: Deps): Promise<ProductSyncResult> {
  const result: ProductSyncResult = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: [] };
  // Both lists must load completely before anything is removed.
  const products = await fetchActiveProducts(env, deps);
  const items = await cmsItemsByShopifyId(env, deps);
  const rows = await rowsById(env);
  const active = new Set(products.map((p) => p.id));

  for (const p of products) {
    try {
      await upsert(env, deps, p, items.get(p.id), rows.get(p.id), result);
    } catch (e) {
      result.errors.push({ product: p.handle, error: (e as Error).message.slice(0, 300) });
    }
  }
  for (const [shopifyId, item] of items) {
    if (active.has(shopifyId)) continue;
    try {
      await remove(env, deps, shopifyId, item, result);
    } catch (e) {
      result.errors.push({ product: String(item.fieldData?.slug || shopifyId), error: (e as Error).message.slice(0, 300) });
    }
  }
  return result;
}

/** Sync for one product, used by Shopify webhooks. */
export async function syncOneProduct(env: Env, deps: Deps, id: string | number, deleted = false): Promise<ProductSyncResult> {
  const result: ProductSyncResult = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: [] };
  const gid = productGid(id);
  const items = await cmsItemsByShopifyId(env, deps);
  const rows = await rowsById(env);
  let product: ShopifyProduct | null = null;
  if (!deleted) {
    const data = await adminGraphql<{ product: ShopifyProduct | null }>(env, deps, ONE_QUERY, { id: gid });
    product = data.product;
  }
  if (product && product.status === 'ACTIVE') await upsert(env, deps, product, items.get(gid), rows.get(gid), result);
  else await remove(env, deps, gid, items.get(gid), result);
  return result;
}

// ---------------------------------------------------------------------------
// Shopify webhook subscriptions for this backend.
// ---------------------------------------------------------------------------

const TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'CUSTOMERS_DELETE'] as const;

/** Makes sure Shopify sends product and customer-deletion events to this backend. */
export async function ensureShopifyWebhooks(env: Env, deps: Deps, callbackUrl: string) {
  const existing = await adminGraphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri?: string | null }[] } }>(
    env,
    deps,
    `query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  );
  const have = new Set(existing.webhookSubscriptions.nodes.filter((n) => n.uri === callbackUrl).map((n) => n.topic));
  const created: string[] = [];
  const errors: string[] = [];
  for (const topic of TOPICS) {
    if (have.has(topic)) continue;
    const r = await adminGraphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
      env,
      deps,
      `mutation ($topic: WebhookSubscriptionTopic!, $uri: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { userErrors { message } }
      }`,
      { topic, uri: callbackUrl },
    );
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs.length) errors.push(`${topic}: ${errs.map((e) => e.message).join('; ')}`);
    else created.push(topic);
  }
  return { callbackUrl, alreadyThere: [...have], created, errors };
}

export { customerGid };
