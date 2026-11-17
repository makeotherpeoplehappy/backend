// The page script (public/hf-pages.js) in a simulated browser, against a fake
// backend: the main flows on the action page, the invite page, the story
// form and the suggestion form.

import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { WORDING } from './wording';

const SOURCE = readFileSync(new URL('../public/hf-pages.js', import.meta.url), 'utf8');

type Handler = (method: string, path: string, body: unknown) => { status?: number; data: unknown } | undefined;

// Every simulated page is closed after its test, so its timers (countdowns,
// retries) don't keep running and slow the tests after it.
const OPEN: Window[] = [];
afterEach(async () => {
  for (const w of OPEN.splice(0)) await w.happyDOM.close();
});

async function page(path: string, html: string, handler: Handler, opts: { signedIn?: boolean } = {}) {
  const window = new Window({ url: `https://site.test${path}` });
  OPEN.push(window);
  const document = window.document;
  document.body.innerHTML = html + '<div data-hf-pages hidden></div>';
  const calls: { method: string; path: string; body: unknown }[] = [];
  const signIns: unknown[] = [];
  const w = window as unknown as Record<string, unknown>;
  w.HFW = WORDING;
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

// The shop's sections as they are built in Webflow (the wording lives there).
const SHOP_WEBFLOW = `<h1>Shop</h1><div id="hf-shop"></div>
<div id="hfp-shop-drop" class="hf-box" data-hf-show="drop"><p class="hf-drop-label" data-hf-show="live">Out now</p><h2 id="hfp-shop-drop-h" data-hf-fill="name">Drop name</h2><p class="hf-drop-quote" data-hf-fill="statement">Statement</p><p id="hfp-shop-drop-details" data-hf-fill="details">Details line</p><p data-hf-fill="facts">Pieces left and pledges</p><div><a class="hf-story-link" data-hf-fill="link" href="/shop">See the pieces →</a></div><div data-hf-fill="grid"></div></div>
<div id="hfp-shop-now" data-hf-show="now"><h2 id="hfp-shop-now-h">Available now</h2><p>Every piece comes with a pledge: take an action that makes someone else happy.</p><div data-hf-fill="grid"></div></div>
<div id="hfp-shop-past" data-hf-show="past"><h2 id="hfp-shop-past-h">Past drops</h2><div data-hf-template="past-drop"><h3 data-hf-fill="name">Drop name</h3><p class="hf-drop-quote" data-hf-fill="statement">Statement</p><p data-hf-fill="pledges">Sold out</p><div data-hf-fill="grid"></div></div></div>`;
const on = (e: Element | null) => !!e && e.hasAttribute('data-hf-on');


// The drop page's hero and "The pieces" block as built in Webflow.
const DROP_WEBFLOW = `<div class="hf-drop"><div class="hf-drop-body"><p class="hf-drop-count" data-hf-show="live">Out now</p><p class="hf-drop-count" data-hf-show="sold_out">Sold out</p><p id="hf-drop-count" class="hf-drop-count" data-hf-show="upcoming">Coming soon</p><div id="hf-drop-status">Upcoming</div></div><div id="hfp-pieces"><h2 id="hfp-pieces-h">The pieces</h2><p data-hf-show="live">Every piece comes with a pledge: take an action that makes someone else happy.</p></div></div>`;






describe('Sign-in window', () => {
  async function authPage() {
    const p = await page('/account', '<a class="w-nav-brand" href="/"><img src="https://site.test/logo.png" alt="Happiness Foundation"></a>', () => undefined);
    const done: { fn: string; arg: unknown }[] = [];
    const fake = (fn: string, fail?: { code: string; message: string }) => async (arg: unknown) => {
      done.push({ fn, arg });
      if (fail) throw fail;
      return { data: {} };
    };
    const ms: Record<string, unknown> = {
      loginMemberEmailPassword: fake('login', { code: 'invalid-credentials', message: 'Invalid credentials' }),
      signupMemberEmailPassword: fake('signup'),
      sendMemberResetPasswordEmail: fake('reset'),
      resetMemberPassword: fake('newPassword'),
    };
    const w = p.window as unknown as Record<string, unknown> & { HFP: { auth: (m: string) => void } };
    w.$memberstackDom = ms;
    let reloads = 0;
    Object.defineProperty(p.window.location, 'reload', { value: () => void reloads++, configurable: true });
    const fill = (name: string, value: string) => {
      const i = p.document.querySelector(`#hfp-auth input[name="${name}"]`) as unknown as { value: string };
      i.value = value;
    };
    const submit = async () => {
      (p.document.querySelector('#hfp-auth form') as unknown as { requestSubmit: () => void }).requestSubmit();
      await p.settle();
    };
    const text = () => p.document.getElementById('hfp-auth')?.textContent || '';
    return { ...p, w, done, fill, submit, text, reloads: () => reloads };
  }

  it('is ours: our logo and wording, no Memberstack window, and a way to create an account', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    const img = a.document.querySelector('#hfp-auth img.hfp-auth-logo') as unknown as { getAttribute: (n: string) => string };
    expect(img.getAttribute('alt')).toBe('Happiness Foundation');
    expect(a.text()).toContain(WORDING['auth-to-signup']);
    expect(a.text()).toContain(WORDING['auth-google']);
    expect(a.text().toLowerCase()).not.toContain('memberstack');
  });

  it('creates an account with the first name, and reloads signed in', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    (a.document.querySelector('#hfp-auth .hfp-auth-links button:last-child') as unknown as { click: () => void }).click();
    expect(a.text()).toContain(WORDING['auth-signup-title']);
    a.fill('first-name', 'Tess');
    a.fill('email', 'tess@example.com');
    a.fill('password', 'short');
    await a.submit();
    expect(a.text()).toContain(WORDING['auth-err-password']);
    a.fill('password', 'long enough');
    await a.submit();
    expect(a.done).toEqual([{ fn: 'signup', arg: { email: 'tess@example.com', password: 'long enough', customFields: { 'first-name': 'Tess' } } }]);
    expect(a.reloads()).toBe(1);
  });

  it('shows our own message when the password is wrong, and resets a password with the emailed code', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    a.fill('email', 'tess@example.com');
    a.fill('password', 'wrong one');
    await a.submit();
    expect(a.text()).toContain(WORDING['auth-err-wrong']);
    (a.document.querySelector('#hfp-auth .hfp-auth-links button') as unknown as { click: () => void }).click();
    a.fill('email', 'tess@example.com');
    await a.submit();
    expect(a.text()).toContain('We sent a code to tess@example.com');
    a.fill('code', '123456');
    a.fill('password', 'a new password');
    await a.submit();
    expect(a.done.slice(1)).toEqual([
      { fn: 'reset', arg: { email: 'tess@example.com' } },
      { fn: 'newPassword', arg: { token: '123456', newPassword: 'a new password' } },
    ]);
    expect(a.text()).toContain(WORDING['auth-reset-done']);
  });
});
