// Phase 1 acceptance checks from BRIEF.md, one describe block per check,
// plus the foundation rules they rest on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { createHarness, SITE, type Harness } from './harness';

let h: Harness;
let actionA: string;
let actionB: string;

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  actionB = h.fake.addAction('bake-for-a-neighbor', 'Bake for a neighbour', [CMS.actions.onMyOwnCompanionId, '6af7edb79fddcb1ec5b3d86e']);
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const minutes = (n: number) => n * 60 * 1000;
const deps = () => h.app.deps;

async function drainAll() {
  await h.settle();
  return drain(h.env, deps(), { limit: 100 });
}

// ---------------------------------------------------------------------------
describe('Check 1: a call with a forged or expired token is refused', () => {
  it('refuses a forged token', async () => {
    const res = await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_forged' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('signin_required');
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(0);
  });

  it('refuses a token that has expired since it was valid', async () => {
    h.fake.signIn('shcat_ana');
    expect((await h.request('GET', '/api/me', { token: 'shcat_ana' })).status).toBe(200);
    // Shopify stops accepting the token; the server's short cache runs out.
    h.fake.tokens.delete('shcat_ana');
    await h.env.CACHE.delete(`tok:${await sha('shcat_ana')}`);
    const res = await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    expect(res.status).toBe(401);
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(0);
  });

  it('refuses a missing token on every member call', async () => {
    for (const [method, path] of [
      ['POST', `/api/actions/${actionA}/done`],
      ['POST', '/api/suggestions'],
      ['POST', '/api/stories'],
      ['GET', '/api/me'],
      ['DELETE', '/api/me'],
      ['PATCH', '/api/me/settings'],
    ]) {
      const res = await h.request(method, path, { body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('reads identity from Shopify, never from the request', async () => {
    h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
    const res = await h.request('POST', '/api/suggestions', {
      token: 'shcat_ana',
      body: { text: 'Leave flowers on a doorstep', firstName: 'Mallory', email: 'mallory@evil.test', memberId: 99 },
    });
    expect(res.status).toBe(201);
    const [m] = await h.db<{ first_name: string; email: string }>('SELECT first_name, email FROM members');
    expect(m).toEqual({ first_name: 'Ana', email: 'ana@example.com' });
  });

  it('treats a Shopify outage as "try again", not as signed out', async () => {
    h.fake.signIn('shcat_ana');
    h.fake.shopifyDown = true;
    const res = await h.request('GET', '/api/me', { token: 'shcat_ana' });
    expect(res.status).toBe(503);
  });

  it('accepts calls only from the site\'s own domains', async () => {
    h.fake.signIn('shcat_ana');
    const evil = await h.request('GET', `/api/actions/${actionA}/state`, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const none = await h.request('GET', `/api/actions/${actionA}/state`, { origin: null });
    expect(none.status).toBe(403);
    const ok = await h.request('GET', `/api/actions/${actionA}/state`, { origin: 'https://happiness.foundation' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://happiness.foundation');
  });
});

// ---------------------------------------------------------------------------
describe('Check 2: a signed-out click on "I did this" completes after sign-in, on the same action', () => {
  it('saves the click, then completes it once on the same action after sign-in', async () => {
    // Signed out: the click is saved as an intent (bot protected).
    const saved = await h.request('POST', '/api/intents', {
      key: null,
      body: { kind: 'done', actionId: actionA, returnTo: `${SITE}/actions/compliment-a-stranger` },
      headers: { 'CF-Turnstile-Response': 'human-token' },
    });
    expect(saved.status).toBe(201);
    const { id } = await saved.json();

    // After sign-in the site completes it.
    h.fake.signIn('shcat_ana');
    const done = await h.request('POST', `/api/intents/${id}/complete`, { token: 'shcat_ana', key: null });
    expect(done.status).toBe(200);
    const body = await done.json();
    expect(body).toMatchObject({ kind: 'done', completed: true, actionId: actionA, returnTo: '/actions/compliment-a-stranger' });
    expect(body.result.tally).toBe(1);

    const stateA = await (await h.request('GET', `/api/actions/${actionA}/state`, { token: 'shcat_ana' })).json();
    const stateB = await (await h.request('GET', `/api/actions/${actionB}/state`, { token: 'shcat_ana' })).json();
    expect(stateA.me.done).toBe(true);
    expect(stateB.me.done).toBe(false);

    // Completing again (reload, double click) records nothing more.
    const again = await h.request('POST', `/api/intents/${id}/complete`, { token: 'shcat_ana', key: null });
    expect(again.status).toBe(200);
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(1);
  });

  it('refuses to save a signed-out click without the bot check', async () => {
    const res = await h.request('POST', '/api/intents', { key: null, body: { kind: 'done', actionId: actionA } });
    expect(res.status).toBe(403);
    const bad = await h.request('POST', '/api/intents', { key: null, body: { kind: 'done', actionId: actionA }, headers: { 'CF-Turnstile-Response': 'bot' } });
    expect(bad.status).toBe(403);
  });

  it('never sends the member to another website after sign-in', async () => {
    const res = await h.request('POST', '/api/intents', {
      key: null,
      body: { kind: 'join', inviteCode: 'k3x9', returnTo: 'https://evil.example/phish' },
      headers: { 'CF-Turnstile-Response': 'human-token' },
    });
    const { id } = await res.json();
    expect((await h.env.CACHE.get(`intent:${id}`, 'json') as { returnTo: unknown }).returnTo).toBeNull();
  });

  it('keeps typed text when sign-in expires mid-form and sends it after sign-in', async () => {
    const saved = await h.request('POST', '/api/intents', {
      key: null,
      body: { kind: 'suggestion', data: { text: 'Write a thank-you card to the bus driver' }, returnTo: '/suggest-an-action' },
      headers: { 'CF-Turnstile-Response': 'human-token' },
    });
    const { id } = await saved.json();
    // The form can read the text back while the member signs in again.
    const kept = await (await h.request('GET', `/api/intents/${id}`)).json();
    expect(kept.data.text).toBe('Write a thank-you card to the bus driver');
    h.fake.signIn('shcat_ana');
    const res = await h.request('POST', `/api/intents/${id}/complete`, { token: 'shcat_ana', key: null });
    expect(res.status).toBe(200);
    expect(await h.db('SELECT text FROM suggestions')).toEqual([{ text: 'Write a thank-you card to the bus driver' }]);
  });
});

// ---------------------------------------------------------------------------
describe('Check 3: a double click on any button creates one record', () => {
  beforeEach(() => void h.fake.signIn('shcat_ana'));

  async function doubleClick(method: string, path: string, body?: unknown) {
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
      h.request(method, path, { token: 'shcat_ana', key, body }),
      h.request(method, path, { token: 'shcat_ana', key, body }),
    ]);
    // A later retry with the same key gets the first answer back.
    const retry = await h.request(method, path, { token: 'shcat_ana', key, body });
    return { a, b, retry };
  }

  it('"I did this"', async () => {
    const { a, b, retry } = await doubleClick('POST', `/api/actions/${actionA}/done`);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([201]));
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(1);
  });

  it('send suggestion', async () => {
    await doubleClick('POST', '/api/suggestions', { text: 'Carry shopping for a neighbour' });
    expect(await h.db('SELECT * FROM suggestions')).toHaveLength(1);
    expect(await h.db('SELECT * FROM outbox')).toHaveLength(1);
    await drainAll();
    expect(h.fake.collection(CMS.suggestions.id)).toHaveLength(1);
  });

  it('send story', async () => {
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    await doubleClick('POST', '/api/stories', { actionId: actionA, text: 'She smiled all day.' });
    expect(await h.db('SELECT * FROM stories')).toHaveLength(1);
  });

  it('delete story', async () => {
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    const s = await (await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: actionA, text: 'Lovely.' } })).json();
    const { a, b } = await doubleClick('DELETE', `/api/stories/${s.id}`);
    expect([a.status, b.status]).toContain(200);
    expect(await h.db(`SELECT * FROM outbox WHERE op = 'webflow.delete'`)).toHaveLength(1);
  });

  it('settings', async () => {
    const { retry } = await doubleClick('PATCH', '/api/me/settings', { notifications: { invite_summary: false } });
    expect((await retry.json()).settings.invite_summary).toBe(false);
  });

  it('different clicks with different keys are separate records', async () => {
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(2);
  });

  it('refuses a write without a one-time key', async () => {
    const res = await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana', key: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('idempotency_key_required');
  });

  it('a lost Webflow answer does not create a second CMS item', async () => {
    h.fake.webflowLoseNextCreateResponse = true;
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Plant a tree with a neighbour' } });
    await h.settle();
    h.clock.advance(minutes(5));
    await drain(h.env, deps());
    expect(h.fake.collection(CMS.suggestions.id)).toHaveLength(1);
    const [s] = await h.db<{ cms_item_id: string }>('SELECT cms_item_id FROM suggestions');
    expect(s.cms_item_id).toBe(h.fake.collection(CMS.suggestions.id)[0].id);
  });
});

// ---------------------------------------------------------------------------
describe('Check 4: with Webflow\'s API switched off, a submission is saved and appears once it is back', () => {
  it('saves the suggestion, queues it, and writes it to Webflow when Webflow returns', async () => {
    h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
    h.fake.webflowDown = true;

    const res = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Teach a neighbour to ride a bike' } });
    expect(res.status).toBe(201);
    await h.settle();
    const [row] = await h.db<{ cms_item_id: string | null }>('SELECT cms_item_id FROM suggestions');
    expect(row.cms_item_id).toBeNull();
    const [q1] = await h.db<{ status: string; attempts: number }>('SELECT status, attempts FROM outbox');
    expect(q1).toMatchObject({ status: 'pending', attempts: 1 });

    // Still down at the next scheduled run.
    h.clock.advance(minutes(5));
    await drain(h.env, deps());
    expect(h.fake.collection(CMS.suggestions.id)).toHaveLength(0);

    // Webflow is back.
    h.fake.webflowDown = false;
    h.clock.advance(minutes(10));
    const r = await drain(h.env, deps());
    expect(r.done).toBe(1);
    const items = h.fake.collection(CMS.suggestions.id);
    expect(items).toHaveLength(1);
    expect(items[0].fieldData).toMatchObject({
      idea: 'Teach a neighbour to ride a bike',
      'submitted-by': 'Ana',
      email: 'ana@example.com',
      status: CMS.suggestions.status.new,
      slug: expect.stringMatching(/^suggestion-\d+$/),
    });
    const [after] = await h.db<{ cms_item_id: string }>('SELECT cms_item_id FROM suggestions');
    expect(after.cms_item_id).toBe(items[0].id);

    // Nothing more is sent on later runs.
    h.clock.advance(minutes(30));
    await drain(h.env, deps());
    expect(h.fake.collection(CMS.suggestions.id)).toHaveLength(1);
  });

  it('respects Webflow\'s rate limit by pausing until Retry-After', async () => {
    h.fake.signIn('shcat_ana');
    const real = h.fake.fetch;
    let limited = true;
    h.app.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (limited && String(input).startsWith('https://api.webflow.com')) {
        return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
      }
      return real(input, init);
    }) as typeof fetch;
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'One' } });
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Two' } });
    await h.settle();
    limited = false;
    h.clock.advance(30_000);
    const early = await drain(h.env, deps());
    expect(early.done).toBe(0);
    h.clock.advance(60_000);
    const later = await drain(h.env, deps());
    expect(later.done).toBe(2);
  });

  it('emails Mickey when a write keeps failing', async () => {
    h.fake.signIn('shcat_ana');
    h.fake.webflowDown = true;
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Refused by Webflow' } });
    await h.settle();
    h.fake.webflowDown = false;
    // Webflow refuses the write outright (a 4xx that is not a rate limit).
    h.app.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://api.webflow.com')
        ? new Response('{"message":"field validation failed"}', { status: 400 })
        : h.fake.fetch(input, init)) as typeof fetch;
    h.clock.advance(minutes(5));
    await drain(h.env, deps());
    h.app.deps.fetch = h.fake.fetch as typeof fetch;
    const [q] = await h.db<{ status: string }>('SELECT status FROM outbox');
    expect(q.status).toBe('dead');
    const mail = h.fake.emails.find((e) => e.to[0] === 'mickey@example.com');
    expect(mail?.subject).toContain('queue webflow.create');
    expect(mail?.text).toContain('field validation failed');
    expect(mail?.text).not.toContain('ana@'); // member emails are hidden in reports
  });
});

// ---------------------------------------------------------------------------
describe('Check 5: the sixth suggestion in a day is refused with a clear message', () => {
  it('allows five, refuses the sixth, and allows again the next day', async () => {
    h.fake.signIn('shcat_ana');
    for (let i = 1; i <= 5; i++) {
      const res = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: `Idea number ${i}` } });
      expect(res.status).toBe(201);
    }
    const sixth = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Idea number 6' } });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: 'daily_limit', message: 'You can send 5 suggestions a day. Please try again tomorrow.' });
    expect(await h.db('SELECT * FROM suggestions')).toHaveLength(5);

    h.clock.advance(24 * 60 * minutes(1));
    const nextDay = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Idea number 6' } });
    expect(nextDay.status).toBe(201);
  });

  it('a refused or invalid submission does not use up the allowance', async () => {
    h.fake.signIn('shcat_ana');
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: '' } });
    for (let i = 1; i <= 5; i++) {
      expect((await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: `Idea ${i}` } })).status).toBe(201);
    }
  });

  it('limits each member separately, and applies the done and story limits too', async () => {
    h.fake.signIn('shcat_ana');
    h.fake.signIn('shcat_ben', { firstName: 'Ben' });
    for (let i = 0; i < 10; i++) expect((await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' })).status).toBe(201);
    const eleventh = await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    expect(eleventh.status).toBe(429);
    expect((await eleventh.json()).message).toMatch(/10 actions/);
    expect((await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ben' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe('Check 6: existing done actions and likes for the test account appear after the import, on the right actions', () => {
  it('maps slugs to CMS item IDs and is safe to run twice', async () => {
    const customer = h.fake.signIn('shcat_test', { id: 'gid://shopify/Customer/7001', firstName: 'Tess', email: 'tess@example.com' });
    customer.actionsTaken = JSON.stringify([
      { idea: 'compliment-a-stranger', date: '2026-10-02T10:00:00Z' },
      { idea: 'bake-for-a-neighbor', date: '2026-10-05' },
      { idea: 'a-retired-action', date: '2026-09-01' },
    ]);
    customer.actionVotes = JSON.stringify({ 'compliment-a-stranger': { v: 1, d: '2026-10-02' }, 'bake-for-a-neighbor': { v: -1, d: '2026-10-06' } });

    const run = () => h.request('POST', '/api/admin/import', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' }, body: { customerId: '7001' } });
    const res = await run();
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ customers: 1, marksAdded: 2, likesAdded: 2 });
    expect(out.unmatched).toEqual([{ customer: 'gid://shopify/Customer/7001', slug: 'a-retired-action', kind: 'done' }]);

    // The member sees them on their account and on the right action pages.
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_test' })).json();
    expect(me.tally).toBe(2);
    expect(me.done.map((d: { actionId: string }) => d.actionId).sort()).toEqual([actionA, actionB].sort());
    const a = await (await h.request('GET', `/api/actions/${actionA}/state`, { token: 'shcat_test' })).json();
    expect(a.me).toMatchObject({ done: true, liked: true, lastDoneAt: '2026-10-02T10:00:00.000Z' });
    const b = await (await h.request('GET', `/api/actions/${actionB}/state`, { token: 'shcat_test' })).json();
    expect(b.me).toMatchObject({ done: true, liked: false });
    // "Don't like" is kept as a private signal only.
    expect(await h.db('SELECT value FROM likes WHERE action_id = ?1', actionB)).toEqual([{ value: -1 }]);

    const second = await (await run()).json();
    expect(second).toMatchObject({ marksAdded: 0, likesAdded: 0 });
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(2);
  });

  it('pages through every customer and reports bad metafield data', async () => {
    const c1 = h.fake.signIn('t1', { id: 'gid://shopify/Customer/1' });
    c1.actionsTaken = JSON.stringify([{ idea: 'compliment-a-stranger', date: 1730000000000 }]);
    const c2 = h.fake.signIn('t2', { id: 'gid://shopify/Customer/2' });
    c2.actionsTaken = '{not json';
    const out = await (await h.request('POST', '/api/admin/import', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' }, body: {} })).json();
    expect(out.marksAdded).toBe(1);
    expect(out.invalid).toEqual([{ customer: 'gid://shopify/Customer/2', reason: 'actions_taken is not valid JSON' }]);
    expect(out.nextCursor).toBeNull();
  });

  it('gets the Shopify Admin API token from the app ID and secret, reuses it, and renews it when refused', async () => {
    const c = h.fake.signIn('t1', { id: 'gid://shopify/Customer/1' });
    c.actionsTaken = JSON.stringify([{ idea: 'compliment-a-stranger', date: '2026-10-01' }]);
    const run = () => h.request('POST', '/api/admin/import', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' }, body: {} });
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    expect(h.fake.adminTokensIssued).toBe(1);
    // Shopify stops accepting the token (expired or revoked): a new one is fetched once.
    h.fake.adminToken = 'revoked';
    expect((await run()).status).toBe(200);
    expect(h.fake.adminTokensIssued).toBe(2);
  });

  it('is closed without the admin secret', async () => {
    const res = await h.request('POST', '/api/admin/import', { origin: null, key: null, headers: { Authorization: 'Bearer wrong' }, body: {} });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('Check 7: deleting a test member removes their stories and name; counts are unchanged', () => {
  async function setup() {
    // Ten other members have done action A, so its public count shows.
    for (let i = 0; i < 10; i++) {
      h.fake.signIn(`shcat_m${i}`, { firstName: `M${i}` });
      await h.request('POST', `/api/actions/${actionA}/done`, { token: `shcat_m${i}` });
    }
    h.fake.signIn('shcat_tess', { id: 'gid://shopify/Customer/7002', firstName: 'Tess', email: 'tess@example.com' });
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_tess' });
    await h.request('POST', '/api/stories', { token: 'shcat_tess', body: { actionId: actionA, text: 'We laughed a lot.' } });
    await h.request('POST', '/api/suggestions', { token: 'shcat_tess', body: { text: 'Shovel snow for a neighbour' } });
    await drainAll();
    // The story was approved and published on the site.
    await h.db(`UPDATE stories SET status = 'approved'`);
    h.fake.collection(CMS.stories.id).forEach((i) => (i.live = true));
    const before = await (await h.request('GET', `/api/actions/${actionA}/state`)).json();
    expect(before.count).toBe(11);
    expect(before.stories).toEqual([expect.objectContaining({ first_name: 'Tess', text: 'We laughed a lot.' })]);
  }

  async function verifyRemoved() {
    await drainAll();
    expect(await h.db('SELECT * FROM stories')).toHaveLength(0);
    expect(h.fake.collection(CMS.stories.id)).toHaveLength(0);
    const [sugItem] = h.fake.collection(CMS.suggestions.id);
    expect(sugItem.fieldData).toMatchObject({ 'submitted-by': '', email: '' });
    expect(await h.db('SELECT member_id FROM suggestions')).toEqual([{ member_id: null }]);
    const names = await h.db(`SELECT * FROM members WHERE first_name = 'Tess' OR email = 'tess@example.com' OR shopify_customer_id = 'gid://shopify/Customer/7002'`);
    expect(names).toHaveLength(0);
    const after = await (await h.request('GET', `/api/actions/${actionA}/state`)).json();
    expect(after.count).toBe(11);
    expect(after.stories).toEqual([]);
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(11);
  }

  it('when the member deletes their data from the account page', async () => {
    await setup();
    const res = await h.request('DELETE', '/api/me', { token: 'shcat_tess' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, storiesRemoved: 1 });
    await verifyRemoved();
  });

  it('when the customer is deleted in Shopify (webhook)', async () => {
    await setup();
    const body = JSON.stringify({ id: 7002 });
    const sig = await shopifySig('shopify_webhook_secret', body);
    const res = await h.app.handle(
      new Request(`${SITE}/join/api/webhooks/shopify`, {
        method: 'POST',
        headers: { 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': 'customers/delete', 'X-Shopify-Webhook-Id': 'wh-123456789' },
        body,
      }),
      h.env,
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    await verifyRemoved();
  });

  it('refuses a webhook with a bad signature', async () => {
    const res = await h.app.handle(
      new Request(`${SITE}/join/api/webhooks/shopify`, { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': 'forged', 'X-Shopify-Topic': 'customers/delete' }, body: '{"id":1}' }),
      h.env,
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(401);
  });

  it('a story deleted before Webflow saw it never reaches the site', async () => {
    h.fake.signIn('shcat_ana');
    h.fake.webflowDown = true;
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    const s = await (await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: actionA, text: 'Oops' } })).json();
    await h.request('DELETE', `/api/stories/${s.id}`, { token: 'shcat_ana' });
    h.fake.webflowDown = false;
    h.clock.advance(minutes(60));
    await drainAll();
    expect(h.fake.collection(CMS.stories.id)).toHaveLength(0);
  });

  it('a returning customer starts a fresh, empty account', async () => {
    await setup();
    await h.request('DELETE', '/api/me', { token: 'shcat_tess' });
    await h.env.CACHE.delete(`tok:${await sha('shcat_tess')}`);
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_tess' })).json();
    expect(me).toMatchObject({ firstName: 'Tess', tally: 0, stories: [] });
  });
});

// ---------------------------------------------------------------------------
describe('Foundation: email', () => {
  it('error reports are emailed to Mickey with details, once an hour per error', async () => {
    h.fake.signIn('shcat_ana');
    // Break the database table the route needs, to cause an unexpected error.
    await h.db('DROP TABLE suggestions');
    const res = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'x y z' } });
    expect(res.status).toBe(500);
    await h.settle();
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'x y z' } });
    await h.settle();
    const errors = h.fake.emails.filter((e) => e.to[0] === 'mickey@example.com');
    expect(errors).toHaveLength(1);
    expect(errors[0].subject).toContain('POST /api/suggestions');
    expect(errors[0].text).toContain('no such table: suggestions');
    expect(errors[0].text).not.toContain('shcat_ana');
  });

  it('member emails respect the setting and carry a working one-click unsubscribe link', async () => {
    const { memberEmail } = await import('../src/core/email');
    h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
    await h.request('GET', '/api/me', { token: 'shcat_ana' });
    const [m] = await h.db<never>('SELECT * FROM members');
    const msg = await memberEmail(h.env, m, 'story_approved', { actionTitle: 'Compliment a stranger' }, `${SITE}/join`);
    expect(msg!.text).toContain('Hi Ana,');
    expect(msg!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = /To stop these emails: (\S+)/.exec(msg!.text)![1];
    const off = await h.app.handle(new Request(link, { method: 'POST' }), h.env, { waitUntil: () => undefined });
    expect(off.status).toBe(200);
    const [after] = await h.db<never>('SELECT * FROM members');
    expect(await memberEmail(h.env, after, 'story_approved', {}, `${SITE}/join`)).toBeNull();
    // Other kinds are still on.
    expect(await memberEmail(h.env, after, 'suggestion_live', {}, `${SITE}/join`)).not.toBeNull();
    // A tampered link does nothing.
    const bad = await h.app.handle(new Request(link.replace('story_approved', 'pledge_reminder')), h.env, { waitUntil: () => undefined });
    expect(bad.status).toBe(400);
  });

  it('the four member emails read as plain text', async () => {
    const { memberEmail } = await import('../src/core/email');
    h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
    await h.request('GET', '/api/me', { token: 'shcat_ana' });
    const [m] = await h.db<never>('SELECT * FROM members');
    const summary = await memberEmail(h.env, m, 'invite_summary', { joinedNames: ['Ben', 'Cleo', 'Dan'], actionTitle: 'Bake for a neighbour' }, `${SITE}/join`);
    expect(summary!.subject).toBe('3 people joined your invite');
    expect(summary!.text).toContain('Ben, Cleo and Dan are in for "Bake for a neighbour".');
    for (const kind of ['suggestion_live', 'pledge_reminder'] as const) {
      const e = await memberEmail(h.env, m, kind, {}, `${SITE}/join`);
      expect(e!.text).not.toMatch(/<[a-z]/i);
    }
  });
});

describe('Foundation: scheduled jobs and action mirror', () => {
  it('the jobs endpoint needs its secret, drains the queue and syncs actions', async () => {
    expect((await h.request('POST', '/api/jobs/tick', { origin: null, key: null })).status).toBe(401);
    const res = await h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
    expect(res.status).toBe(200);
    expect((await res.json()).syncActions).toEqual({ published: 2, removed: 0 });
    const rows = await h.db<{ cms_item_id: string; can_do_with_others: number }>('SELECT cms_item_id, can_do_with_others FROM actions ORDER BY slug');
    // "Bake" can be done with friends; "Compliment" only on my own.
    expect(rows).toEqual([
      { cms_item_id: actionB, can_do_with_others: 1 },
      { cms_item_id: actionA, can_do_with_others: 0 },
    ]);
  });

  it('an unpublished action is marked removed and cannot be marked done', async () => {
    h.fake.signIn('shcat_ana');
    await h.request('POST', '/api/admin/sync-actions', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
    h.fake.collection(CMS.actions.id).find((i) => i.id === actionA)!.live = false;
    h.clock.advance(minutes(1));
    await h.request('POST', '/api/admin/sync-actions', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
    const res = await h.request('POST', `/api/actions/${actionA}/done`, { token: 'shcat_ana' });
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe('This action is no longer available.');
  });

  it('health shows missing configuration without revealing values', async () => {
    const res = await h.request('GET', '/api/health', { origin: null });
    expect(await res.json()).toEqual({ ok: true, environment: 'test', missing: [] });
  });
});

// ---------------------------------------------------------------------------

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function shopifySig(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...sig));
}
