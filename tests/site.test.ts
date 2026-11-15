// What the site needs from the backend: actions by address, likes, the
// member's tally, slugs on the account, and the timer-run import.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
let actionA: string;

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  h.fake.signIn('shcat_ana', { firstName: 'Ana' });
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });

describe('Actions by address', () => {
  it('a page can use its address instead of the CMS item ID', async () => {
    const state = await (await h.request('GET', '/api/actions/compliment-a-stranger/state', { token: 'shcat_ana' })).json();
    expect(state).toMatchObject({ actionId: actionA, live: true, me: { done: false, tally: 0 } });
    const done = await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ana' });
    expect(done.status).toBe(201);
    const [mark] = await h.db<{ action_id: string }>('SELECT action_id FROM done_marks');
    expect(mark.action_id).toBe(actionA);
    const after = await (await h.request('GET', '/api/actions/compliment-a-stranger/state', { token: 'shcat_ana' })).json();
    expect(after.me).toMatchObject({ done: true, tally: 1 });
  });

  it('an unknown address is "no longer available"', async () => {
    const res = await h.request('GET', '/api/actions/no-such-action/state');
    expect(res.status).toBe(404);
  });

  it('a renamed action is found by its new address', async () => {
    await h.request('GET', '/api/actions/compliment-a-stranger/state');
    h.fake.collection('6af7ebcaa5421969142eccae').find((i) => i.id === actionA)!.fieldData.slug = 'compliment-someone';
    const res = await h.request('GET', '/api/actions/compliment-someone/state');
    expect((await res.json()).actionId).toBe(actionA);
  });
});

describe('Likes', () => {
  it('like and unlike, once per click', async () => {
    const key = crypto.randomUUID();
    expect((await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', key, body: { liked: true } })).status).toBe(200);
    await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', key, body: { liked: true } });
    expect(await h.db('SELECT value FROM likes')).toEqual([{ value: 1 }]);
    const s = await (await h.request('GET', `/api/actions/${actionA}/state`, { token: 'shcat_ana' })).json();
    expect(s.me.liked).toBe(true);
    await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', body: { liked: false } });
    expect(await h.db('SELECT value FROM likes')).toEqual([]);
  });

  it('needs sign-in, and a signed-out like completes after sign-in', async () => {
    expect((await h.request('PUT', '/api/actions/compliment-a-stranger/like', { body: { liked: true } })).status).toBe(401);
    const saved = await h.request('POST', '/api/intents', {
      key: null,
      body: { kind: 'like', actionId: actionA, returnTo: '/action/compliment-a-stranger' },
      headers: { 'CF-Turnstile-Response': 'human-token' },
    });
    const { id } = await saved.json();
    const res = await (await h.request('POST', `/api/intents/${id}/complete`, { token: 'shcat_ana', key: null })).json();
    expect(res).toMatchObject({ kind: 'like', completed: true, returnTo: '/action/compliment-a-stranger' });
    expect(await h.db('SELECT value FROM likes')).toEqual([{ value: 1 }]);
  });

  it('unliking keeps an imported "don\'t like" as a private signal', async () => {
    await h.request('GET', '/api/me', { token: 'shcat_ana' });
    await h.db(`INSERT INTO likes (member_id, action_id, value, updated_at, source) SELECT id, ?1, -1, '2026-01-01', 'import' FROM members`, actionA);
    await h.request('PUT', '/api/actions/compliment-a-stranger/like', { token: 'shcat_ana', body: { liked: false } });
    expect(await h.db('SELECT value FROM likes')).toEqual([{ value: -1 }]);
  });
});

describe('Account for the site', () => {
  it('done actions carry their address so the site can link to them', async () => {
    await h.request('POST', '/api/actions/compliment-a-stranger/done', { token: 'shcat_ana' });
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json();
    expect(me.done[0]).toMatchObject({ actionId: actionA, slug: 'compliment-a-stranger', title: 'Compliment a stranger' });
  });
});

describe('Import run by the timer', () => {
  it('imports once, again a day later, then never again', async () => {
    const c = h.fake.customers.find((x) => x.id)!;
    c.actionsTaken = JSON.stringify([{ idea: 'compliment-a-stranger', date: '2026-10-01' }]);
    expect((await (await tick()).json()).importMetafields).toMatchObject({ pass: 1, finished: true, marksAdded: 1 });
    expect((await (await tick()).json()).importMetafields).toBeUndefined();

    // A page still open during the switch wrote one more mark.
    c.actionsTaken = JSON.stringify([
      { idea: 'compliment-a-stranger', date: '2026-10-01' },
      { idea: 'compliment-a-stranger', date: '2026-11-15T21:00:00Z' },
    ]);
    h.clock.advance(25 * 60 * 60 * 1000);
    expect((await (await tick()).json()).importMetafields).toMatchObject({ pass: 2, marksAdded: 1 });
    h.clock.advance(25 * 60 * 60 * 1000);
    expect((await (await tick()).json()).importMetafields).toBeUndefined();
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(2);
  });
});
