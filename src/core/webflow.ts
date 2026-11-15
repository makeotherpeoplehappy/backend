import type { Deps, Env } from './env';
import { UpstreamError, callUpstream, retryAfterSeconds } from './http';

const API = 'https://api.webflow.com/v2';

export interface WebflowItem {
  id: string;
  isDraft?: boolean;
  isArchived?: boolean;
  fieldData: Record<string, unknown>;
}

async function request(env: Env, deps: Deps, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await callUpstream(deps.fetch, 'webflow', `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.WEBFLOW_API_TOKEN}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => '');
  throw new UpstreamError('webflow', res.status, `Webflow ${what} failed (${res.status}): ${text.slice(0, 500)}`, retryAfterSeconds(res));
}

function isDuplicateSlug(status: number, text: string): boolean {
  return (status === 400 || status === 409) && /slug/i.test(text) && /(unique|already|exists|duplicate)/i.test(text);
}

/**
 * Creates a staged item. Slugs are chosen by the caller and unique per
 * record, so when an earlier attempt created the item but its answer was
 * lost, the existing item is found by slug and reused instead of duplicated.
 */
export async function createItem(
  env: Env,
  deps: Deps,
  collectionId: string,
  fieldData: Record<string, unknown> & { name: string; slug: string },
  isDraft = true,
): Promise<WebflowItem> {
  const res = await request(env, deps, 'POST', `/collections/${collectionId}/items`, { isArchived: false, isDraft, fieldData });
  if (res.ok) return (await res.json()) as WebflowItem;
  const text = await res.clone().text().catch(() => '');
  if (isDuplicateSlug(res.status, text)) {
    const existing = await findItemBySlug(env, deps, collectionId, fieldData.slug);
    if (existing) return existing;
  }
  return fail(res, 'create item');
}

export async function findItemBySlug(env: Env, deps: Deps, collectionId: string, slug: string): Promise<WebflowItem | null> {
  const res = await request(env, deps, 'GET', `/collections/${collectionId}/items?slug=${encodeURIComponent(slug)}&limit=1`);
  if (!res.ok) return fail(res, 'find item');
  const body = (await res.json()) as { items?: WebflowItem[] };
  return body.items?.find((i) => i.fieldData?.slug === slug) || null;
}

export async function updateItem(env: Env, deps: Deps, collectionId: string, itemId: string, fieldData: Record<string, unknown>): Promise<void> {
  const res = await request(env, deps, 'PATCH', `/collections/${collectionId}/items/${itemId}`, { fieldData });
  if (res.status === 404) return;
  if (!res.ok) await fail(res, 'update item');
}

/** Removes an item from the live site and from the CMS. Missing items are fine. */
export async function deleteItem(env: Env, deps: Deps, collectionId: string, itemId: string): Promise<void> {
  const live = await request(env, deps, 'DELETE', `/collections/${collectionId}/items/${itemId}/live`);
  // 404 or 409: the item was never published or is already off the site.
  if (!live.ok && live.status !== 404 && live.status !== 409 && live.status !== 400) await fail(live, 'unpublish item');
  const staged = await request(env, deps, 'DELETE', `/collections/${collectionId}/items/${itemId}`);
  if (!staged.ok && staged.status !== 404) await fail(staged, 'delete item');
}

/** Lists every published (live) item of a collection. */
export async function listLiveItems(env: Env, deps: Deps, collectionId: string): Promise<WebflowItem[]> {
  const all: WebflowItem[] = [];
  for (let offset = 0; ; offset += 100) {
    const res = await request(env, deps, 'GET', `/collections/${collectionId}/items/live?limit=100&offset=${offset}`);
    if (!res.ok) await fail(res, 'list live items');
    const body = (await res.json()) as { items?: WebflowItem[]; pagination?: { total?: number } };
    const items = body.items || [];
    all.push(...items);
    const total = body.pagination?.total ?? 0;
    if (items.length < 100 || all.length >= total) break;
  }
  return all;
}

/** One published item, or null if it is not live. */
export async function getLiveItem(env: Env, deps: Deps, collectionId: string, itemId: string): Promise<WebflowItem | null> {
  const res = await request(env, deps, 'GET', `/collections/${collectionId}/items/${itemId}/live`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) return fail(res, 'get live item');
  return (await res.json()) as WebflowItem;
}
