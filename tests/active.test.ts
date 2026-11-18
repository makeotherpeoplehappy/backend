// Active membership: someone is Active after making someone happy in at least
// 4 of the last 5 weeks (Monday to Sunday, UTC). The "people made happy" total
// counts each action's "how many", the same way as the ripple.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { syncActions } from '../src/core/features/actions';
import { refreshAllActive } from '../src/core/features/active';
import { drain } from '../src/core/queue';
import { createHarness, type Harness } from './harness';

const planCalls = () =>
  h.fake.calls
    .filter((c) => /admin\.memberstack\.com\/members\/[^/]+\/(add|remove)-plan$/.test(c.url))
    .map((c) => `${c.url.split('/').pop()} ${(c.body as { planId: string }).planId}`);

let h: Harness;
const WEEK = 7 * 24 * 60 * 60 * 1000;
beforeEach(async () => {
  h = await createHarness();
  h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
});
afterEach(async () => { await h.settle(); await h.mf.dispose(); });

const done = (id: string) => h.request('POST', `/api/actions/${id}/done`, { token: 'shcat_ana' });
const me = async () => (await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json());

describe('Active membership', () => {
  it('becomes Active after 4 of 5 weeks, survives one missed week, and drops out after two', async () => {
    const a = h.fake.addAction('call-a-friend', 'Call a friend');
    await syncActions(h.env, h.app.deps);
    for (let w = 0; w < 3; w++) { expect((await done(a)).status).toBe(201); h.clock.advance(WEEK); }
    let m = await me();
    expect(m.active.active).toBe(false);
    expect(m.active.weeksDone).toBe(3);
    expect(m.active.toGo).toBe(1);
    expect((await done(a)).status).toBe(201);
    m = await me();
    expect(m.active).toMatchObject({ active: true, weeksDone: 4, thisWeekDone: true, toGo: 0 });
    expect(m.active.since).toBeTruthy();
    // One quiet week: still 4 of the last 5.
    h.clock.advance(WEEK);
    await refreshAllActive(h.env, h.app.deps);
    m = await me();
    expect(m.active.active).toBe(true);
    expect(m.active.thisWeekDone).toBe(false);
    // A second quiet week: 3 of 5, no longer Active (and nothing calls it "Inactive").
    h.clock.advance(WEEK);
    const r = await refreshAllActive(h.env, h.app.deps);
    expect(r.active).toBe(0);
    m = await me();
    expect(m.active.active).toBe(false);
    expect(m.active.toGo).toBeGreaterThan(0);
    expect(JSON.stringify(m.active)).not.toMatch(/inactive/i);
  });

  it('undo can take Active status away again', async () => {
    const a = h.fake.addAction('call-a-friend', 'Call a friend');
    await syncActions(h.env, h.app.deps);
    for (let w = 0; w < 3; w++) { await done(a); h.clock.advance(WEEK); }
    await done(a);
    expect((await me()).active.active).toBe(true);
    await h.request('DELETE', `/api/actions/${a}/done`, { token: 'shcat_ana' });
    expect((await me()).active.active).toBe(false);
  });
});

describe('People made happy', () => {
  it('counts each action by its "how many", in the account, after I did this and on the home page', async () => {
    const few = Object.keys(CMS.actions.howManyPeople as Record<string, number>).find((k) => (CMS.actions.howManyPeople as Record<string, number>)[k] === 3)!;
    const a = h.fake.addAction('cook-for-friends', 'Cook for friends');
    Object.assign(h.fake.collection(CMS.actions.id).find((i) => i.id === a)!.fieldData, { 'how-many': few });
    await syncActions(h.env, h.app.deps);
    const r = await (await done(a)).json();
    expect(r.tally).toBe(3);
    expect((await me()).tally).toBe(3);
    const impact = await (await h.request('GET', '/api/impact')).json();
    expect(impact.peopleMadeHappy).toBe(3);
  });

  it('keeps the Memberstack plan in step: Inactive for everyone first, Active once earned, back on drop-out', async () => {
    const a = h.fake.addAction('call-a-friend', 'Call a friend');
    await syncActions(h.env, h.app.deps);
    await me();
    // Backfill: a signed-up member with no plan yet gets Inactive.
    expect((await refreshAllActive(h.env, h.app.deps)).synced).toBe(1);
    await h.settle(); await drain(h.env, h.app.deps);
    expect(planCalls()).toEqual(['add-plan pln_inactive-un8s0xdg', 'remove-plan pln_active-er8r0xp0']);
    // Nothing to do on the next run.
    expect((await refreshAllActive(h.env, h.app.deps)).synced).toBe(0);
    h.fake.calls.length = 0;
    for (let w = 0; w < 3; w++) { await done(a); h.clock.advance(WEEK); }
    await done(a);
    await h.settle(); await drain(h.env, h.app.deps);
    expect(planCalls()).toEqual(['add-plan pln_active-er8r0xp0', 'remove-plan pln_inactive-un8s0xdg']);
    h.fake.calls.length = 0;
    await h.request('DELETE', `/api/actions/${a}/done`, { token: 'shcat_ana' });
    await h.settle(); await drain(h.env, h.app.deps);
    expect(planCalls()).toEqual(['add-plan pln_inactive-un8s0xdg', 'remove-plan pln_active-er8r0xp0']);
  });

  it('a plan the member never had counts as removed, so nothing is left failing', async () => {
    h.fake.planNotFound = true;
    await me();
    await refreshAllActive(h.env, h.app.deps);
    await h.settle(); await drain(h.env, h.app.deps);
    expect(await h.db(`SELECT status FROM outbox WHERE dedupe_key LIKE 'active-plan:%'`)).toEqual([{ status: 'done' }]);
  });
});
