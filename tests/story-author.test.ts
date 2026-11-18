// Stories carry a small byline avatar: the member's profile photo or the first letter of the
// shown name, and nothing at all for a story shared without a name.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { createHarness, type Harness } from './harness';

let h: Harness;
let action: string;
beforeEach(async () => {
  h = await createHarness();
  action = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

async function share(token: string, body: Record<string, unknown>) {
  await h.request('POST', `/api/actions/${action}/done`, { token });
  const r = await h.request('POST', '/api/stories', { token, body: { actionId: action, consent: true, text: 'It went well.', ...body } });
  expect(r.status).toBe(201);
  await h.settle();
  await drain(h.env, h.app.deps, { limit: 100 });
}
const byAuthor = (name: string) => h.fake.collection(CMS.stories.id).find((i) => i.fieldData['submitted-by'] === name);

it("a story under the member's name carries their profile photo and initial", async () => {
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'ana', email: 'ana@example.com', profileImage: 'https://img.test/ana.jpg' });
  await share('ms_ana', {});
  expect(byAuthor('ana')!.fieldData).toMatchObject({ 'author-photo': { url: 'https://img.test/ana.jpg' }, 'author-initial': 'A' });
});

it('without a profile photo, only the initial', async () => {
  h.fake.signIn('ms_ben', { id: 'mem_ben', firstName: 'Ben', email: 'ben@example.com' });
  await share('ms_ben', {});
  expect(byAuthor('Ben')!.fieldData).toMatchObject({ 'author-photo': null, 'author-initial': 'B' });
});

it('a story shared without a name shows no photo and no initial', async () => {
  h.fake.signIn('ms_cy', { id: 'mem_cy', firstName: 'Cy', email: 'cy@example.com', profileImage: 'https://img.test/cy.jpg' });
  await share('ms_cy', { showName: false });
  const item = h.fake.collection(CMS.stories.id)[0];
  expect(item.fieldData).toMatchObject({ 'submitted-by': '', 'author-photo': null, 'author-initial': '' });
});

it('if Memberstack cannot be reached for the photo, the story still goes through with the initial', async () => {
  h.fake.signIn('ms_di', { id: 'mem_di', firstName: 'Di', email: 'di@example.com', profileImage: 'https://img.test/di.jpg' });
  await h.request('POST', `/api/actions/${action}/done`, { token: 'ms_di' });
  h.fake.memberstackDown = true;
  // Only the photo lookup fails: the sign-in check is already remembered.
  const r = await h.request('POST', '/api/stories', { token: 'ms_di', body: { actionId: action, consent: true, text: 'Nice.' } });
  h.fake.memberstackDown = false;
  expect(r.status).toBe(201);
  await h.settle();
  await drain(h.env, h.app.deps, { limit: 100 });
  expect(byAuthor('Di')!.fieldData).toMatchObject({ 'author-photo': null, 'author-initial': 'D' });
});
