// Drop sign-ups, Webflow webhooks, the daily backup and the /lab KPIs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { createHarness, type Harness } from './harness';

let h: Harness;
let actionA: string;

function addDrop(slug: string, dropDate: string) {
  h.fake.shopCollections.set(slug, []);
  h.fake.dropCollections.set(slug, { title: slug.replace(/-/g, ' '), dropDate });
}

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  addDrop('drop-01', '2026-12-05T17:00:00.000Z');
  addDrop('drop-00', '2026-11-01T17:00:00.000Z');
  // Drop 00 is on sale now: one piece with stock.
  h.fake.shopCollections.set('drop-00', ['gid://shopify/Product/900']);
  h.fake.inventory.set('gid://shopify/Product/900', 5);
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const human = { 'CF-Turnstile-Response': 'human-token' };


describe('Webflow webhooks', () => {
  const hook = (body: unknown) => h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body });

  it('a changed action is re-read from Webflow straight away', async () => {
    await h.request('GET', '/api/actions/compliment-a-stranger/state');
    const item = h.fake.collection(CMS.actions.id).find((i) => i.id === actionA)!;
    item.fieldData.name = 'Compliment someone you do not know';
    item.fieldData['do-it-with'] = ['6af7edb79fddcb1ec5b3d86e'];
    const res = await hook({ triggerType: 'collection_item_changed', payload: { id: actionA, collectionId: CMS.actions.id, fieldData: { name: 'forged' } } });
    expect(await res.json()).toMatchObject({ live: true });
    const [row] = await h.db<{ title: string; can_do_with_others: number }>('SELECT title, can_do_with_others FROM actions');
    expect(row).toEqual({ title: 'Compliment someone you do not know', can_do_with_others: 1 });
  });

  it('an unpublished action is marked removed', async () => {
    await h.request('GET', '/api/actions/compliment-a-stranger/state');
    h.fake.collection(CMS.actions.id).find((i) => i.id === actionA)!.live = false;
    await hook({ triggerType: 'collection_item_unpublished', payload: { id: actionA, collectionId: CMS.actions.id } });
    expect(await h.db('SELECT status FROM actions')).toEqual([{ status: 'removed' }]);
  });



  it('ignores floods beyond the per-minute cap', async () => {
    for (let i = 0; i < 120; i++) await hook({ triggerType: 'collection_item_changed', payload: { collectionId: 'other' } });
    expect((await (await hook({ triggerType: 'site_publish' })).json()).ignored).toBe('rate limit');
  });
});

describe('Daily backup', () => {
  it('writes every table to object storage once a day and keeps 30 days', async () => {
    h.fake.signIn('shcat_ana');
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ana' });
    await h.env.MEDIA.put('backups/2026-09-01.json', '{}');
    const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
    const out = (await (await tick()).json()).backup;
    expect(out).toMatchObject({ key: 'backups/2026-11-16.json', removedOld: 1 });
    expect(out.tables).toBeGreaterThan(10);
    const obj = await h.env.MEDIA.get('backups/2026-11-16.json');
    const data = JSON.parse(await obj!.text());
    expect(data.tables.done_marks).toHaveLength(1);
    expect(await h.env.MEDIA.get('backups/2026-09-01.json')).toBeNull();
    expect((await (await tick()).json()).backup).toBeUndefined();
  });
});

describe('/lab access managed on the page', () => {
  beforeEach(() => {
    h.env.LAB_EMAILS = 'Owner One <owner@example.com>; second@example.com';
    h.fake.signIn('shcat_owner', { email: 'owner@example.com' });
    h.fake.signIn('shcat_guest', { email: 'guest@example.com' });
  });
  const access = (method: string, token: string, body?: unknown) => h.request(method, '/api/lab/access', { token, body, key: null });

  it('owners written with names or semicolons still work', async () => {
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_owner' })).status).toBe(200);
  });

  it('lists the writes that failed, with what and why', async () => {
    await h.env.DB.prepare(
      `INSERT INTO outbox (target, op, payload, dedupe_key, status, attempts, last_error, next_attempt_at, created_at, updated_at)
       VALUES ('memberstack', 'task', '{}', 'active-plan:1:off:2026-11-18T08:20', 'dead', 25, 'Memberstack remove-plan 404', '2026-11-18T08:20:00Z', '2026-11-18T08:20:00Z', '2026-11-18T09:00:00Z')`,
    ).run();
    const k = await (await h.request('GET', '/api/lab/kpis', { token: 'shcat_owner' })).json();
    expect(k.health.queueFailed).toBe(1);
    expect(k.health.failedWrites).toEqual([
      { what: 'active-plan:1:off:2026-11-18T08:20', target: 'memberstack', attempts: 25, error: 'Memberstack remove-plan 404', at: '2026-11-18T09:00:00Z' },
    ]);
  });

  it('a failed write can be dismissed or tried again from the Lab, by Lab people only', async () => {
    const add = (key: string) => h.env.DB.prepare(
      `INSERT INTO outbox (target, op, payload, dedupe_key, status, attempts, last_error, next_attempt_at, created_at, updated_at)
       VALUES ('email', 'email.send', '{}', ?1, 'dead', 1, 'Resend failed (422)', '2026-11-17T22:05:44Z', '2026-11-17T22:05:44Z', '2026-11-17T22:05:44Z')`,
    ).bind(key).run();
    await add('partner-report:2:2026-10');
    await add('partner-report:2:2026-11');
    const failed = (body: unknown, token = 'shcat_owner') => h.request('POST', '/api/lab/failed', { token, body, key: null });
    expect((await failed({ what: 'partner-report:2:2026-10', do: 'dismiss' }, 'shcat_guest')).status).toBe(403);
    expect((await failed({ what: 'partner-report:2:2026-10', do: 'dismiss' })).status).toBe(200);
    expect((await failed({ what: 'partner-report:2:2026-10', do: 'dismiss' })).status).toBe(404);
    expect((await failed({ what: 'partner-report:2:2026-11', do: 'retry' })).status).toBe(200);
    expect((await failed({ what: 'x', do: 'delete' })).status).toBe(400);
    const rows = await h.db<{ dedupe_key: string; status: string; attempts: number }>(`SELECT dedupe_key, status, attempts FROM outbox WHERE dedupe_key LIKE 'partner-report:2:%' ORDER BY dedupe_key`);
    expect(rows[0]).toMatchObject({ status: 'dismissed' });
    expect(rows[1].status).not.toBe('dead');
    const k = await (await h.request('GET', '/api/lab/kpis', { token: 'shcat_owner' })).json();
    expect(k.health.failedWrites.map((f: { what: string }) => f.what)).not.toContain('partner-report:2:2026-10');
  });

  it('an owner invites someone: they get access and an invitation email, no redeploy', async () => {
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_guest' })).status).toBe(403);
    const r = await (await access('POST', 'shcat_owner', { email: 'Guest@Example.com' })).json();
    expect(r).toMatchObject({ added: true, owners: ['owner@example.com', 'second@example.com'] });
    expect(r.invited[0]).toMatchObject({ email: 'guest@example.com', addedBy: 'owner@example.com' });
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_guest' })).status).toBe(200);
    await h.settle();
    await drain(h.env, h.app.deps);
    const mail = h.fake.emails.find((e) => e.to[0] === 'guest@example.com');
    expect(mail?.subject).toBe('You can now see the Happiness Lab');
    expect(mail?.text).toContain('/lab');
  });

  it('invited people can be removed, owners cannot', async () => {
    await access('POST', 'shcat_owner', { email: 'guest@example.com' });
    await access('DELETE', 'shcat_owner', { email: 'guest@example.com' });
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_guest' })).status).toBe(403);
    expect((await access('DELETE', 'shcat_owner', { email: 'second@example.com' })).status).toBe(400);
  });

  it('someone without access cannot see or change the list, and is told which account they used', async () => {
    const r = await access('POST', 'shcat_guest', { email: 'guest@example.com' });
    expect(r.status).toBe(403);
    expect((await r.json()).message).toContain('gu…@example.com');
    expect((await access('GET', 'shcat_guest')).status).toBe(403);
  });

  it('refuses a bad address', async () => {
    expect((await access('POST', 'shcat_owner', { email: 'nope' })).status).toBe(400);
  });
});

describe('Public impact numbers', () => {
  it('counts people made happy, actions to choose from and stories on the site, for anyone', async () => {
    h.fake.signIn('shcat_ana', { email: 'ana@example.com' });
    h.fake.signIn('shcat_ben', { email: 'ben@example.com' });
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ana' });
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ben' });
    const res = await h.request('GET', '/api/impact');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ peopleMadeHappy: 2, actions: 1, stories: 0 });
  });
});

describe('/lab KPIs', () => {
  it('only accounts on the allow-list can read them', async () => {
    h.fake.signIn('shcat_ana', { email: 'ana@example.com' });
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_ana' })).status).toBe(403);
    h.env.LAB_EMAILS = 'boss@example.com';
    expect((await h.request('GET', '/api/lab/kpis', { token: 'shcat_ana' })).status).toBe(403);
    expect((await h.request('GET', '/api/lab/kpis')).status).toBe(401);
  });

  it('reports impact and engagement', async () => {
    h.env.LAB_EMAILS = 'Ana@Example.com, boss@example.com';
    h.fake.signIn('shcat_ana', { email: 'ana@example.com' });
    h.fake.signIn('shcat_ben', { email: 'ben@example.com' });
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ana' });
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ben' });
    h.clock.advance(24 * 60 * 60 * 1000);
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ben' });
    await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', body: { liked: true } });
    const k = await (await h.request('GET', '/api/lab/kpis', { token: 'shcat_ana' })).json();
    expect(k.impact).toMatchObject({ peopleMadeHappy: 3, peopleMadeHappy7d: 3, actionsEverDone: 1 });
    expect(k.engagement).toMatchObject({ members: 2, activeMembers7d: 2, likes: 1 });
    expect(k.topActions[0]).toMatchObject({ title: 'Compliment a stranger', slug: 'compliment-a-stranger', people: 2, times: 3 });
    expect(k.daily).toEqual([
      { day: '2026-11-16', done: 2 },
      { day: '2026-11-17', done: 1 },
    ]);
  });
});
