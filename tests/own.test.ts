// Your own action: counts for you now (one a day), goes to review as a
// suggestion, and only counts in public once it is an action on the site.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { createHarness, type Harness } from './harness';

let h: Harness;
let actionA: string;

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

async function flush() {
  await h.settle();
  for (let i = 0; i < 5; i++) await drain(h.env, h.app.deps, { limit: 100 });
}
const items = (cid: string) => h.fake.collection(cid);
const own = (body: unknown) => h.request('POST', '/api/own-actions', { token: 'shcat_ana', body });
const hook = (collectionId: string, id: string) =>
  h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body: { triggerType: 'collection_item_changed', payload: { collectionId, id } } });

describe('own actions', () => {
  it('needs an account and something written', async () => {
    expect((await h.request('POST', '/api/own-actions', { body: { text: 'Carried shopping for a neighbour' } })).status).toBe(401);
    expect((await own({ text: ' ' })).status).toBe(400);
    expect((await own({ text: 'Carried shopping', who: 'martian' })).status).toBe(400);
    expect((await own({ text: 'Carried shopping', people: 'lots' })).status).toBe(400);
  });

  it('counts for the member at once, goes to review, and stays out of public numbers', async () => {
    const res = await own({ text: 'Carried shopping up the stairs for my neighbour', who: 'neighbor', people: 'few' });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.tally).toBe(2);
    expect(out.rippleView.reached).toBe(2);
    expect(await h.db(`SELECT source, people, action_id AS actionId FROM done_marks`)).toEqual([{ source: 'own', people: 2, actionId: `own-${out.id}` }]);
    expect(await h.db(`SELECT kind, who FROM suggestions`)).toEqual([{ kind: 'own', who: '["neighbor"]' }]);
    await flush();
    const [item] = items(CMS.suggestions.id);
    expect(item.fieldData.status).toBe(CMS.suggestions.status.new);
    expect(String(item.fieldData['review-notes'])).toContain('Done by the member for neighbor');
    const impact = await (await h.request('GET', '/api/impact')).json();
    expect(impact.peopleMadeHappy).toBe(0);
    const queue = await (await h.request('GET', '/api/activity')).json();
    expect(queue.items).toEqual([]);
  });

  it('up to ten of your own count a day', async () => {
    for (let i = 1; i <= 10; i++) expect((await own({ text: `Kind thing number ${i}` })).status).toBe(201);
    const again = await own({ text: 'Bought my colleague a coffee' });
    expect(again.status).toBe(429);
    expect((await again.json()).error).toBe('own_daily');
    h.clock.advance(24 * 60 * 60 * 1000);
    expect((await own({ text: 'Bought my colleague a coffee' })).status).toBe(201);
  });

  it('once approved and published, the mark moves to the new action and counts in public', async () => {
    await own({ text: 'Left a thank-you note for the bin crew', who: 'someone-who-serves-you' });
    await flush();
    const sug = items(CMS.suggestions.id)[0];
    sug.fieldData.status = CMS.suggestions.status.approved;
    await hook(CMS.suggestions.id, sug.id);
    await flush();
    const draft = items(CMS.actions.id).find((i) => i.fieldData.slug === 'suggested-action-1')!;
    draft.live = true;
    draft.isDraft = false;
    await hook(CMS.actions.id, draft.id);
    await hook(CMS.actions.id, draft.id);
    await flush();
    expect(await h.db(`SELECT source, action_id AS actionId FROM done_marks`)).toEqual([{ source: 'site', actionId: draft.id }]);
    h.env.CACHE.delete('impact:public');
    expect((await (await h.request('GET', '/api/impact')).json()).peopleMadeHappy).toBe(1);
  });

  it('suggests close matches among the site\'s actions while typing', async () => {
    await h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
    const r = await (await h.request('GET', `/api/actions/match?q=${encodeURIComponent('I gave a compliment to a stranger')}`)).json();
    expect(r.matches).toEqual([{ slug: 'compliment-a-stranger', title: 'Compliment a stranger' }]);
    expect((await (await h.request('GET', '/api/actions/match?q=hi')).json()).matches).toEqual([]);
  });

  it('a story can be told about it; rejecting it deletes the entry and the story for good', async () => {
    const { id } = await (await own({ text: 'Fixed the bike of the kid next door', who: 'child' })).json();
    const mine = await (await h.request('GET', `/api/stories/mine?action=own-${id}`, { token: 'shcat_ana' })).json();
    expect(mine).toMatchObject({ done: true, own: true, title: 'Fixed the bike of the kid next door' });
    const st = await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: `own-${id}`, text: 'His face when it worked!', consent: true } });
    expect(st.status).toBe(201);
    await flush();
    const story = items(CMS.stories.id)[0];
    expect(story.fieldData.name).toBe('Ana: Fixed the bike of the kid next door');
    expect(story.fieldData.action).toBeUndefined();
    const sug = items(CMS.suggestions.id)[0];
    sug.fieldData.status = CMS.suggestions.status.rejected;
    await hook(CMS.suggestions.id, sug.id);
    await flush();
    expect(await h.db(`SELECT id FROM done_marks`)).toEqual([]);
    expect(await h.db(`SELECT id FROM stories`)).toEqual([]);
    expect(items(CMS.stories.id)).toEqual([]);
  });

  it('when the action goes live, the story moves to it', async () => {
    const { id } = await (await own({ text: 'Left flowers for the night nurse' })).json();
    await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: `own-${id}`, text: 'She cried a bit.', consent: true } });
    await flush();
    const sug = items(CMS.suggestions.id)[0];
    sug.fieldData.status = CMS.suggestions.status.approved;
    await hook(CMS.suggestions.id, sug.id);
    await flush();
    const draft = items(CMS.actions.id).find((i) => i.fieldData.slug === 'suggested-action-1')!;
    draft.live = true;
    draft.isDraft = false;
    await hook(CMS.actions.id, draft.id);
    await hook(CMS.actions.id, draft.id);
    await flush();
    expect(await h.db(`SELECT action_id AS a FROM stories`)).toEqual([{ a: draft.id }]);
    expect(items(CMS.stories.id)[0].fieldData.action).toBe(draft.id);
  });
});
