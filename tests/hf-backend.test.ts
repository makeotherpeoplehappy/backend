// The site helper (public/hf-backend.js), run in a small fake browser:
// a signed-out click must survive sign-in even when the server cannot save it.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { WORDING as SITE_WORDING } from './wording';

const SOURCE = readFileSync(new URL('../public/hf-backend.js', import.meta.url), 'utf8');

type FakeEl = { id?: string; textContent: string; style: Record<string, string>; inserted: { where: string; el: FakeEl }[]; children: FakeEl[]; [k: string]: unknown };
const el = (id?: string, text = ''): FakeEl => ({
  id,
  textContent: text,
  style: {},
  inserted: [],
  children: [],
  setAttribute() {},
  removeAttribute() {},
  addEventListener() {},
  remove() {},
  appendChild(c: FakeEl) {
    (this as FakeEl).children.push(c);
  },
  insertAdjacentElement(where: string, c: FakeEl) {
    (this as FakeEl).inserted.push({ where, el: c });
  },
});

function fakeBrowser(opts: { intentStatus: number; signedIn: boolean; guestKey?: string; search?: string; pathname?: string; elements?: FakeEl[]; home?: Record<string, string> }) {
  const elements = new Map((opts.elements || []).map((e) => [e.id!, e]));
  const storage = new Map<string, string>(opts.guestKey ? [['hf_guest', opts.guestKey]] : []);
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  let signinCalls = 0;
  const location = { pathname: opts.pathname ?? '/account', search: opts.search ?? '', href: '', origin: 'https://site.test' };
  const window: Record<string, unknown> = {
    HFW: SITE_WORDING,
    // Memberstack's browser script (window.$memberstackDom).
    $memberstackDom: {
      getMemberCookie: () => (opts.signedIn ? 'shcat_test' : undefined),
      openModal: async () => {
        signinCalls++;
        return { type: 'CLOSED' };
      },
      hideModal: () => undefined,
      getCurrentMember: async () => ({ data: opts.signedIn ? { id: 'mem_1' } : null }),
      logout: async () => undefined,
    },
  };
  const HF = {
    token: () => (opts.signedIn ? { a: 'shcat_test', exp: Date.now() + 3600_000 } : null),
    signin: () => {
      signinCalls++;
    },
    finish: async () => true,
    load: async () => ({ id: 'gid://shopify/Customer/1', firstName: 'Ana' }),
  };
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (url.endsWith('/api/intents') && method === 'POST') return json(opts.intentStatus === 201 ? { id: 'abcdefghijklmnopqrstuv' } : { error: 'bot_check_required' }, opts.intentStatus);
    if (url.includes('/done') && method === 'POST') return json({ tally: 1 }, 201);
    if (url.endsWith('/api/me/claim-guest') && method === 'POST') return json({ merged: 1 });
    if (url.includes('/like') && method === 'PUT') return json({ liked: true });
    if (url.endsWith('/api/me')) return json({ done: [], tally: 0 });
    if (url === '/' && method === 'GET') return { ok: true, status: 200, text: async () => 'home' };
    return json({}, 404);
  };
  const events: string[] = [];
  const context = {
    window,
    document: {
      currentScript: { src: 'https://site.test/join/hf-backend.js', getAttribute: () => null },
      cookie: '',
      readyState: 'complete',
      addEventListener: () => undefined,
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      createElement: () => el(),
      getElementById: (id: string) => {
        if (elements.has(id)) return elements.get(id);
        for (const e of elements.values()) for (const i of e.inserted) if (i.el.id === id) return i.el;
        return null;
      },
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
    DOMParser: class {
      parseFromString() {
        return { getElementById: (id: string) => (opts.home && id in opts.home ? { textContent: opts.home[id] } : null) };
      }
    },
    crypto: globalThis.crypto,
    URL,
    setTimeout,
    Date,
    JSON,
    Promise,
    Uint8Array,
  };
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


describe('Site helper: try before sign-up', () => {
  type Call = (p: string, o?: Record<string, unknown>) => Promise<{ ok: boolean }>;
  it('signed out, "I did this" makes a guest key and sends it; other calls make none', async () => {
    const b = fakeBrowser({ intentStatus: 201, signedIn: false });
    const HFB = b.window.HFB as { call: Call; guest: () => boolean };
    await HFB.call('/api/actions/a1/state');
    expect(b.storage.get('hf_guest')).toBeUndefined();
    await HFB.call('/api/actions/a1/done', { method: 'POST', guest: true });
    const key = b.storage.get('hf_guest')!;
    expect(key).toMatch(/^[A-Za-z0-9-]{20,64}$/);
    expect(b.calls.at(-1)!.headers['X-HF-Guest']).toBe(key);
    expect(b.calls.at(-1)!.headers.Authorization).toBeUndefined();
    expect(HFB.guest()).toBe(true);
  });

  it('signed in with a guest key, the marks are claimed first and the key forgotten', async () => {
    const b = fakeBrowser({ intentStatus: 201, signedIn: true, guestKey: 'guest-key-0123456789abcdef' });
    const HFB = b.window.HFB as { call: Call; guest: () => boolean };
    await HFB.call('/api/me');
    const claim = b.calls.find((c) => c.url.endsWith('/api/me/claim-guest'))!;
    expect(claim.headers['X-HF-Guest']).toBe('guest-key-0123456789abcdef');
    expect(claim.headers.Authorization).toBe('Bearer shcat_test');
    expect(b.calls.findIndex((c) => c.url.endsWith('/api/me/claim-guest'))).toBeLessThan(b.calls.findIndex((c) => c.url.endsWith('/api/me')));
    expect(b.storage.get('hf_guest')).toBeUndefined();
    expect(b.calls.filter((c) => c.url.endsWith('/api/me/claim-guest'))).toHaveLength(1);
  });
});
