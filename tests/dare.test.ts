// Weekly dare: one global week (Monday 00:00 to Sunday 23:59 UTC), one action,
// a count of people from 10 up, and warnings in the Lab for dares that can't run.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { syncActions } from '../src/core/features/actions';
import { dareWarnings, weekStart } from '../src/core/features/dare';
import { createHarness, type Harness } from './harness';

let h: Harness;
const DAY = 24 * 60 * 60 * 1000;
// The harness clock starts on Monday 16 November 2026, 09:00 UTC.
const MONDAY = '2026-11-16T00:00:00.000Z';

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

function action(slug: string, title: string, fields: Record<string, unknown> = {}) {
  const id = h.fake.addAction(slug, title);
  Object.assign(h.fake.collection(CMS.actions.id).find((i) => i.id === id)!.fieldData, fields);
  return id;
}
const sync = () => syncActions(h.env, h.app.deps);
const dare = async () => (await (await h.request('GET', '/api/dare')).json()).dare;
const guestDone = (id: string, n: number) =>
  h.request('POST', `/api/actions/${id}/done`, { headers: { 'X-HF-Guest': `guest-key-dare-${String(n).padStart(10, '0')}`, 'CF-Connecting-IP': `10.0.0.${n}` } });

describe('Which action is the dare', () => {
  it('weeks start on Monday 00:00 UTC', () => {
    expect(weekStart(new Date('2026-11-22T23:59:00Z')).toISOString()).toBe(MONDAY);
    expect(weekStart(new Date('2026-11-16T00:00:00Z')).toISOString()).toBe(MONDAY);
    expect(weekStart(new Date('2026-11-23T00:00:00Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  it('none set: no dare (the block hides)', async () => {
    action('a', 'Compliment a stranger');
    await sync();
    expect(await dare()).toBeNull();
  });

  it("this week's date is the dare; last week's and next week's are not", async () => {
    action('old', 'Last week', { 'weekly-dare-from': '2026-11-09T00:00:00Z' });
    const now = action('now', 'This week', { 'weekly-dare-from': MONDAY });
    action('next', 'Next week', { 'weekly-dare-from': '2026-11-23T00:00:00Z' });
    await sync();
    expect(await dare()).toMatchObject({ actionId: now, slug: 'now', title: 'This week', count: null, weekStart: MONDAY });
    // Next Monday the next one takes over.
    h.clock.advance(7 * DAY);
    expect((await dare()).slug).toBe('next');
  });

  it('skips location-specific and hidden actions, and warns in the Lab', async () => {
    action('local', 'Local thing', { 'weekly-dare-from': MONDAY, 'location-specific': true });
    action('secret', 'Hidden thing', { 'weekly-dare-from': MONDAY, hidden: true });
    await sync();
    expect(await dare()).toBeNull();
    const w = await dareWarnings(h.env, h.app.deps);
    expect(w.join('\n')).toContain('"Local thing" is set as the weekly dare but is location-specific');
    expect(w.join('\n')).toContain('"Hidden thing" is set as the weekly dare but is hidden');
  });

  it('two on the same date: picks one the same way every time, and warns', async () => {
    action('b', 'Bake for a neighbour', { 'weekly-dare-from': MONDAY });
    action('a', 'Ask a friend', { 'weekly-dare-from': MONDAY });
    await sync();
    expect((await dare()).slug).toBe('a');
    expect((await dareWarnings(h.env, h.app.deps)).join('\n')).toContain('share the same weekly dare date. Showing "Ask a friend"');
  });
});

describe('The count', () => {
  it('counts people this week, from 10 up, and repeats once', async () => {
    const id = action('d', 'The dare', { 'weekly-dare-from': MONDAY });
    await sync();
    for (let i = 0; i < 9; i++) expect((await guestDone(id, i)).status).toBe(201);
    h.fake.signIn('ms_ana', { id: 'mem_ana' });
    await h.request('POST', `/api/actions/${id}/done`, { token: 'ms_ana' });
    await h.request('POST', `/api/actions/${id}/done`, { token: 'ms_ana' });
    expect((await dare()).count).toBe(10);
  });

  it('marks from before this week do not count', async () => {
    const id = action('d', 'The dare', { 'weekly-dare-from': '2026-11-23T00:00:00Z' });
    await sync();
    for (let i = 0; i < 10; i++) await guestDone(id, i);
    h.clock.advance(7 * DAY);
    expect(await dare()).toMatchObject({ slug: 'd', count: null });
  });
});
