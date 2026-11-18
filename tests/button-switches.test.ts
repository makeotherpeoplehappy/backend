// The action page shows "Do this with me" or "I did this" as the main button
// natively, from two switches the backend keeps in step with "Do it with".

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { syncActions } from '../src/core/features/actions';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const queued = async () =>
  (await h.db<{ payload: string }>(`SELECT payload FROM outbox WHERE dedupe_key LIKE 'buttons:%'`)).map((r) => JSON.parse(r.payload) as { itemId: string; fieldData: Record<string, boolean> });

it('sets the switches from Do it with, and leaves matching ones alone', async () => {
  const group = h.fake.addAction('cook-together', 'Cook together', [CMS.actions.onMyOwnCompanionId, '6af7edb79fddcb1ec5b3d86e']);
  const solo = h.fake.addAction('compliment', 'Compliment a stranger');
  const done = h.fake.addAction('already', 'Already right');
  Object.assign(h.fake.collection(CMS.actions.id).find((i) => i.id === done)!.fieldData, { 'do-it-together-first': false, 'do-it-on-my-own-first': true });
  await syncActions(h.env, h.app.deps);
  const q = await queued();
  expect(q.find((x) => x.itemId === group)!.fieldData).toEqual({ 'do-it-together-first': true, 'do-it-on-my-own-first': false });
  expect(q.find((x) => x.itemId === solo)!.fieldData).toEqual({ 'do-it-together-first': false, 'do-it-on-my-own-first': true });
  expect(q.find((x) => x.itemId === done)).toBeUndefined();
});
