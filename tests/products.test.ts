// Shopify → Webflow product sync.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { createHarness, SITE, type FakeProduct, type Harness } from './harness';

let h: Harness;
const P = () => h.fake.collection(CMS.products.id);

const tee: FakeProduct = {
  id: 'gid://shopify/Product/1001',
  handle: 'drop-01-tee',
  title: 'Drop 01 Tee',
  status: 'ACTIVE',
  descriptionHtml: '<p>Heavyweight cotton tee with the statement.</p>',
  description: 'Heavyweight cotton tee with the statement.',
  imageUrl: 'https://cdn.shopify.com/s/files/tee.jpg',
};

beforeEach(async () => {
  h = await createHarness();
  h.fake.products = [{ ...tee }];
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const admin = (path: string) => h.request('POST', path, { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
const sync = async () => (await admin('/api/admin/sync-products')).json() as Promise<Record<string, unknown>>;

async function webhook(topic: string, payload: unknown, id = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('shopify_webhook_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return h.app.handle(
    new Request(`${SITE}/join/api/webhooks/shopify`, { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': id }, body }),
    h.env,
    { waitUntil: () => undefined },
  );
}

describe('Product sync', () => {
  it('creates and publishes a CMS item for each active product, with the Shopify handle as its slug', async () => {
    expect(await sync()).toMatchObject({ created: 1, updated: 0, removed: 0, errors: [] });
    expect(P()).toHaveLength(1);
    expect(P()[0]).toMatchObject({ live: true, isDraft: false });
    expect(P()[0].fieldData).toMatchObject({
      name: 'Drop 01 Tee',
      slug: 'drop-01-tee',
      'shopify-id': tee.id,
      description: tee.descriptionHtml,
      'short-description': 'Heavyweight cotton tee with the statement.',
      image: { url: tee.imageUrl, alt: 'Drop 01 Tee' },
    });
  });

  it('writes nothing when nothing changed, and updates only what changed', async () => {
    await sync();
    const writesBefore = h.fake.calls.filter((c) => c.url.includes('api.webflow.com') && c.method !== 'GET').length;
    expect(await sync()).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(h.fake.calls.filter((c) => c.url.includes('api.webflow.com') && c.method !== 'GET').length).toBe(writesBefore);

    h.fake.products[0].title = 'Drop 01 Tee (black)';
    expect(await sync()).toMatchObject({ updated: 1 });
    expect(P()[0].liveFieldData?.name).toBe('Drop 01 Tee (black)');
  });

  it('never touches fields set by hand in Webflow, such as "Goes with these actions"', async () => {
    await sync();
    P()[0].fieldData['goes-with-these-actions'] = ['6af7ee1968b3c49af2c45bdf'];
    h.fake.products[0].description = 'New words.';
    await sync();
    expect(P()[0].fieldData['goes-with-these-actions']).toEqual(['6af7ee1968b3c49af2c45bdf']);
  });

  it('links an existing CMS item by its Shopify ID instead of creating a duplicate', async () => {
    P().push({ id: 'existing0000000000000001', isDraft: false, live: true, fieldData: { name: 'Old name', slug: 'drop-01-tee', 'shopify-id': tee.id } });
    expect(await sync()).toMatchObject({ created: 0, updated: 1 });
    expect(P()).toHaveLength(1);
    expect(P()[0].fieldData.name).toBe('Drop 01 Tee');
  });

  it('takes archived and deleted products off the site but keeps them as drafts, and brings them back', async () => {
    await sync();
    h.fake.products[0].status = 'ARCHIVED';
    expect(await sync()).toMatchObject({ removed: 1 });
    expect(P()[0]).toMatchObject({ live: false, isDraft: true });
    expect(P()).toHaveLength(1);

    h.fake.products[0].status = 'ACTIVE';
    expect(await sync()).toMatchObject({ updated: 1 });
    expect(P()[0]).toMatchObject({ live: true, isDraft: false });
  });

  it('leaves CMS items without a Shopify ID alone', async () => {
    P().push({ id: 'manual000000000000000001', isDraft: false, live: true, fieldData: { name: 'Hand-made item', slug: 'hand-made' } });
    await sync();
    expect(P().find((i) => i.fieldData.slug === 'hand-made')).toMatchObject({ live: true, isDraft: false });
  });

  it('removes nothing when Shopify cannot be read in full', async () => {
    await sync();
    h.fake.shopifyDown = true;
    const real = h.app.deps.fetch;
    h.app.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/admin/api/') ? new Response('{}', { status: 503 }) : real(input, init)) as typeof fetch;
    const res = await admin('/api/admin/sync-products');
    expect(res.status).toBe(503);
    expect(P()[0]).toMatchObject({ live: true });
  });

  it('a product update webhook syncs that product straight away', async () => {
    await sync();
    h.fake.products[0].title = 'Renamed in Shopify';
    const res = await webhook('products/update', { id: 1001 });
    expect(res.status).toBe(200);
    expect(P()[0].liveFieldData?.name).toBe('Renamed in Shopify');
  });

  it('a product delete webhook takes it off the site', async () => {
    await sync();
    h.fake.products = [];
    expect((await webhook('products/delete', { id: 1001 })).status).toBe(200);
    expect(P()[0]).toMatchObject({ live: false, isDraft: true });
  });

  it('a new product created in Shopify appears through its webhook', async () => {
    h.fake.products.push({ ...tee, id: 'gid://shopify/Product/1002', handle: 'drop-01-cap', title: 'Drop 01 Cap' });
    expect((await webhook('products/create', { id: 1002 })).status).toBe(200);
    expect(P().map((i) => i.fieldData.slug)).toEqual(['drop-01-cap']);
  });

  it('the hourly job runs the sync at most once an hour', async () => {
    const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
    expect((await (await tick()).json()).syncProducts).toMatchObject({ created: 1 });
    expect((await (await tick()).json()).syncProducts).toBeUndefined();
    h.clock.advance(61 * 60 * 1000);
    expect((await (await tick()).json()).syncProducts).toMatchObject({ unchanged: 1 });
  });

  it('registers the Shopify webhooks once, pointing at this backend', async () => {
    const first = await (await admin('/api/admin/shopify-webhooks')).json();
    expect(first.created.sort()).toEqual(['CUSTOMERS_DELETE', 'PRODUCTS_CREATE', 'PRODUCTS_DELETE', 'PRODUCTS_UPDATE']);
    expect(first.callbackUrl).toBe(`${SITE}/join/api/webhooks/shopify`);
    const second = await (await admin('/api/admin/shopify-webhooks')).json();
    expect(second.created).toEqual([]);
    expect(h.fake.webhookSubs).toHaveLength(4);
  });
});
