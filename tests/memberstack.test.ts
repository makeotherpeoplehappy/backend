// Foundation sign-in with Memberstack: who counts as signed in, how members
// from before the move are taken over, and the Memberstack webhook.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { svixSignature } from '../src/core/features/memberstack';
import { createHarness, SITE, type Harness } from './harness';

let h: Harness;
let actionA: string;

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

/** A member row from before the move: an old Shopify account ID. */
async function oldMember(email: string) {
  await h.db(
    `INSERT INTO members (account_id, first_name, email, created_at, updated_at) VALUES ('gid://shopify/Customer/55', 'Old', ?1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    email,
  );
  const [m] = await h.db<{ id: number }>(`SELECT id FROM members WHERE account_id = 'gid://shopify/Customer/55'`);
  await h.db(`INSERT INTO done_marks (member_id, action_id, done_at, action_title) VALUES (?1, ?2, '2026-11-02T00:00:00Z', 'Compliment a stranger')`, m.id, actionA);
  return m.id;
}

describe('Signing in with Memberstack', () => {
  it('takes over the member from before the move when the verified email matches', async () => {
    const id = await oldMember('tess@example.com');
    h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com' });
    const me = await (await h.request('GET', '/api/me', { token: 'ms_tess' })).json();
    expect(me.tally).toBe(1);
    expect(await h.db('SELECT id, account_id FROM members')).toEqual([{ id, account_id: 'mem_tess' }]);
  });

  it('an unverified email takes over nothing and is not stored', async () => {
    await oldMember('tess@example.com');
    h.fake.signIn('ms_x', { id: 'mem_x', email: 'tess@example.com', verified: false });
    const me = await (await h.request('GET', '/api/me', { token: 'ms_x' })).json();
    expect(me.tally).toBe(0);
    const rows = await h.db<{ account_id: string; email: string | null }>('SELECT account_id, email FROM members ORDER BY id');
    expect(rows).toEqual([
      { account_id: 'gid://shopify/Customer/55', email: 'tess@example.com' },
      { account_id: 'mem_x', email: null },
    ]);
  });

  it("refuses a token from another Memberstack app", async () => {
    h.fake.signIn('ms_other', { id: 'mem_other_1' });
    expect((await h.request('GET', '/api/me', { token: 'ms_other' })).status).toBe(401);
  });

  it('refuses a token Memberstack does not know', async () => {
    expect((await h.request('GET', '/api/me', { token: 'forged' })).status).toBe(401);
  });
});

describe('Memberstack webhook', () => {
  async function hook(event: string, memberId: string, opts: { secret?: string; at?: number } = {}) {
    const body = JSON.stringify({ event, payload: { id: memberId } });
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const ts = String(opts.at ?? Math.floor(h.clock.now.getTime() / 1000));
    const sig = await svixSignature(opts.secret ?? h.env.MEMBERSTACK_WEBHOOK_SECRET!, id, ts, body);
    return h.app.handle(
      new Request(`${SITE}/join/api/memberstack/webhook`, { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }, body }),
      h.env,
      { waitUntil: () => undefined },
    );
  }

  it('keeps the email in step and deletes the member when they are deleted in Memberstack', async () => {
    const tess = h.fake.signIn('ms_tess', { id: 'mem_tess', email: 'tess@example.com', firstName: 'Tess' });
    await h.request('POST', `/api/actions/${actionA}/done`, { token: 'ms_tess' });
    tess.email = 'tess@new.example';
    expect(await (await hook('member.updated', 'mem_tess')).json()).toMatchObject({ result: 'updated' });
    expect(await h.db('SELECT email FROM members')).toEqual([{ email: 'tess@new.example' }]);
    expect(await (await hook('member.deleted', 'mem_tess')).json()).toMatchObject({ result: 'deleted' });
    const [row] = await h.db<{ email: string | null; deleted_at: string | null }>('SELECT email, deleted_at FROM members');
    expect(row.email).toBeNull();
    expect(row.deleted_at).not.toBeNull();
  });

  it('refuses a wrong signature and an old delivery', async () => {
    expect((await hook('member.deleted', 'mem_x', { secret: 'whsec_' + btoa('wrong') })).status).toBe(401);
    expect((await hook('member.deleted', 'mem_x', { at: Math.floor(h.clock.now.getTime() / 1000) - 3600 })).status).toBe(401);
  });
});
