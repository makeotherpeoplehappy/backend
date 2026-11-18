// Shareable proof: the card's "who", referral codes in shared links, and the
// link from a done mark to the member whose link brought the visitor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { createHarness, type Harness } from './harness';

let h: Harness;
let one: string;
let two: string;
const STRANGER = '6af7ec5177462bb643f480ed';
const NEIGHBOR = '6af7ec5177462bb643f480e5';

beforeEach(async () => {
  h = await createHarness();
  one = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  two = h.fake.addAction('bake-for-a-street', 'Bake for the street');
  h.fake.collection(CMS.actions.id).find((i) => i.id === one)!.fieldData.who = [STRANGER];
  h.fake.collection(CMS.actions.id).find((i) => i.id === two)!.fieldData.who = [STRANGER, NEIGHBOR];
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const parents = () => h.db<{ member_id: number; parent_member_id: number | null }>(`SELECT member_id, parent_member_id FROM done_marks ORDER BY id`);

describe('The card', () => {
  it('names the one person type an action is for, or nobody in particular', async () => {
    const a = await (await h.request('POST', `/api/actions/${one}/done`, { token: 'ms_ana' })).json();
    expect(a.cardWho).toBe('stranger');
    expect(a.refCode).toMatch(/^[A-Za-z0-9]{8}$/);
    const b = await (await h.request('GET', `/api/actions/${two}/state`)).json();
    expect(b.cardWho).toBeNull();
  });

  it('keeps the same referral code', async () => {
    const a = await (await h.request('POST', `/api/actions/${one}/done`, { token: 'ms_ana' })).json();
    const b = await (await h.request('POST', `/api/actions/${two}/done`, { token: 'ms_ana' })).json();
    expect(b.refCode).toBe(a.refCode);
  });
});

describe('Shared links', () => {
  it("links a visitor's mark to whoever shared the link; not their own, not a made-up code", async () => {
    const ref = (await (await h.request('POST', `/api/actions/${one}/done`, { token: 'ms_ana' })).json()).refCode;
    await h.request('POST', `/api/actions/${one}/done`, { headers: { 'X-HF-Guest': 'guest-key-share-000000001', 'X-HF-Ref': ref } });
    await h.request('POST', `/api/actions/${two}/done`, { token: 'ms_ana', headers: { 'X-HF-Ref': ref } });
    await h.request('POST', `/api/actions/${two}/done`, { headers: { 'X-HF-Guest': 'guest-key-share-000000002', 'X-HF-Ref': 'Nope1234' } });
    const ana = (await h.db<{ id: number }>(`SELECT id FROM members WHERE account_id = 'mem_ana'`))[0].id;
    const rows = await parents();
    expect(rows[1].parent_member_id).toBe(ana);
    expect(rows[2].parent_member_id).toBeNull();
    expect(rows[3].parent_member_id).toBeNull();
  });

  it("a guest's code and the marks it brought move to the account on sign-in", async () => {
    const g = await (await h.request('POST', `/api/actions/${one}/done`, { headers: { 'X-HF-Guest': 'guest-key-share-000000003' } })).json();
    await h.request('POST', `/api/actions/${one}/done`, { headers: { 'X-HF-Guest': 'guest-key-share-000000004', 'X-HF-Ref': g.refCode } });
    h.fake.signIn('ms_cleo', { id: 'mem_cleo', firstName: 'Cleo', email: 'cleo@example.com' });
    await h.request('POST', '/api/me/claim-guest', { token: 'ms_cleo', headers: { 'X-HF-Guest': 'guest-key-share-000000003' } });
    const cleo = (await h.db<{ id: number; ref_code: string }>(`SELECT id, ref_code FROM members WHERE account_id = 'mem_cleo'`))[0];
    expect(cleo.ref_code).toBe(g.refCode);
    expect((await parents())[1].parent_member_id).toBe(cleo.id);
  });
});
