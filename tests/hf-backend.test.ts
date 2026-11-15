// The site helper (public/hf-backend.js), run in a small fake browser:
// a signed-out click must survive sign-in even when the server cannot save it.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/hf-backend.js', import.meta.url), 'utf8');

function fakeBrowser(opts: { intentStatus: number; signedIn: boolean; search?: string }) {
  const storage = new Map<string, string>();
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  let signinCalls = 0;
  const location = { pathname: '/account', search: opts.search ?? '', href: '', origin: 'https://site.test' };
  const window: Record<string, unknown> = {};
  const HF = {
    token: () => (opts.signedIn ? { a: 'shcat_test', exp: Date.now() + 3600_000 } : null),
    signin: () => {
      signinCalls++;
    },
    finish: async () => true,
    load: async () => ({ id: 'gid://shopify/Customer/1', firstName: 'Ana' }),
  };
  window.HF = HF;
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (url.endsWith('/api/intents') && method === 'POST') return json(opts.intentStatus === 201 ? { id: 'abcdefghijklmnopqrstuv' } : { error: 'bot_check_required' }, opts.intentStatus);
    if (url.includes('/done') && method === 'POST') return json({ tally: 1 }, 201);
    if (url.includes('/like') && method === 'PUT') return json({ liked: true });
    if (url.endsWith('/api/me')) return json({ done: [], tally: 0 });
    return json({}, 404);
  };
  const events: string[] = [];
  const context = {
    window,
    document: {
      currentScript: { src: 'https://site.test/join/hf-backend.js', getAttribute: () => null },
      readyState: 'complete',
      addEventListener: () => undefined,
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      createElement: () => ({ style: {}, setAttribute: () => undefined, remove: () => undefined }),
      body: { appendChild: () => undefined },
    },
    CustomEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    location,
    fetch,
    crypto: globalThis.crypto,
    URL,
    setTimeout,
    Date,
    JSON,
    Promise,
    Uint8Array,
  };
  (context.window as Record<string, unknown>).HF = HF;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { window, storage, calls, location, events, signins: () => signinCalls };
}

describe('Site helper: resume after sign-in', () => {
  it('keeps the click in the browser when the server cannot save it, and still goes to sign-in', async () => {
    const b = fakeBrowser({ intentStatus: 403, signedIn: false });
    const HFB = b.window.HFB as { requireSignIn: (i: unknown) => Promise<unknown> };
    await HFB.requireSignIn({ kind: 'done', actionId: '6af7ee1968b3c49af2c45be3', returnTo: '/action/tip' });
    expect(b.signins()).toBe(1);
    const saved = JSON.parse(b.storage.get('hfb_local_intent')!);
    expect(saved).toMatchObject({ kind: 'done', actionId: '6af7ee1968b3c49af2c45be3', returnTo: '/action/tip' });
    expect(b.storage.get('hfb_intent')).toBeUndefined();
  });

  it('after sign-in, finishes the kept click once and returns to the action', async () => {
    const b = fakeBrowser({ intentStatus: 403, signedIn: true, search: '?code=abc&state=x' });
    b.storage.set('hfb_local_intent', JSON.stringify({ kind: 'done', actionId: '6af7ee1968b3c49af2c45be3', returnTo: '/action/tip', key: 'local-key-123456' }));
    const HFB = b.window.HFB as { resume: () => Promise<{ ok: boolean }> };
    const r = await HFB.resume();
    expect(r.ok).toBe(true);
    const done = b.calls.filter((c) => c.url.endsWith('/api/actions/6af7ee1968b3c49af2c45be3/done'));
    expect(done).toHaveLength(1);
    expect(done[0].headers['Idempotency-Key']).toBe('local-key-123456');
    expect(done[0].headers.Authorization).toBe('Bearer shcat_test');
    expect(b.storage.get('hfb_local_intent')).toBeUndefined();
    expect(b.location.href).toBe('/action/tip');
  });

  it('uses the server-saved click when there is one', async () => {
    const b = fakeBrowser({ intentStatus: 201, signedIn: false });
    const HFB = b.window.HFB as { requireSignIn: (i: unknown) => Promise<unknown> };
    await HFB.requireSignIn({ kind: 'like', actionId: '6af7ee1968b3c49af2c45be3' });
    expect(b.storage.get('hfb_intent')).toBe('abcdefghijklmnopqrstuv');
    expect(b.storage.get('hfb_local_intent')).toBeUndefined();
  });
});
