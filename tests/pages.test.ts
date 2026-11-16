// The page script (public/hf-pages.js) in a simulated browser, against a fake
// backend: the main flows on the action page, the invite page, the story
// form and the suggestion form.

import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/hf-pages.js', import.meta.url), 'utf8');

type Handler = (method: string, path: string, body: unknown) => { status?: number; data: unknown } | undefined;

async function page(path: string, html: string, handler: Handler, opts: { signedIn?: boolean } = {}) {
  const window = new Window({ url: `https://site.test${path}` });
  const document = window.document;
  document.body.innerHTML = html + '<div data-hf-pages hidden></div>';
  const calls: { method: string; path: string; body: unknown }[] = [];
  const signIns: unknown[] = [];
  const w = window as unknown as Record<string, unknown>;
  w.HF = { token: () => (opts.signedIn === false ? null : { a: 'tok' }), finish: async () => false, load: async () => null, signin: () => undefined, signout: () => undefined };
  w.HFB = {
    base: '/join',
    call: async (p: string, o: { method?: string; body?: unknown } = {}) => {
      const method = o.method || 'GET';
      calls.push({ method, path: p, body: o.body });
      const r = handler(method, p, o.body) || { status: 404, data: { message: 'not found' } };
      const status = r.status ?? 200;
      return { ok: status < 400, status, data: r.data };
    },
    requireSignIn: async (i: unknown) => void signIns.push(i),
    keepDraft: () => ({ clear: () => undefined }),
    token: async () => 'tok',
  };
  // Direct fetches to the backend go to the same fake.
  w.fetch = async (url: string, init: { method?: string } = {}) => {
    const path = String(url).replace(/^.*?\/join/, '');
    const method = init.method || 'GET';
    calls.push({ method, path, body: undefined });
    const r = handler(method, path, undefined) || { status: 404, data: {} };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.data, text: async () => '' };
  };
  window.eval(SOURCE);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
  };
  await settle();
  return { window, document, calls, signIns, settle };
}

const ACTION_HTML = `<h1>Cook a meal</h1><p class="hf-lead">Cook for someone.</p>
<section><div><a id="hf-did-this" href="#" class="hf-button">I did this</a><p id="hf-did-msg"></p><div id="hf-signup-prompt"></div></div></section><footer></footer>`;

describe('Action page', () => {
  it('marks done, offers the share card, then "I did this again" and undo', async () => {
    let me = { done: false, doneToday: false, canUndo: false, liked: false, tally: 0, doneWith: [] as string[], story: null };
    const state = () => ({ data: { actionId: 'a1', slug: 'cook-a-meal', count: null, canDoWithOthers: true, suggestedBy: 'Ana', stories: [], me } });
    const p = await page('/action/cook-a-meal', ACTION_HTML, (m, path) => {
      if (path.endsWith('/state')) return state();
      if (m === 'POST' && path === '/api/actions/a1/done') {
        me = { ...me, done: true, doneToday: true, canUndo: true, tally: 1 };
        return { status: 201, data: { tally: 1, count: null, ripple: 0 } };
      }
      if (m === 'DELETE' && path === '/api/actions/a1/done') {
        me = { ...me, done: false, doneToday: false, canUndo: false, tally: 0 };
        return { data: { done: false, tally: 0 } };
      }
    });
    const btn = p.document.getElementById('hf-did-this')!;
    expect(p.document.body.textContent).toContain('Suggested by Ana');
    expect(p.document.body.textContent).toContain('Do this with me');
    expect(p.document.body.textContent).toContain('Invite someone to do it with you, not the person you are doing it for.');
    btn.click();
    await p.settle();
    expect(btn.textContent).toBe('I did this again');
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(p.document.body.textContent).toContain('I made someone happy today');
    expect(p.document.getElementById('hf-did-msg')!.textContent).toBe('You have made 1 person happy.');
    btn.click();
    await p.settle();
    expect(p.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/done'))).toHaveLength(2);
    const undo = [...p.document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    undo.click();
    await p.settle();
    expect(btn.textContent).toBe('I did this');
  });

  it('"Do this with me" asks for a short note, then shares it', async () => {
    const p = await page('/action/cook-a-meal', ACTION_HTML, (m, path, body) => {
      if (path.endsWith('/state')) return { data: { actionId: 'a1', canDoWithOthers: true, stories: [], me: { done: false } } };
      if (m === 'POST' && path === '/api/invites') return { status: 201, data: { code: 'AbCdEfGh23', url: 'https://site.test/join/AbCdEfGh23', text: (body as { note: string }).note } };
    });
    const shared: unknown[] = [];
    Object.defineProperty(p.window.navigator, 'share', { value: async (d: unknown) => void shared.push(d), configurable: true });
    const withMe = [...p.document.querySelectorAll('button')].find((b) => b.textContent === 'Do this with me')!;
    withMe.click();
    await p.settle();
    const ta = p.document.getElementById('hfp-note') as unknown as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    ta.value = 'Saturday?';
    p.document.getElementById('hfp-compose')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls.find((c) => c.path === '/api/invites')!.body).toEqual({ actionId: 'a1', kind: 'with_me', note: 'Saturday?' });
    expect(shared).toEqual([expect.objectContaining({ text: 'Saturday?', url: 'https://site.test/join/AbCdEfGh23' })]);
    await p.settle();
    expect(p.document.querySelectorAll('#hfp-compose').length, p.document.body.innerHTML.slice(-600)).toBe(0);
  });

  it('sends a signed-out visitor straight to sign in and remembers the click', async () => {
    const p = await page('/action/cook-a-meal', ACTION_HTML, (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [] } } : undefined), { signedIn: false });
    const save = [...p.document.querySelectorAll('button')].find((b) => b.textContent === '♡ Save')!;
    save.click();
    await p.settle();
    p.document.getElementById('hf-did-this')!.click();
    await p.settle();
    expect(p.signIns).toEqual([
      { kind: 'like', actionId: 'a1' },
      { kind: 'done', actionId: 'a1' },
    ]);
    expect(p.document.getElementById('hf-did-msg')!.textContent).toContain('Taking you to sign in');
  });

  it('shows approved stories with a vertical player and a report link', async () => {
    const story = { id: 7, text: 'They cried.', name: 'Ana', with: ['Ben'], createdAt: '2026-11-16T09:00:00Z', photo: null, video: { embed: 'https://www.tiktok.com/embed/v2/1?muted=1', vertical: true }, action: { title: 'Cook', slug: 'cook' } };
    const p = await page('/action/cook-a-meal', ACTION_HTML, (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [story] } } : undefined));
    expect(p.document.querySelector('.hfp-video.is-vertical iframe')!.getAttribute('src')).toContain('muted=1');
    expect(p.document.body.textContent).toContain('Ana, with Ben');
    expect(p.document.body.textContent).toContain('Report this story');
  });
});

const INVITE_HTML = `<h1 id="hf-join-title">Do this with me</h1><p id="hf-join-action"></p><p id="hf-join-desc"></p><p><a id="hf-join-in" href="/x" class="hf-button">I'm in</a></p><p id="hf-join-note"></p>`;

describe('Invite page', () => {
  it("shows who it is from and joins on \"I'm in\"", async () => {
    let joined = false;
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, (m, path) => {
      if (m === 'GET' && path === '/api/invites/AbCdEfGh23') return { data: { kind: 'with_me', inviterName: 'Ana', note: 'Saturday?', action: { title: 'Cook a meal', shortAnswer: 'Cook for someone', slug: 'cook', live: true }, alternatives: [], me: { isMine: false, joined } } };
      if (m === 'POST') { joined = true; return { data: { joined: true } }; }
    });
    expect(p.document.getElementById('hf-join-title')!.textContent).toBe('Ana wants to do this with you');
    expect(p.document.getElementById('hfp-invite-note')!.textContent).toBe('“Saturday?” – Ana');
    p.document.getElementById('hf-join-in')!.click();
    await p.settle();
    expect(p.document.getElementById('hf-join-in')!.textContent).toBe("You're in");
    expect(p.document.body.textContent).toContain('Leave this invite');
  });

  it('a signed-out visitor goes to sign in and comes back to the same invite', async () => {
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, () => ({ data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Cook', slug: 'cook', live: true }, alternatives: [], me: null } }), { signedIn: false });
    p.document.getElementById('hf-join-in')!.click();
    await p.settle();
    expect(p.signIns).toEqual([{ kind: 'join', inviteCode: 'AbCdEfGh23', returnTo: '/do-this-with-me?i=AbCdEfGh23' }]);
  });

  it('a removed action shows three others', async () => {
    const alts = [1, 2, 3].map((n) => ({ slug: `a${n}`, title: `Action ${n}` }));
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, () => ({ data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Old', slug: null, live: false }, alternatives: alts, me: null } }));
    expect(p.document.getElementById('hf-join-title')!.textContent).toBe('This action is no longer available');
    expect(p.document.querySelectorAll('.hfp-list a')).toHaveLength(3);
  });
});

const STORY_HTML = `<h1>Share your story</h1><p id="hf-story-note"></p><div class="hf-form"><div class="w-form"><form id="native"><input id="story-action"></form></div></div>`;

describe('Share your story', () => {
  it('needs the consent tick, then sends the story to the backend', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, (m, path, body) => {
      if (path.startsWith('/api/stories/mine')) return { data: { done: true, story: null, withCandidates: [{ id: 2, name: 'Ben' }], name: 'Ana' } };
      if (m === 'POST' && path === '/api/stories') return { status: 201, data: { id: 1, status: 'new', body } };
    });
    expect(p.document.getElementById('native')).toBeNull();
    const form = p.document.querySelector('form')!;
    (p.document.getElementById('hfp-story-text') as unknown as HTMLTextAreaElement).value = 'We cooked.';
    (p.document.getElementById('hfp-with-2') as unknown as HTMLInputElement).checked = true;
    form.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.document.body.textContent).toContain('Please tick the box');
    expect(p.calls.some((c) => c.method === 'POST')).toBe(false);
    (p.document.getElementById('hfp-consent') as unknown as HTMLInputElement).checked = true;
    form.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    const sent = p.calls.find((c) => c.method === 'POST')!;
    expect(sent.body).toMatchObject({ actionId: 'cook', text: 'We cooked.', consent: true, showName: true, withMemberIds: [2] });
    expect(p.document.body.textContent).toContain('Thank you for sharing.');
  });

  it('sends a member who has not done the action back to it', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, () => ({ data: { done: false, story: null, withCandidates: [] } }));
    expect(p.document.getElementById('hf-story-note')!.textContent).toContain('Mark it done first.');
  });
});

describe('Suggest an action (no Webflow form)', () => {
  it('builds its own form and sends the idea to the backend', async () => {
    const p = await page('/suggest-an-action', '<h1>Suggest an action</h1><p class="hf-lead">Know a small way?</p>', (m, path) => (m === 'POST' && path === '/api/suggestions' ? { status: 201, data: { id: 1 } } : undefined));
    (p.document.getElementById('Idea') as unknown as HTMLTextAreaElement).value = 'Bring soup to a sick neighbour';
    p.document.getElementById('hfp-suggest')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls.find((c) => c.method === 'POST')!.body).toEqual({ text: 'Bring soup to a sick neighbour' });
    expect(p.document.body.textContent).toContain('Thank you. Your idea is with us.');
  });
});

describe('Share your story (no Webflow form)', () => {
  it('builds the story form after the note', async () => {
    const p = await page('/share-your-story?action=cook', '<h1>Share your story</h1><p id="hf-story-note"></p>', (_m, path) =>
      path.startsWith('/api/stories/mine') ? { data: { done: true, story: null, withCandidates: [], name: 'Ana' } } : undefined,
    );
    expect(p.document.getElementById('hfp-story-text')).toBeTruthy();
    expect(p.document.getElementById('hfp-consent')).toBeTruthy();
  });
});

describe('Suggest an action', () => {
  it('sends the idea to the backend instead of the Webflow form', async () => {
    const html = `<div class="w-form"><form id="wf-form-Suggest-an-action"><label for="name">Name</label><input id="name"><label for="email">Email</label><input id="email" required><textarea id="Idea"></textarea><input type="submit" value="Send"></form></div>`;
    const p = await page('/suggest-an-action', html, (m, path) => (m === 'POST' && path === '/api/suggestions' ? { status: 201, data: { id: 1 } } : undefined));
    expect((p.document.getElementById('email') as unknown as HTMLInputElement).required).toBe(false);
    (p.document.getElementById('Idea') as unknown as HTMLTextAreaElement).value = 'Leave a note on a bike';
    p.document.getElementById('wf-form-Suggest-an-action')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls.find((c) => c.method === 'POST')!.body).toEqual({ text: 'Leave a note on a bike' });
    expect(p.document.body.textContent).toContain('Thank you. Your idea is with us.');
  });
});

describe('Shop', () => {
  it('draws the current drop, "Available now" and past drops at once from one call, and leaves out empty sections', async () => {
    const tee = { handle: 'tee', title: 'Tee', image: { url: 'https://cdn.shopify.com/tee.jpg', alt: 'Tee' }, price: { amount: '45.0', currencyCode: 'USD' }, available: true, label: 'Drop 02 · 50 pieces' };
    const old = { ...tee, handle: 'old-tee', title: 'Old tee', available: false, label: 'Drop 01 · Sold out' };
    const shop = (now: unknown[]) => ({
      current: { drop: 'drop-02', name: 'Drop 02: Jane Doe', statement: 'Be the reason.', status: 'upcoming', detailsLine: '50 pieces. Drops December 20 at 12:00 ET.', left: 50, quantity: 50, pledges: { made: 0, kept: 0 }, products: [tee] },
      availableNow: now,
      past: [{ drop: 'drop-01', name: 'Drop 01', statement: 'Happiness is felt by making other people happy.', status: 'sold_out', pledges: { made: 100, kept: 81 }, products: [old] }],
    });
    const p = await page('/shop', '<h1>Shop</h1><div id="hf-shop"></div>', (_m, path) => (path === '/api/shop' ? { data: shop([]) } : undefined));
    const text = p.document.body.textContent;
    expect(p.calls.filter((c) => c.path === '/api/shop')).toHaveLength(1);
    expect(p.document.getElementById('hfp-shop-drop-h')!.textContent).toBe('Drop 02: Jane Doe');
    expect(p.document.querySelector('#hfp-shop-drop .hf-drop-quote')!.textContent).toBe('Be the reason.');
    // Before launch the drop's pieces are left to the drop page.
    expect(p.document.querySelector('#hfp-shop-drop .hfp-grid')).toBeNull();
    expect(text).not.toContain('Available now'); // empty: never shown
    expect(text).toContain('Past drops');
    expect(text).toContain('100 pledges made, 81 kept');
    expect(text).toContain('Sold out');
    // Before launch: no Add to cart on the drop's pieces.
    expect(p.document.querySelector('#hfp-shop-drop')!.innerHTML).not.toContain('Add to cart');
    expect(p.document.documentElement.getAttribute('data-hfp-shop')).toBe('ready');

    const q = await page('/shop', '<div id="hf-shop"></div>', (_m, path) => (path === '/api/shop' ? { data: shop([{ ...tee, handle: 'mug', title: 'Mug', label: null }]) } : undefined));
    expect(q.document.body.textContent).toContain('Available now');
    expect(q.document.body.innerHTML).toContain('handle="mug"');
  });
});

describe('Drop page', () => {
  it('shows every piece of the drop on the page, without "Add to cart" before launch', async () => {
    // The real Shopify script is not loaded in tests.
    const p = await page('/drops/drop-01', '<script type="text/plain" src="https://cdn.shopify.com/storefront/web-components.js"></script><div class="hf-drop"></div><footer></footer>', (_m, path) =>
      path.startsWith('/api/drops/state') ? { data: { drop: 'drop-01', status: 'upcoming' } } : path === '/api/products/labels' ? { data: { labels: {} } } : path === '/api/shop' ? { data: { current: null, past: [] } } : undefined,
    );
    expect(p.document.getElementById('hfp-pieces')!.textContent).toContain('The pieces');
    expect(p.document.querySelector('#hfp-pieces shopify-context')!.getAttribute('handle')).toBe('drop-01');
    // (The simulated browser may run Shopify's own script, which replaces the template.)
    expect(p.document.getElementById('hfp-pieces')!.innerHTML).not.toContain('Add to cart');
    // The pieces sit inside the drop's box, under the image and text, so there is no button to them.
    expect(p.document.querySelector('.hf-drop')!.lastElementChild!.id).toBe('hfp-pieces');
    expect(p.document.querySelector('shopify-cart#hf-cart')).toBeTruthy();
  });
});
