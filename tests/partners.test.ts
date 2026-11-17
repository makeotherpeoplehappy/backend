// The Pledge API: another shop asks for one pledge per purchase with its key,
// sending no customer data, gives the buyer the "Keep your pledge" link, and
// sees its results only as numbers.

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

const partner = (path: string, body: unknown, k = key, extra: Record<string, string> = {}) =>
  h.request('POST', `/api/partners${path}`, { origin: null, key: null, headers: { Authorization: `Bearer ${k}`, ...extra }, body });
const report = (month: string, k = key) =>
  h.request('GET', `/api/partners/report?month=${month}`, { origin: null, key: null, headers: { Authorization: `Bearer ${k}` } });

describe('Partner pledges', () => {
  it('gives one pledge per call with our own reference and a claim link; a retry with the same Idempotency-Key gets the same pledge', async () => {
    const a = await (await partner('/pledges', {}, key, { 'Idempotency-Key': 'k-1' })).json();
    const again = await (await partner('/pledges', {}, key, { 'Idempotency-Key': 'k-1' })).json();
    const b = await (await partner('/pledges', {})).json();
    expect(a).toMatchObject({ status: 'open' });
    expect(a.pledge).toMatch(/^pl_[\w-]{16,}$/);
    expect(a.claimUrl).toMatch(/\/keep-your-pledge\?c=[\w-]{24}$/);
    expect(again).toEqual(a);
    expect(b.pledge).not.toBe(a.pledge);
    expect(await h.db(`SELECT COUNT(*) AS n, MAX(buyer_email) AS e FROM pledges`)).toEqual([{ n: 2, e: null }]);
  });

  it('refuses customer data: no order number, no email', async () => {
    for (const body of [{ order: 'A-1' }, { email: 'tess@example.com' }, { orderedAt: '2026-11-01' }]) {
      const r = await partner('/pledges', body);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('no_customer_data');
    }
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges`)).toEqual([{ n: 0 }]);
  });

  it('cancels a pledge by our reference, only for its own partner', async () => {
    const { pledge } = await (await partner('/pledges', {})).json();
    expect(await (await partner('/pledges/cancel', { pledge })).json()).toEqual({ pledge, cancelled: 1 });
    expect(await h.db(`SELECT status FROM pledges`)).toEqual([{ status: 'cancelled' }]);
    expect((await partner('/pledges/cancel', { pledge: 'A-1001' })).status).toBe(400);
    const other = (await (await h.request('POST', '/api/lab/partners', { token: 'ms_boss', body: { name: 'Other Shop' } })).json()).key;
    expect(await (await partner('/pledges/cancel', { pledge }, other)).json()).toEqual({ pledge, cancelled: 0 });
  });

  it('refuses a missing, wrong or switched-off key', async () => {
    expect((await partner('/pledges', {}, 'hfp_nope')).status).toBe(401);
    const [p] = await h.db<{ id: number }>(`SELECT id FROM partners WHERE slug = 'good-shop'`);
    expect((await h.request('PATCH', '/api/lab/partners', { token: 'ms_boss', body: { id: p.id, active: false } })).status).toBe(200);
    expect((await partner('/pledges', {})).status).toBe(401);
  });

  it('the buyer keeps the pledges by signing in with the link; nobody else can take them', async () => {
    const { claimUrl } = await (await partner('/pledges', {})).json();
    const code = new URL(claimUrl).searchParams.get('c');
    h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com' });
    h.fake.signIn('ms_ian', { id: 'mem_ian', email: 'ian@example.com' });
    expect((await h.request('POST', '/api/pledges/claim', { body: { code } })).status).toBe(401);
    expect(await (await h.request('POST', '/api/pledges/claim', { token: 'ms_tess', body: { code } })).json()).toEqual({ claimed: 1 });
    expect(await (await h.request('POST', '/api/pledges/claim', { token: 'ms_tess', body: { code } })).json()).toEqual({ claimed: 1 });
    expect((await h.request('POST', '/api/pledges/claim', { token: 'ms_ian', body: { code } })).status).toBe(409);
    expect((await h.request('POST', '/api/pledges/claim', { token: 'ms_ian', body: { code: 'not-a-code' } })).status).toBe(404);
    const me = await (await h.request('GET', '/api/me', { token: 'ms_tess' })).json();
    expect(JSON.stringify(me)).toContain('pledge');
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges p JOIN members m ON m.id = p.member_id WHERE m.account_id = 'mem_tess'`)).toEqual([{ n: 1 }]);
  });

  it('only owners add or switch off partners, and /lab lists their numbers', async () => {
    await h.db(`INSERT INTO lab_access (email, added_by, added_at) VALUES ('ann@example.com', 'boss@example.com', '2026-11-17')`);
    h.fake.signIn('ms_ann', { id: 'mem_ann', email: 'ann@example.com' });
    expect((await h.request('POST', '/api/lab/partners', { token: 'ms_ann', body: { name: 'X' } })).status).toBe(403);
    await partner('/pledges', {});
    const list = await (await h.request('GET', '/api/lab/partners', { token: 'ms_ann' })).json();
    expect(list.partners).toEqual([
      expect.objectContaining({ id: 1, slug: 'shop', pledges: 0 }),
      expect.objectContaining({ name: 'Good Shop', slug: 'good-shop', active: 1, pledges: 1, claimed: 0, kept: 0 }),
    ]);
    expect(JSON.stringify(list)).not.toContain('hfp_');
  });

  it('reports numbers only: per month and in total, by API and by a monthly email', async () => {
    const [p] = await h.db<{ id: number }>(`SELECT id FROM partners WHERE slug = 'good-shop'`);
    await h.request('PATCH', '/api/lab/partners', { token: 'ms_boss', body: { id: p.id, reportEmail: 'Shop@Example.com' } });
    // Two pledges in November; one is kept by a member.
    const one = await (await partner('/pledges', {})).json();
    await partner('/pledges', {});
    h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com' });
    await h.request('POST', '/api/pledges/claim', { token: 'ms_tess', body: { code: new URL(one.claimUrl).searchParams.get('c') } });
    const nov = await (await report('2026-11')).json();
    expect(nov).toEqual({ month: '2026-11', given: 2, claimed: 1, kept: 0, total: { given: 2, claimed: 1, kept: 0 } });
    expect(JSON.stringify(nov)).not.toContain('tess');
    expect((await report('November')).status).toBe(400);
    // On December 1 the partner gets November's numbers by email, once.
    h.clock.now = new Date('2026-12-01T08:00:00Z');
    const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
    await tick();
    await h.settle();
    h.clock.advance(2 * 60 * 60 * 1000);
    await tick();
    await h.settle();
    const sent = h.fake.emails.filter((e) => e.template?.id === 'hf-partner-report');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['shop@example.com']);
    expect(sent[0].template!.variables).toMatchObject({ PARTNER: 'Good Shop', MONTH: 'November 2026', GIVEN: 2, CLAIMED: 1, KEPT: 0, TOTAL_GIVEN: 2 });
  });
});
