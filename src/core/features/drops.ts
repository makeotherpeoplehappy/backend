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
  if (!drop) throw new HttpError(404, 'drop_not_found', 'This drop could not be found.');
  if ((await effectiveStatus(env, deps, drop)) !== 'upcoming') {
    throw new HttpError(409, 'drop_not_upcoming', drop.status === 'live' ? 'This drop is live now. Have a look in the shop.' : 'This drop is no longer taking sign-ups.');
  }
  const email = (member?.email || (typeof input.email === 'string' ? input.email : '')).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Please enter a valid email address.');

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

/** Pieces left of the lead product, all sizes together; null when not tracked. Cached 60 seconds. */
export async function piecesLeft(env: Env, deps: Deps, drop: Drop): Promise<number | null> {
  const key = `drop-stock:${drop.slug}`;
  const cached = await env.CACHE.get(key);
  if (cached !== null) return cached === 'untracked' ? null : Number(cached);
  const productId = await shopifyIdOf(env, drop.leadProductItemId);
  if (!productId) return null;
  const r = await adminGraphql<{ product: { tracksInventory: boolean; totalInventory: number } | null }>(
    env,
    deps,
    `query ($id: ID!) { product(id: $id) { tracksInventory totalInventory } }`,
    { id: productId },
  );
  const left = r.product && r.product.tracksInventory ? Math.max(0, r.product.totalInventory) : null;
  await env.CACHE.put(key, left === null ? 'untracked' : String(left), { expirationTtl: 60 });
  return left;
}

/** Upcoming before the drop date, sold out at zero stock, live otherwise. */
export async function effectiveStatus(env: Env, deps: Deps, drop: Drop, left?: number | null): Promise<Drop['status']> {
  const at = drop.dropDate ? Date.parse(drop.dropDate) : NaN;
  if (Number.isFinite(at)) {
    if (deps.now().getTime() < at) return 'upcoming';
    const l = left === undefined ? await piecesLeft(env, deps, drop).catch(() => null) : left;
    return l === 0 ? 'sold_out' : 'live';
  }
  return drop.status;
}

const ET = 'America/New_York';

/** "100 pieces. Drops December 5 at 12:00 ET. Gone when they're gone." */
export function detailsLineFor(drop: Pick<Drop, 'quantity' | 'dropDate'>, status: Drop['status']): string | null {
  if (!drop.quantity || !drop.dropDate) return null;
  const d = new Date(drop.dropDate);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const pieces = `${drop.quantity} pieces.`;
  if (status === 'sold_out') return `${pieces} All gone. Thank you.`;
  if (status === 'live') return `${pieces} Out now. Gone when they're gone.`;
  return `${pieces} Drops ${day} at ${time} ET. Gone when they're gone.`;
}

/** What the drop hero needs: status, countdown target, stock and pledges. */
export async function dropState(env: Env, deps: Deps, slug: string | null) {
  const drop = await findDrop(env, deps, slug);
  if (!drop) throw new HttpError(404, 'drop_not_found', 'This drop could not be found.');
  const left = await piecesLeft(env, deps, drop).catch(() => null);
  const status = await effectiveStatus(env, deps, drop, left);
  return {
    drop: drop.slug,
    name: drop.name,
    status,
    dropDate: drop.dropDate,
    quantity: drop.quantity,
    left,
    detailsLine: detailsLineFor(drop, status) || drop.detailsLine,
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
    const status = await effectiveStatus(env, deps, d);
    if (status === 'unknown') continue;
    const line = detailsLineFor(d, status);
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
    if (/access denied|ACCESS_DENIED|publications/i.test((e as Error).message)) {
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
  let publications: string[] | null = null;
  for (const d of drops) {
    const at = d.dropDate ? Date.parse(d.dropDate) : NaN;
    if (!Number.isFinite(at) || at <= now) continue;
    const releaseAt = new Date(at).toISOString();
    for (const item of d.productItemIds) {
      const productId = await shopifyIdOf(env, item);
      if (!productId) continue;
      const done = await env.DB.prepare(`SELECT release_at FROM drop_releases WHERE product_id = ?1`).bind(productId).first<{ release_at: string }>();
      if (done?.release_at === releaseAt) continue;
      if (!publications) {
        const r = await adminGraphql<{ publications: { nodes: { id: string }[] } }>(env, deps, `query { publications(first: 20) { nodes { id } } }`);
        publications = r.publications.nodes.map((n) => n.id);
      }
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
    const left = await piecesLeft(env, deps, d).catch(() => null);
    const status = await effectiveStatus(env, deps, d, left);
    out.push({
      drop: d.slug,
      name: d.name,
      statement: d.statement,
      status,
      dropDate: d.dropDate,
      quantity: d.quantity,
      left,
      detailsLine: detailsLineFor(d, status) || d.detailsLine,
      onFrontPage: d.onFrontPage,
      collection: d.slug,
      pledges: await dropPledges(env, d.slug),
    });
  }
  const current = out.find((d) => d.onFrontPage && d.status !== 'sold_out') || out.find((d) => d.status === 'upcoming' || d.status === 'live') || null;
  const past = out.filter((d) => d !== current && d.status === 'sold_out').sort((a, b) => String(b.dropDate).localeCompare(String(a.dropDate)));
  return { current, past };
}
