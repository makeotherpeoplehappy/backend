// Partner pledges: another shop registers the pledges of an order with its key,
// gives the buyer the "Keep your pledge" link, and the buyer keeps them by
// signing in on the foundation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
let key: string;

beforeEach(async () => {
  h = await createHarness();
  h.env.LAB_EMAILS = 'boss@example.com';
  h.fake.signIn('ms_boss', { id: 'mem_boss', email: 'boss@example.com', firstName: 'Boss' });
  const r = await h.request('POST', '/api/lab/partners', { token: 'ms_boss', body: { name: 'Good Shop' } });
  expect(r.status).toBe(200);
  key = (await r.json()).key;
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const partner = (path: string, body: unknown, k = key) =>
  h.request('POST', `/api/partners${path}`, { origin: null, key: null, headers: { Authorization: `Bearer ${k}` }, body });

describe('Partner pledges', () => {
  it('registers an order once, however often it is sent, and gives a claim link', async () => {
    const body = { order: 'A-1', items: [{ ref: 'mug', quantity: 2 }, { ref: 'tee', quantity: 1 }] };
    const first = await (await partner('/pledges', body)).json();
    const again = await (await partner('/pledges', body)).json();
    expect(first).toMatchObject({ order: 'A-1', pledges: 3 });
    expect(first.claimUrl).toMatch(/\/keep-your-pledge\?c=[\w-]{24}$/);
    expect(again.claimUrl).toBe(first.claimUrl);
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges WHERE order_ref = 'good-shop:A-1'`)).toEqual([{ n: 3 }]);
  });

  it('lowering a quantity or cancelling the order cancels pledges', async () => {
    await partner('/pledges', { order: 'A-2', items: [{ ref: 'mug', quantity: 3 }] });
    expect(await (await partner('/pledges', { order: 'A-2', items: [{ ref: 'mug', quantity: 1 }] })).json()).toMatchObject({ pledges: 1 });
    expect(await (await partner('/pledges/cancel', { order: 'A-2' })).json()).toEqual({ order: 'A-2', cancelled: 1 });
  });

  it('refuses a missing, wrong or switched-off key, and bad orders', async () => {
    const body = { order: 'A-3', items: [{ ref: 'mug', quantity: 1 }] };
    expect((await partner('/pledges', body, 'hfp_nope')).status).toBe(401);
    expect((await partner('/pledges', { order: '', items: [] })).status).toBe(400);
    expect((await partner('/pledges', { order: 'A-3', items: [{ ref: 'mug', quantity: 101 }] })).status).toBe(400);
    const [p] = await h.db<{ id: number }>(`SELECT id FROM partners WHERE slug = 'good-shop'`);
    expect((await h.request('PATCH', '/api/lab/partners', { token: 'ms_boss', body: { id: p.id, active: false } })).status).toBe(200);
    expect((await partner('/pledges', body)).status).toBe(401);
  });

  it('the buyer keeps the pledges by signing in with the link; nobody else can take them', async () => {
    const { claimUrl } = await (await partner('/pledges', { order: 'A-4', items: [{ ref: 'mug', quantity: 2 }] })).json();
    const code = new URL(claimUrl).searchParams.get('c');
    h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com' });
    h.fake.signIn('ms_ian', { id: 'mem_ian', email: 'ian@example.com' });
    expect((await h.request('POST', '/api/pledges/claim', { body: { code } })).status).toBe(401);
    expect(await (await h.request('POST', '/api/pledges/claim', { token: 'ms_tess', body: { code } })).json()).toEqual({ claimed: 2 });
    expect(await (await h.request('POST', '/api/pledges/claim', { token: 'ms_tess', body: { code } })).json()).toEqual({ claimed: 2 });
    expect((await h.request('POST', '/api/pledges/claim', { token: 'ms_ian', body: { code } })).status).toBe(409);
    expect((await h.request('POST', '/api/pledges/claim', { token: 'ms_ian', body: { code: 'not-a-code' } })).status).toBe(404);
    const me = await (await h.request('GET', '/api/me', { token: 'ms_tess' })).json();
    expect(JSON.stringify(me)).toContain('pledge');
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges p JOIN members m ON m.id = p.member_id WHERE m.account_id = 'mem_tess'`)).toEqual([{ n: 2 }]);
  });

  it('an email that matches a member attaches the pledges straight away', async () => {
    h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com' });
    await h.request('GET', '/api/me', { token: 'ms_tess' });
    await partner('/pledges', { order: 'A-5', items: [{ ref: 'mug', quantity: 1 }], email: 'Tess@Example.com' });
    expect(await h.db(`SELECT buyer_email, member_id IS NOT NULL AS mine FROM pledges`)).toEqual([{ buyer_email: null, mine: 1 }]);
  });

  it('only owners add or switch off partners, and /lab lists their numbers', async () => {
    await h.db(`INSERT INTO lab_access (email, added_by, added_at) VALUES ('ann@example.com', 'boss@example.com', '2026-11-17')`);
    h.fake.signIn('ms_ann', { id: 'mem_ann', email: 'ann@example.com' });
    expect((await h.request('POST', '/api/lab/partners', { token: 'ms_ann', body: { name: 'X' } })).status).toBe(403);
    await partner('/pledges', { order: 'A-6', items: [{ ref: 'mug', quantity: 2 }] });
    const list = await (await h.request('GET', '/api/lab/partners', { token: 'ms_ann' })).json();
    expect(list.partners).toEqual([
      expect.objectContaining({ id: 1, slug: 'shop', pledges: 0 }),
      expect.objectContaining({ name: 'Good Shop', slug: 'good-shop', active: 1, pledges: 2, claimed: 0, kept: 0 }),
    ]);
    expect(JSON.stringify(list)).not.toContain('hfp_');
  });
});
