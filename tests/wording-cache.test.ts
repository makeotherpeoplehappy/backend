// The interface text script only changes with a deploy: a returning visitor
// revalidates it with its ETag and gets an empty 304.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.settle(); await h.mf.dispose(); });

describe('hf-wording.js caching', () => {
  it('sends an ETag and answers 304 when the browser already has it', async () => {
    const first = await h.request('GET', '/hf-wording.js', { origin: null, key: null });
    expect(first.status).toBe(200);
    const tag = first.headers.get('ETag')!;
    expect(tag).toMatch(/^"w[0-9a-z]+"$/);
    expect((await first.text()).length).toBeGreaterThan(100);
    const again = await h.request('GET', '/hf-wording.js', { origin: null, key: null, headers: { 'If-None-Match': `W/${tag}` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    const other = await h.request('GET', '/hf-wording.js', { origin: null, key: null, headers: { 'If-None-Match': '"wold"' } });
    expect(other.status).toBe(200);
  });
});
