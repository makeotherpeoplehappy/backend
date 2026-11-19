// The shop on this site: Shopify products and drops copied into Webflow, a
// product's live state, checkout with early access for Active members, the
// member on the order, and "Notify me".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { syncShop } from '../src/core/features/shop';
import { createHarness, SITE, type Harness } from './harness';

let h: Harness;
const PRODUCT = 'gid://shopify/Product/555';
const VARIANT = 'gid://shopify/ProductVariant/5551';
const DROP_AT = '2026-12-05T17:00:00.000Z';
const EARLY_AT = '2026-12-04T17:00:00.000Z';

beforeEach(async () => {
  h = await createHarness();
  h.fake.products.push({ id: PRODUCT, handle: 'drop-01-tee', title: 'Drop 01 Tee', status: 'ACTIVE', descriptionHtml: '<p>Soft. Kind.</p>', description: 'Soft. Kind.', editionSize: 100, imageUrl: 'https://cdn.shopify.com/tee.jpg' });
  h.fake.inventory.set(PRODUCT, 100);
  h.fake.shopCollections.set('drop-01', [PRODUCT]);
  h.fake.dropCollections.set('drop-01', { title: 'Drop 01', description: 'The first drop.', dropDate: DROP_AT });
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
  h.fake.signIn('ms_ben', { id: 'mem_ben', firstName: 'Ben', email: 'ben@example.com' });
  // Both have an account; Ana is an Active member.
  await h.request('GET', '/api/me', { token: 'ms_ana' });
  await h.request('GET', '/api/me', { token: 'ms_ben' });
  await h.env.DB.prepare(`UPDATE members SET active = 1 WHERE account_id = 'mem_ana'`).run();
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const at = (iso: string) => { h.clock.now = new Date(iso); };
const state = async (token?: string) => (await h.request('GET', '/api/shop/products/drop-01-tee', token ? { token } : {})).json();
const buy = (token?: string, variant = VARIANT) => h.request('POST', '/api/shop/checkout', { ...(token ? { token } : {}), body: { variant } });

async function shopifyHook(topic: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('shopify_webhook_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return h.app.handle(new Request(`${SITE}/join/api/webhooks/shopify`, { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': crypto.randomUUID() }, body }), h.env, h.ctx);
}

describe('Shopify → Webflow', () => {
  it('copies drops and active products, linked, once; an archived product leaves the site', async () => {
    const r = await syncShop(h.env, h.app.deps);
    expect(r).toMatchObject({ created: 2, errors: [] });
    const [drop] = h.fake.collection(CMS.drops.id);
    expect(drop.live).toBe(true);
    expect(drop.fieldData).toMatchObject({ name: 'Drop 01', slug: 'drop-01', 'drop-date': DROP_AT, 'early-access': EARLY_AT, description: 'The first drop.' });
    const [product] = h.fake.collection(CMS.products.id);
    expect(product.live).toBe(true);
    expect(product.fieldData).toMatchObject({ name: 'Drop 01 Tee', slug: 'drop-01-tee', price: '$45', 'edition-size': 100, drop: drop.id, evergreen: false, 'short-description': 'Soft. Kind.' });
    expect((product.fieldData.image as { url: string }).url).toBe('https://cdn.shopify.com/tee.jpg');
    // The home page hero: the drop's one image, its title as the headline, the lead piece and its pieces.
    expect((drop.fieldData.image as { url: string }).url).toBe('https://cdn.shopify.com/drop-01.jpg');
    expect(drop.fieldData).toMatchObject({ 'hero-before': 'Drop 01', 'hero-accent': '', 'lead-name': 'Drop 01 Tee', 'lead-price': '$45', 'lead-slug': 'drop-01-tee', pieces: [product.id], 'piece-count': 1, 'sold-out': false, open: true, 'hero-on': true, 'hero-off': false });
    expect(await syncShop(h.env, h.app.deps)).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    h.fake.products[0].status = 'ARCHIVED';
    expect(await syncShop(h.env, h.app.deps)).toMatchObject({ removed: 1 });
    expect(h.fake.collection(CMS.products.id)[0].live).toBe(false);
  });

  it('the hero: headline with its accent word, photo, lead piece, and sold out once nothing is left', async () => {
    h.fake.products.push({ id: 'gid://shopify/Product/556', handle: 'drop-01-cap', title: 'Drop 01 Cap', status: 'ACTIVE', descriptionHtml: '', description: '', editionSize: 50, price: '30.0' });
    h.fake.inventory.set('gid://shopify/Product/556', 50);
    h.fake.shopCollections.set('drop-01', [PRODUCT, 'gid://shopify/Product/556']);
    Object.assign(h.fake.dropCollections.get('drop-01')!, { heroHeadline: 'Happiness is felt by making other people *happy*.', imageUrl: 'https://cdn.shopify.com/hero.jpg', leadProductId: 'gid://shopify/Product/556' });
    await syncShop(h.env, h.app.deps);
    const [drop] = h.fake.collection(CMS.drops.id);
    expect(drop.fieldData).toMatchObject({ 'hero-before': 'Happiness is felt by making other people ', 'hero-accent': 'happy', 'hero-after': '.', 'lead-name': 'Drop 01 Cap', 'lead-price': '$30', 'lead-slug': 'drop-01-cap', 'piece-count': 2, 'sold-out': false, 'hero-on': true, 'hero-off': false });
    expect((drop.fieldData.image as { url: string }).url).toBe('https://cdn.shopify.com/hero.jpg');
    h.fake.inventory.set(PRODUCT, 0);
    h.fake.inventory.set('gid://shopify/Product/556', 0);
    await syncShop(h.env, h.app.deps);
    expect(h.fake.collection(CMS.drops.id)[0].fieldData).toMatchObject({ 'sold-out': true, open: false, 'hero-on': false, 'hero-off': true });
  });

  it('a drop needs its image: without one it stays off the site', async () => {
    h.fake.dropCollections.get('drop-01')!.imageUrl = null;
    const r = await syncShop(h.env, h.app.deps);
    expect(r.needsImage).toEqual(['drop-01']);
    expect(h.fake.collection(CMS.drops.id)).toHaveLength(0);
    h.fake.dropCollections.get('drop-01')!.imageUrl = 'https://cdn.shopify.com/drop-01.jpg';
    await syncShop(h.env, h.app.deps);
    expect(h.fake.collection(CMS.drops.id)[0].live).toBe(true);
    h.fake.dropCollections.get('drop-01')!.imageUrl = null;
    await syncShop(h.env, h.app.deps);
    expect(h.fake.collection(CMS.drops.id)[0].live).toBe(false);
  });

  it('a product outside any drop is evergreen', async () => {
    h.fake.products.push({ id: 'gid://shopify/Product/777', handle: 'thank-you-cards', title: 'Thank-you cards', status: 'ACTIVE', descriptionHtml: '', description: '' });
    await syncShop(h.env, h.app.deps);
    const cards = h.fake.collection(CMS.products.id).find((i) => i.fieldData.slug === 'thank-you-cards')!;
    expect(cards.fieldData).toMatchObject({ drop: null, evergreen: true });
  });

  it('a product webhook queues one sync shortly after', async () => {
    expect((await shopifyHook('products/update', { id: 555 })).status).toBe(200);
    expect((await shopifyHook('collections/update', { id: 1 })).status).toBe(200);
    await h.settle();
    await drain(h.env, h.app.deps, { limit: 20 });
    expect(h.fake.collection(CMS.products.id)).toHaveLength(1);
  });
});

describe('Buying', () => {
  it('before early access: nobody can buy, and the page says when', async () => {
    const s = await state('ms_ana');
    expect(s).toMatchObject({ status: 'upcoming', canBuy: false, reason: 'upcoming', left: 100, edition: 100, drop: { slug: 'drop-01', earlyAt: EARLY_AT, dropDate: DROP_AT } });
    expect(s.variants).toEqual([{ id: VARIANT, title: 'One size', available: true }]);
    expect((await buy('ms_ana')).status).toBe(403);
    expect(h.fake.carts).toHaveLength(0);
  });

  it('early access: Active members only, one each, with their email and account on the order', async () => {
    at('2026-12-04T18:00:00Z');
    expect(await state()).toMatchObject({ status: 'early', canBuy: false, reason: 'early_sign_in' });
    expect(await state('ms_ben')).toMatchObject({ canBuy: false, reason: 'early_not_active' });
    expect((await buy('ms_ben')).status).toBe(403);
    expect(await state('ms_ana')).toMatchObject({ canBuy: true });
    const r = await buy('ms_ana');
    expect(r.status).toBe(200);
    expect((await r.json()).checkoutUrl).toMatch(/^https:\/\/r40e0y-zs\.myshopify\.com\/cart\/c\//);
    const cart = h.fake.carts[0].input as { lines: unknown[]; buyerIdentity: { email: string }; attributes: { key: string; value: string }[] };
    expect(cart.lines).toEqual([{ merchandiseId: VARIANT, quantity: 1 }]);
    expect(cart.buyerIdentity).toEqual({ email: 'ana@example.com' });
    expect(cart.attributes[0].key).toBe('_hf_member');

    // The order arrives with a different email: it still joins Ana (the signed attribute).
    await shopifyHook('orders/create', {
      id: 77, admin_graphql_api_id: 'gid://shopify/Order/77', email: 'ana.other@example.com', created_at: '2026-12-04T18:05:00Z', processed_at: '2026-12-04T18:05:00Z',
      customer: { id: 1000 }, note_attributes: [{ name: '_hf_member', value: cart.attributes[0].value }],
      line_items: [{ id: 770, admin_graphql_api_id: 'gid://shopify/LineItem/770', product_id: 555, quantity: 1 }], refunds: [],
    });
    expect(await h.db(`SELECT p.status, m.account_id FROM pledges p JOIN members m ON m.id = p.member_id`)).toEqual([{ status: 'open', account_id: 'mem_ana' }]);
    // One each during early access.
    expect(await state('ms_ana')).toMatchObject({ canBuy: false, reason: 'early_one_each' });
  });

  it('a forged member on an order is ignored', async () => {
    await shopifyHook('orders/create', {
      id: 78, admin_graphql_api_id: 'gid://shopify/Order/78', email: 'stranger@example.com', created_at: '2026-12-05T18:00:00Z', processed_at: '2026-12-05T18:00:00Z',
      customer: null, note_attributes: [{ name: '_hf_member', value: '1.AAAAAAAAAAAAAAAA' }],
      line_items: [{ id: 780, admin_graphql_api_id: 'gid://shopify/LineItem/780', product_id: 555, quantity: 1 }], refunds: [],
    });
    expect(await h.db(`SELECT member_id, buyer_email FROM pledges`)).toEqual([{ member_id: null, buyer_email: 'stranger@example.com' }]);
  });

  it('from the drop date everyone can buy, signed in or not; sold out stops it', async () => {
    at('2026-12-05T17:00:00Z');
    expect(await state()).toMatchObject({ status: 'live', canBuy: true });
    expect((await buy()).status).toBe(200);
    expect((h.fake.carts[0].input as { attributes?: unknown }).attributes).toBeUndefined();
    h.fake.inventory.set(PRODUCT, 0);
    expect(await state()).toMatchObject({ status: 'sold_out', canBuy: false, left: 0 });
    expect((await buy()).status).toBe(403);
  });

  it('without the Storefront token Buy says the shop is not ready', async () => {
    at('2026-12-05T18:00:00Z');
    delete (h.env as { SHOPIFY_STOREFRONT_TOKEN?: string }).SHOPIFY_STOREFRONT_TOKEN;
    const r = await buy();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('shop_not_ready');
  });

  it('refuses a variant that is not a Shopify variant', async () => {
    expect((await buy(undefined, 'x')).status).toBe(400);
    expect((await buy(undefined, 'gid://shopify/ProductVariant/999')).status).toBe(404);
  });
});

describe('Notify me', () => {
  const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
  const mails = () => h.fake.emails.filter((e) => e.template?.id === 'hf-drop-open');

  it('is kept with the member; Active members hear at early access, everyone else at the drop, once', async () => {
    // Ana stays Active for this test (the 6-hourly Active job would work it out from her actions).
    await h.env.DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES ('active-members', '2030-01-01T00:00:00Z')`).run();
    expect((await h.request('POST', '/api/shop/notify', { body: { drop: 'drop-01' } })).status).toBe(401);
    expect(await (await h.request('POST', '/api/shop/notify', { token: 'ms_ana', body: { drop: 'drop-01' } })).json()).toEqual({ drop: 'drop-01', notified: true });
    await h.request('POST', '/api/shop/notify', { token: 'ms_ben', body: { drop: 'drop-01' } });
    expect((await (await h.request('GET', '/api/drops', { token: 'ms_ana' })).json()).drops[0]).toMatchObject({ drop: 'drop-01', phase: 'upcoming', earlyAt: EARLY_AT, notified: true });
    expect((await state('ms_ben')).notified).toBe(true);

    await tick(); await h.settle(); await drain(h.env, h.app.deps, { limit: 50 });
    expect(mails()).toHaveLength(0);

    at('2026-12-04T17:30:00Z');
    await tick(); await h.settle(); await drain(h.env, h.app.deps, { limit: 50 });
    expect(mails().map((m) => [m.to[0], m.template!.variables.EARLY])).toEqual([['ana@example.com', 'yes']]);

    at('2026-12-05T17:05:00Z');
    await tick(); await h.settle(); await drain(h.env, h.app.deps, { limit: 50 });
    await tick(); await h.settle(); await drain(h.env, h.app.deps, { limit: 50 });
    expect(mails().map((m) => [m.to[0], m.template!.variables.EARLY])).toEqual([['ana@example.com', 'yes'], ['ben@example.com', 'no']]);
  });

  it('can be switched off, and an unknown drop is refused', async () => {
    await h.request('POST', '/api/shop/notify', { token: 'ms_ana', body: { drop: 'drop-01' } });
    expect(await (await h.request('POST', '/api/shop/notify', { token: 'ms_ana', body: { drop: 'drop-01', on: false } })).json()).toEqual({ drop: 'drop-01', notified: false });
    expect((await h.request('POST', '/api/shop/notify', { token: 'ms_ana', body: { drop: 'nope' } })).status).toBe(404);
  });
});
