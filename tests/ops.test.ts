// Drop sign-ups, Webflow webhooks, the daily backup and the /lab KPIs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { createHarness, type Harness } from './harness';

let h: Harness;
let actionA: string;

function addDrop(slug: string, status: string, onFrontPage = false) {
  h.fake.collection(CMS.drops.id).push({
    id: h.fake.newId(),
    isDraft: false,
    live: true,
    fieldData: { name: slug.replace(/-/g, ' '), slug, status, 'show-on-front-page': onFrontPage },
  });
}

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  addDrop('drop-01', CMS.drops.status.upcoming, true);
  addDrop('drop-00', CMS.drops.status.live);
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const human = { 'CF-Turnstile-Response': 'human-token' };
const notify = (body: unknown, opts: { token?: string; headers?: Record<string, string> } = {}) =>
  h.request('POST', '/api/drops/notify', { key: null, body, token: opts.token, headers: opts.headers });

describe('Drop "notify me" sign-ups', () => {
  it('a visitor signs up; Shopify gets a subscribed customer tagged for the drop; we keep no email', async () => {
    const res = await notify({ drop: 'drop-01', email: 'Visitor@Example.com' }, { headers: human });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ drop: 'drop-01', alreadySignedUp: false });
    await h.settle();
    await drain(h.env, h.app.deps);
    expect(h.fake.marketing.get('visitor@example.com')).toMatchObject({ tags: ['notify-drop-drop-01'], state: 'SUBSCRIBED' });
    const rows = await h.db<{ email_hash: string }>('SELECT * FROM drop_signups');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('example.com');
    const [q] = await h.db<{ payload: string; status: string }>('SELECT payload, status FROM outbox');
    expect(q.status).toBe('done');
    expect(q.payload).not.toContain('example.com');
  });

  it('the front-page drop is used when no drop is named', async () => {
    const res = await notify({ email: 'a@example.com' }, { headers: human });
    expect((await res.json()).drop).toBe('drop-01');
  });

  it('signing up twice counts once and writes to Shopify once', async () => {
    await notify({ drop: 'drop-01', email: 'a@example.com' }, { headers: human });
    const again = await (await notify({ drop: 'drop-01', email: 'A@example.com' }, { headers: human })).json();
    expect(again.alreadySignedUp).toBe(true);
    expect(await h.db('SELECT * FROM drop_signups')).toHaveLength(1);
    expect(await h.db('SELECT * FROM outbox')).toHaveLength(1);
  });

  it('an existing customer is tagged and subscribed, keeping their other tags', async () => {
    h.fake.marketing.set('old@example.com', { id: 'gid://shopify/Customer/5', tags: ['vip'], state: 'NOT_SUBSCRIBED' });
    await notify({ drop: 'drop-01', email: 'old@example.com' }, { headers: human });
    await h.settle();
    await drain(h.env, h.app.deps);
    expect(h.fake.marketing.get('old@example.com')).toMatchObject({ tags: ['vip', 'notify-drop-drop-01'], state: 'SUBSCRIBED' });
  });

  it('a signed-in member signs up with their account email and needs no bot check', async () => {
    h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
    const res = await notify({ drop: 'drop-01' }, { token: 'shcat_ana' });
    expect(res.status).toBe(201);
    await h.settle();
    await drain(h.env, h.app.deps);
    expect(h.fake.marketing.get('ana@example.com')).toMatchObject({ firstName: 'Ana', state: 'SUBSCRIBED' });
  });

  it('refuses without the bot check, a bad email, or a drop that is already live', async () => {
    expect((await notify({ drop: 'drop-01', email: 'a@example.com' })).status).toBe(403);
    expect((await notify({ drop: 'drop-01', email: 'not-an-email' }, { headers: human })).status).toBe(400);
    const live = await notify({ drop: 'drop-00', email: 'a@example.com' }, { headers: human });
    expect(live.status).toBe(409);
    expect((await live.json()).message).toMatch(/live now/);
  });

  it('a Shopify outage loses nothing: the sign-up is retried', async () => {
    h.fake.shopifyDown = true;
    const real = h.app.deps.fetch;
    h.app.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/admin/') ? new Response('{}', { status: 503 }) : real(input, init)) as typeof fetch;
    await notify({ drop: 'drop-01', email: 'b@example.com' }, { headers: human });
    await h.settle();
    h.app.deps.fetch = real;
    h.clock.advance(10 * 60 * 1000);
    await drain(h.env, h.app.deps);
    expect(h.fake.marketing.get('b@example.com')?.state).toBe('SUBSCRIBED');
  });
});

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

  it('a drop change clears the cached drop list', async () => {
    await h.env.CACHE.put('drops:list', '[]');
    await hook({ triggerType: 'collection_item_changed', payload: { id: 'x', collectionId: CMS.drops.id } });
    expect(await h.env.CACHE.get('drops:list')).toBeNull();
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
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ben' });
    await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', body: { liked: true } });
    await notify({ drop: 'drop-01', email: 'v@example.com' }, { headers: human });
    const k = await (await h.request('GET', '/api/lab/kpis', { token: 'shcat_ana' })).json();
    expect(k.impact).toMatchObject({ peopleMadeHappy: 3, peopleMadeHappy7d: 3, actionsEverDone: 1 });
    expect(k.engagement).toMatchObject({ members: 2, activeMembers7d: 2, likes: 1, dropSignups: 1 });
    expect(k.topActions[0]).toMatchObject({ title: 'Compliment a stranger', slug: 'compliment-a-stranger', people: 2, times: 3 });
    expect(k.daily).toEqual([{ day: '2026-11-16', done: 3 }]);
    expect(k.drops).toEqual([{ drop: 'drop-01', signups: 1 }]);
  });
});
