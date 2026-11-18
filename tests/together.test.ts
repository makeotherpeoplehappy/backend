// Do it together: "I'm in" without an account (first name only), a private
// group count that includes the inviter, and names capped at five.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { createHarness, type Harness } from './harness';

let h: Harness;
let action: string;
let code: string;
const FRIENDS = '6af7edb79fddcb1ec5b3d86e';

beforeEach(async () => {
  h = await createHarness();
  action = h.fake.addAction('cook-together', 'Cook together', [CMS.actions.onMyOwnCompanionId, FRIENDS]);
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
  const r = await h.request('POST', '/api/invites', { token: 'ms_ana', body: { actionId: action, kind: 'with_me' } });
  expect(r.status).toBe(201);
  code = (await r.json()).code;
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const key = (n: number) => `guest-key-group-${String(n).padStart(9, '0')}`;
const join = (n: number, firstName?: string) =>
  h.request('POST', `/api/invites/${code}/join`, { headers: { 'X-HF-Guest': key(n) }, body: firstName === undefined ? {} : { firstName } });
const invite = async () => (await (await h.request('GET', `/api/invites/${code}`)).json());

describe("I'm in without an account", () => {
  it('asks only for a first name, then counts the inviter too', async () => {
    expect((await invite()).group).toEqual({ count: 1, names: [], more: 0 });
    const no = await join(1);
    expect(no.status).toBe(409);
    expect((await no.json()).error).toBe('need_join_name');
    const yes = await join(1, '  Ben  ');
    expect(yes.status).toBe(200);
    expect((await yes.json()).group).toEqual({ count: 2, names: ['Ben'], more: 0 });
  });

  it('the same person twice counts once; the inviter on their own link not at all', async () => {
    await join(1, 'Ben');
    await join(1, 'Ben');
    const own = await h.request('POST', `/api/invites/${code}/join`, { token: 'ms_ana', body: {} });
    expect((await own.json()).error).toBe('own_invite');
    expect((await invite()).group.count).toBe(2);
  });

  it('shows five names, then "+ N more"', async () => {
    for (let i = 1; i <= 7; i++) expect((await join(i, `P${i}`)).status).toBe(200);
    expect((await invite()).group).toEqual({ count: 8, names: ['P1', 'P2', 'P3', 'P4', 'P5'], more: 2 });
  });

  it("shows the group on the inviter's action page and on a joiner's", async () => {
    await join(1, 'Ben');
    const ana = await (await h.request('GET', `/api/actions/${action}/state`, { token: 'ms_ana' })).json();
    expect(ana.me.group).toMatchObject({ code, mine: true, count: 2, names: ['Ben'] });
    const ben = await (await h.request('GET', `/api/actions/${action}/state`, { headers: { 'X-HF-Guest': key(1) } })).json();
    expect(ben.me.group).toMatchObject({ code, mine: false, count: 2 });
  });

  it('leaving takes them out of the count', async () => {
    await join(1, 'Ben');
    expect((await h.request('DELETE', `/api/invites/${code}/join`, { headers: { 'X-HF-Guest': key(1) } })).status).toBe(200);
    expect((await invite()).group.count).toBe(1);
  });

  it('signing in later keeps them in the group', async () => {
    await join(1, 'Ben');
    h.fake.signIn('ms_ben', { id: 'mem_ben', firstName: 'Benjamin', email: 'ben@example.com' });
    await h.request('POST', '/api/me/claim-guest', { token: 'ms_ben', headers: { 'X-HF-Guest': key(1) } });
    expect((await invite()).group).toEqual({ count: 2, names: ['Benjamin'], more: 0 });
  });
});
