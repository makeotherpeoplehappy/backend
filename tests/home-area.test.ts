// A member's home area: saved from the header picker, shown and changed on My account.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const patch = (body: unknown) => h.request('PATCH', '/api/me/settings', { token: 'ms_ana', body });
const homeArea = async () => (await (await h.request('GET', '/api/me/home-area', { token: 'ms_ana' })).json()).homeArea;

it('saves, shows, changes and removes the home area', async () => {
  expect(await homeArea()).toBeNull();
  const r = await patch({ homeArea: 'copenhagen' });
  expect(r.status).toBe(200);
  expect((await r.json()).homeArea).toBe('copenhagen');
  expect(await homeArea()).toBe('copenhagen');
  expect((await (await h.request('GET', '/api/me', { token: 'ms_ana' })).json()).homeArea).toBe('copenhagen');
  await patch({ homeArea: 'southampton-ny' });
  expect(await homeArea()).toBe('southampton-ny');
  await patch({ homeArea: null });
  expect(await homeArea()).toBeNull();
});

it('refuses anything that is not a location slug', async () => {
  for (const bad of ['Copenhagen', '<b>', 'a'.repeat(61), 7]) expect((await patch({ homeArea: bad })).status).toBe(400);
});

it('needs a signed-in member', async () => {
  expect((await h.request('GET', '/api/me/home-area')).status).toBe(401);
});

it('is removed with the member data', async () => {
  await patch({ homeArea: 'copenhagen' });
  expect((await h.request('DELETE', '/api/me', { token: 'ms_ana' })).status).toBe(200);
  const [row] = await h.db<{ home_area: string | null }>('SELECT home_area FROM members');
  expect(row.home_area).toBeNull();
});
