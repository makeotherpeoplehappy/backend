// Try before sign-up: "I did this" without an account, kept on the device by a
// guest key, moved to the account on sign-in, expired after 30 days unclaimed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
let a: string;
let b: string;
const KEY = 'guest-key-0123456789abcdef';
const OTHER = 'guest-key-zyxwvutsrqponmlk';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  h = await createHarness();
  a = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  b = h.fake.addAction('bake-for-a-neighbor', 'Bake for a neighbour');
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const guestDone = (action: string, key = KEY, ip = '1.2.3.4') => h.request('POST', `/api/actions/${action}/done`, { headers: { 'X-HF-Guest': key, 'CF-Connecting-IP': ip } });
const guestState = async (action: string, key = KEY) => (await (await h.request('GET', `/api/actions/${action}/state`, { headers: { 'X-HF-Guest': key } })).json()).me;

describe('Without an account', () => {
  it('marks done, shows it on the action page, and undoes', async () => {
    const r = await guestDone(a);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.guest).toBe(true);
    expect(body.tally).toBe(1);
    expect(await guestState(a)).toMatchObject({ done: true, guest: true, timesDone: 1, canUndo: true });
    // Only a hash of the key is stored.
    const guests = await h.db<{ account_id: string }>(`SELECT account_id FROM members WHERE account_id LIKE 'guest:%'`);
    expect(guests).toHaveLength(1);
    expect(guests[0].account_id).not.toContain(KEY);

    const u = await h.request('DELETE', `/api/actions/${a}/done`, { headers: { 'X-HF-Guest': KEY } });
    expect(u.status).toBe(200);
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(0);
  });

  it('needs a guest key or a sign-in', async () => {
    const r = await h.request('POST', `/api/actions/${a}/done`);
    expect(r.status).toBe(401);
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(0);
  });

  it('counts once per action per day, so public counts cannot be pushed up', async () => {
    expect((await guestDone(a)).status).toBe(201);
    const again = await guestDone(a);
    expect(again.status).toBe(429);
    expect((await again.json()).error).toBe('guest_done_today');
    expect((await guestDone(b)).status).toBe(201);
    h.clock.advance(DAY);
    expect((await guestDone(a)).status).toBe(201);
  });

  it('limits new guests from one network in a day', async () => {
    for (let i = 0; i < 30; i++) expect((await guestDone(a, `guest-key-many-${String(i).padStart(10, '0')}`)).status).toBe(201);
    expect((await guestDone(a, 'guest-key-one-too-many-000')).status).toBe(429);
    // Someone on another network is not affected.
    expect((await guestDone(a, 'guest-key-elsewhere-00000', '5.6.7.8')).status).toBe(201);
  });

  it('counts in public totals like any other mark', async () => {
    await guestDone(a);
    await guestDone(a, OTHER);
    const n = await h.db<{ n: number }>(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks WHERE action_id = ?1`, a);
    expect(n[0].n).toBe(2);
  });
});

describe('Signing in keeps it', () => {
  it('moves the marks to the account without duplicates, then forgets the guest', async () => {
    await guestDone(a);
    await guestDone(b);
    // Ana also marked action a herself today: that is the same deed.
    expect((await h.request('POST', `/api/actions/${a}/done`, { token: 'ms_ana' })).status).toBe(201);

    const r = await h.request('POST', '/api/me/claim-guest', { token: 'ms_ana', headers: { 'X-HF-Guest': KEY } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ merged: 1, duplicates: 1 });

    const me = await (await h.request('GET', `/api/actions/${b}/state`, { token: 'ms_ana' })).json();
    expect(me.me).toMatchObject({ done: true, tally: 2 });
    expect(await h.db(`SELECT * FROM members WHERE account_id LIKE 'guest:%'`)).toHaveLength(0);
    // The key no longer finds anything, and claiming again does nothing.
    expect(await guestState(b)).toBeUndefined();
    const again = await h.request('POST', '/api/me/claim-guest', { token: 'ms_ana', headers: { 'X-HF-Guest': KEY } });
    expect(await again.json()).toMatchObject({ merged: 0 });
  });

  it('is not counted as a member in the Lab numbers', async () => {
    await guestDone(a);
    await h.request('GET', '/api/me', { token: 'ms_ana' });
    const live = await h.db<{ n: number }>(
      `SELECT COUNT(*) AS n FROM members WHERE deleted_at IS NULL AND account_id NOT LIKE 'guest:%' AND account_id NOT LIKE 'expired:%' AND account_id NOT LIKE 'merged:%'`,
    );
    expect(live[0].n).toBe(1);
  });
});

describe('After 30 days unclaimed', () => {
  it('can no longer be claimed, but stays in the public totals', async () => {
    await guestDone(a);
    h.clock.advance(31 * DAY);
    const { expireGuests } = await import('../src/core/features/guests');
    expect(await expireGuests(h.env, h.app.deps)).toEqual({ expired: 1 });
    expect(await guestState(a)).toBeUndefined();
    const r = await h.request('POST', '/api/me/claim-guest', { token: 'ms_ana', headers: { 'X-HF-Guest': KEY } });
    expect(await r.json()).toMatchObject({ merged: 0 });
    expect(await h.db('SELECT * FROM done_marks')).toHaveLength(1);
  });

  it('a guest still using the site does not expire', async () => {
    await guestDone(a);
    h.clock.advance(20 * DAY);
    await guestDone(b);
    h.clock.advance(20 * DAY);
    const { expireGuests } = await import('../src/core/features/guests');
    expect(await expireGuests(h.env, h.app.deps)).toEqual({ expired: 0 });
  });
});
