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

export interface Drop {
  id: string;
  slug: string;
  name: string;
  status: 'upcoming' | 'live' | 'sold_out' | 'unknown';
  onFrontPage: boolean;
  dropDate: string | null;
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
  if (drop.status !== 'upcoming') {
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
