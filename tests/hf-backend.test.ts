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

function fakeBrowser(opts: { intentStatus: number; signedIn: boolean; search?: string; pathname?: string; elements?: FakeEl[]; home?: Record<string, string> }) {
  const elements = new Map((opts.elements || []).map((e) => [e.id!, e]));
  const storage = new Map<string, string>();
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  let signinCalls = 0;
  const location = { pathname: opts.pathname ?? '/account', search: opts.search ?? '', href: '', origin: 'https://site.test' };
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
    if (url === '/' && method === 'GET') return { ok: true, status: 200, text: async () => 'home' };
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
      createElement: () => el(),
      getElementById: (id: string) => {
        if (elements.has(id)) return elements.get(id);
        for (const e of elements.values()) for (const i of e.inserted) if (i.el.id === id) return i.el;
        return null;
      },
      body: { appendChild: () => undefined },
      querySelector: (sel: string) => {
        const m = /^\[data-hf-copy="([^"]+)"\]$/.exec(sel);
        return m && m[1] in SITE_WORDING ? { textContent: SITE_WORDING[m[1]] } : null;
      },
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

describe('Site helper: drop "Notify me" on the shop and product pages', () => {
  const upcoming = { 'hf-drop-status': 'Upcoming', 'hf-drop-lead': 'drop-01-tee', 'hf-drop-date': 'December 1, 2026 12:00' };
  type Notify = { dropNotify: () => Promise<boolean> };

  it('shows the form above the products on /shop while the drop is upcoming', async () => {
    const shop = el('hf-shop');
    const b = fakeBrowser({ intentStatus: 201, signedIn: false, pathname: '/shop', elements: [shop], home: upcoming });
    await new Promise((r) => setTimeout(r, 0));
    expect(await (b.window.HFB as Notify).dropNotify()).toBe(false); // already added once, never twice
    expect(shop.inserted).toHaveLength(1);
    expect(shop.inserted[0].where).toBe('beforebegin');
    const form = shop.inserted[0].el;
    expect(form.id).toBe('hfb-notify');
    expect(form.children[0].textContent).toBe('The next drop goes live on December 1, 2026 12:00 ET. Get an email when it does.');
  });

  it("shows it on the lead product's page, but not on other products", async () => {
    const lead = el('hf-product');
    fakeBrowser({ intentStatus: 201, signedIn: true, pathname: '/products/drop-01-tee', elements: [lead], home: upcoming });
    const other = el('hf-product');
    fakeBrowser({ intentStatus: 201, signedIn: true, pathname: '/products/mug', elements: [other], home: upcoming });
    await new Promise((r) => setTimeout(r, 0));
    expect(lead.inserted).toHaveLength(1);
    expect(lead.inserted[0].el.children[0].textContent).toContain('Get an email at your account address when it does.');
    expect(other.inserted).toHaveLength(0);
  });

  it('shows nothing once the drop is live', async () => {
    const shop = el('hf-shop');
    fakeBrowser({ intentStatus: 201, signedIn: false, pathname: '/shop', elements: [shop], home: { ...upcoming, 'hf-drop-status': 'Live' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(shop.inserted).toHaveLength(0);
  });
});
