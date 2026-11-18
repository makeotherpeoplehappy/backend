// Live activity line: the last few anonymous "I did this", newest first, with the
// kind of person made happy and the doer's home area (never a name).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { syncActions } from '../src/core/features/actions';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.settle(); await h.mf.dispose(); });

function action(slug: string, title: string, fields: Record<string, unknown> = {}) {
  const id = h.fake.addAction(slug, title);
  Object.assign(h.fake.collection(CMS.actions.id).find((i) => i.id === id)!.fieldData, fields);
  return id;
}
const guestDone = (id: string, n: number) =>
  h.request('POST', `/api/actions/${id}/done`, { headers: { 'X-HF-Guest': `guest-key-live-${String(n).padStart(10, '0')}`, 'CF-Connecting-IP': `10.0.1.${n}` } });

describe('Recent activity', () => {
  it('lists recent dones anonymously, newest first, with who and place', async () => {
    const whoSlugs = CMS.actions.whoSlugs as Record<string, string>;
    const strangerId = Object.keys(whoSlugs).find((k) => whoSlugs[k] === 'stranger')!;
    const a = action('compliment-a-stranger', 'Compliment a stranger', { who: [strangerId] });
    const b = action('cook-for-friends', 'Cook for friends');
    const hidden = action('secret', 'Secret', { hidden: true });
    await syncActions(h.env, h.app.deps);
    expect((await guestDone(a, 1)).status).toBe(201);
    h.clock.advance(60_000);
    expect((await guestDone(b, 2)).status).toBe(201);
    expect((await guestDone(hidden, 3)).status).toBe(201);
    await h.env.DB.prepare(`UPDATE members SET home_area = 'copenhagen' WHERE account_id LIKE 'guest:%' AND id = (SELECT member_id FROM done_marks WHERE action_id = ?1)`).bind(a).run();
    const body = await (await h.request('GET', '/api/activity')).json();
    expect(body.items.length).toBe(2);
    expect(body.items[1]).toMatchObject({ who: 'stranger', place: 'copenhagen' });
    expect(body.items[0]).toMatchObject({ who: null, place: null });
    expect(JSON.stringify(body)).not.toMatch(/guest|member|name|email/i);
  });
});
