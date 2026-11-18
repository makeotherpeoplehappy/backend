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

async function page(path: string, html: string, handler: Handler, opts: { signedIn?: boolean; markedSignedIn?: boolean } = {}) {
  const window = new Window({ url: `https://site.test${path}` });
  OPEN.push(window);
  const document = window.document;
  document.body.innerHTML = html + '<div data-hf-pages hidden></div>';
  // The site head's mark for a browser that holds a sign-in.
  if (opts.markedSignedIn) document.documentElement.classList.add('hf-in');
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

  it('sends a signed-out visitor to sign in for Save, and remembers the click', async () => {
    const p = await page('/action/cook-a-meal', ACTION_HTML, (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [] } } : undefined), { signedIn: false });
    const save = [...p.document.querySelectorAll('button')].find((b) => b.textContent === '♡ Save')!;
    save.click();
    await p.settle();
    expect(p.signIns).toEqual([{ kind: 'like', actionId: 'a1' }]);
    expect(p.document.getElementById('hf-did-msg')!.textContent).toContain('Taking you to sign in');
  });

  it('lets a signed-out visitor mark it done, shows the win, then a soft ask to keep it', async () => {
    let done = false;
    const p = await page(
      '/action/cook-a-meal',
      ACTION_HTML,
      (m, path) => {
        if (path.endsWith('/state')) return { data: { actionId: 'a1', stories: [], me: done ? { done: true, guest: true, tally: 1, canUndo: true, doneWith: [] } : { done: false, guest: true, tally: 0 } } };
        if (m === 'POST' && path === '/api/actions/a1/done') { done = true; return { status: 201, data: { guest: true, ripple: 0, tally: 1 } }; }
      },
      { signedIn: false },
    );
    p.document.getElementById('hf-did-this')!.click();
    await p.settle();
    expect(p.signIns).toEqual([]);
    expect(p.calls).toContainEqual({ method: 'POST', path: '/api/actions/a1/done', body: undefined });
    const text = p.document.body.textContent || '';
    expect(text).toContain('I made someone happy today');
    expect(text).toContain('You have made 1 person happy.');
    expect(text).toContain('Keep this – create a free account');
    expect([...p.document.querySelectorAll('button')].some((b) => b.textContent === 'Create a free account')).toBe(true);
    // Sharing a story needs an account, so it waits.
    expect([...p.document.querySelectorAll('a')].find((a) => a.textContent === 'Share your story')?.getAttribute('style')).toContain('none');
  });

  it('after undo, says the new total, not the old one', async () => {
    const p = await page('/action/cook-a-meal', ACTION_HTML, (m, path) => {
      if (path.endsWith('/state')) return { data: { actionId: 'a1', stories: [], me: m === 'GET' ? { done: true, tally: 1, canUndo: true, doneWith: [] } : null } };
      if (m === 'DELETE') return { data: { done: false, tally: 0 } };
    });
    [...p.document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!.click();
    await p.settle();
    expect(p.document.getElementById('hf-did-msg')!.textContent).toBe('Undone.');
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

const STORY_HTML = `<h1>Share your story</h1><p id="hf-story-note"></p><div class="w-form hf-form" data-hf-show="story-form"><form id="hf-story-form"><p id="hf-story-title">Your action</p><p id="hf-story-status"></p><label for="hfp-story-text">Your story</label><textarea id="hfp-story-text"></textarea><input type="file" id="hfp-photo"><div id="hfp-photo-area"></div><input id="hfp-photo-desc"><input id="hfp-video"><div id="hfp-with"></div><label class="w-checkbox"><input type="checkbox" id="hfp-show-name"><span class="w-form-label">Show my first name</span></label><label class="w-checkbox"><input type="checkbox" id="hfp-consent" required><span class="w-form-label">Everyone agreed</span></label><input type="submit" value="Share my story"></form><div class="w-form-done" style="display:none"><p>Thank you for sharing.</p></div><div class="w-form-fail" style="display:none"><p>Did not send.</p></div></div>`;

describe('Share your story', () => {
  it('needs the consent tick, then sends the story to the backend', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, (m, path, body) => {
      if (path.startsWith('/api/stories/mine')) return { data: { done: true, story: null, withCandidates: [{ id: 2, name: 'Ben' }], name: 'Ana' } };
      if (m === 'POST' && path === '/api/stories') return { status: 201, data: { id: 1, status: 'new', body } };
    });
    expect(p.document.querySelector('[data-hf-show]')!.getAttribute('data-hf-on')).toBe('1');
    expect(p.document.getElementById('hf-story-title')!.textContent).toBe('cook');
    const form = p.document.getElementById('hf-story-form')!;
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
    expect((p.document.querySelector('.w-form-done') as unknown as HTMLElement).style.display).toBe('block');
    expect((form as unknown as HTMLElement).style.display).toBe('none');
  });

  it('sends a member who has not done the action back to it', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, () => ({ data: { done: false, story: null, withCandidates: [] } }));
    expect(p.document.getElementById('hf-story-note')!.textContent).toContain('Mark it done first.');
  });
});

describe('Suggest an action', () => {
  it('sends the idea to the backend instead of the Webflow form', async () => {
    const html = `<div class="w-form"><form id="wf-form-Suggest-an-action"><label for="name">Name</label><input id="name"><label for="email">Email</label><input id="email" required><textarea id="Idea"></textarea><input type="submit" value="Send"></form><div class="w-form-done" style="display:none"><p>Thank you. Your idea is with us.</p></div><div class="w-form-fail" style="display:none"></div></div>`;
    const p = await page('/suggest-an-action', html, (m, path) => (m === 'POST' && path === '/api/suggestions' ? { status: 201, data: { id: 1 } } : undefined));
    expect((p.document.getElementById('email') as unknown as HTMLInputElement).required).toBe(false);
    (p.document.getElementById('Idea') as unknown as HTMLTextAreaElement).value = 'Leave a note on a bike';
    p.document.getElementById('wf-form-Suggest-an-action')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls.find((c) => c.method === 'POST')!.body).toEqual({ text: 'Leave a note on a bike' });
    expect((p.document.querySelector('.w-form-done') as unknown as HTMLElement).style.display).toBe('block');
    expect((p.document.getElementById('wf-form-Suggest-an-action') as unknown as HTMLElement).style.display).toBe('none');
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
      sendMemberLoginPasswordlessEmail: fake('otpLoginSend'),
      loginMemberPasswordless: fake('otpLogin'),
      sendMemberSignupPasswordlessEmail: fake('otpSignupSend'),
      signupMemberPasswordless: fake('otpSignup'),
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
  it('signs in with a code by email, no password needed', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    expect(a.text()).toContain(WORDING['auth-otp']);
    (a.document.querySelector('#hfp-auth .hfp-auth-mail') as unknown as { click: () => void }).click();
    a.fill('email', 'tess@example.com');
    await a.submit();
    expect(a.text()).toContain('We sent a code to tess@example.com');
    a.fill('code', '654321');
    await a.submit();
    expect(a.done).toEqual([
      { fn: 'otpLoginSend', arg: { email: 'tess@example.com' } },
      { fn: 'otpLogin', arg: { passwordlessToken: '654321', email: 'tess@example.com' } },
    ]);
    expect(a.reloads()).toBe(1);
  });

  it('creates an account with a code by email, keeping the first name', async () => {
    const a = await authPage();
    a.w.HFP.auth('signup');
    (a.document.querySelector('#hfp-auth .hfp-auth-mail') as unknown as { click: () => void }).click();
    a.fill('first-name', 'Tess');
    a.fill('email', 'tess@example.com');
    await a.submit();
    a.fill('code', '111222');
    await a.submit();
    expect(a.done).toEqual([
      { fn: 'otpSignupSend', arg: { email: 'tess@example.com' } },
      { fn: 'otpSignup', arg: { passwordlessToken: '111222', email: 'tess@example.com', customFields: { 'first-name': 'Tess' } } },
    ]);
  });
});

describe('Header', () => {
  const HTML = `<header>
    <form><select id="hf-loc"><option value="">All locations</option><option value="copenhagen">Copenhagen</option></select></form>
    <a class="hf-nav-signin" data-hf-auth="out" href="/account">Sign in</a><a class="hf-nav-cta" data-hf-auth="out" href="/account">Join free</a>
    <div data-hf-auth="in" data-hf-pin="1"><select class="hf-loc-mini"></select></div>
    <a class="hf-nav-avatar" data-hf-auth="in" href="/account"><span data-hf-fill="avatar-initial"></span></a></header>`;
  type Clickable = { click: () => void };
  const authSpy = (p: { window: unknown }) => {
    const opened: string[] = [];
    (p.window as { HFP: { auth: (m: string) => void } }).HFP.auth = (m) => void opened.push(m);
    return opened;
  };

  it('Join free opens the create-account window and Sign in the sign-in window', async () => {
    const p = await page('/', HTML, () => undefined, { signedIn: false });
    const opened = authSpy(p);
    (p.document.querySelector('.hf-nav-cta') as unknown as Clickable).click();
    (p.document.querySelector('.hf-nav-signin') as unknown as Clickable).click();
    expect(opened).toEqual(['signup', 'signin']);
  });

  it('marks the page signed in or out once sign-in has loaded (the CSS shows the matching parts)', async () => {
    // A sign-in that has run out: marked by the head, but no longer signed in.
    const out = await page('/', HTML, () => undefined, { signedIn: false, markedSignedIn: true });
    expect(out.document.documentElement.classList.contains('hf-in')).toBe(false);
    const inn = await page('/', HTML, () => undefined);
    expect(inn.document.documentElement.classList.contains('hf-in')).toBe(true);
  });

  it('fills the avatar with the first initial, or the profile photo', async () => {
    const p = await page('/', HTML, () => undefined);
    const avatar = p.document.querySelector('.hf-nav-avatar') as unknown as { style: { backgroundImage: string }; getAttribute: (n: string) => string | null };
    const initial = () => p.document.querySelector('[data-hf-fill="avatar-initial"]')!.textContent;
    p.window.dispatchEvent(new p.window.CustomEvent('hf-member', { detail: { customFields: { 'first-name': 'tess' }, auth: { email: 'x@example.com' } } }));
    expect(initial()).toBe('T');
    expect(avatar.getAttribute('data-hf-photo')).toBeNull();
    p.window.dispatchEvent(new p.window.CustomEvent('hf-member', { detail: { customFields: {}, auth: { email: 'mia@example.com' }, profileImage: 'https://img.test/me.jpg' } }));
    expect(initial()).toBe('M');
    expect(avatar.getAttribute('data-hf-photo')).toBe('1');
    expect(avatar.style.backgroundImage).toContain('https://img.test/me.jpg');
  });

  it('the desktop dropdown sets the picker, its label and the tick', async () => {
    const html = HTML + '<div class="w-dropdown"><div><span data-hf-fill="loc-label">All locations</span></div><nav><a href="#" data-hf-loc="all">All locations</a><a href="#" data-hf-loc="copenhagen">Copenhagen</a></nav></div>';
    const p = await page('/', html, () => undefined);
    (p.document.querySelector('[data-hf-loc="copenhagen"]') as unknown as Clickable).click();
    expect((p.document.getElementById('hf-loc') as unknown as { value: string }).value).toBe('copenhagen');
    expect(p.document.querySelector('[data-hf-fill="loc-label"]')!.textContent).toBe('Copenhagen');
    expect(p.document.querySelector('[data-hf-loc="copenhagen"]')!.getAttribute('aria-selected')).toBe('true');
    expect(p.document.querySelector('[data-hf-loc="all"]')!.getAttribute('aria-selected')).toBe('false');
    expect(p.window.localStorage.getItem('hf_loc')).toBe('copenhagen');
  });

  it("a signed-in member's pick is saved as their home area", async () => {
    const p = await page('/', HTML, () => ({ data: {} }));
    const loc = p.document.getElementById('hf-loc') as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    loc.value = 'copenhagen';
    loc.dispatchEvent(new p.window.Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    expect(p.calls).toContainEqual({ method: 'PATCH', path: '/api/me/settings', body: { homeArea: 'copenhagen' } });
  });

  it('a new device takes the home area from the account', async () => {
    const p = await page('/', HTML, (_m, path) => (path === '/api/me/home-area' ? { data: { homeArea: 'copenhagen' } } : { data: {} }));
    await p.settle();
    expect((p.document.getElementById('hf-loc') as unknown as { value: string }).value).toBe('copenhagen');
    // Taken from the account, so not saved back.
    expect(p.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('the phone pin picks a location through the same picker', async () => {
    const p = await page('/', HTML, () => undefined);
    const mini = p.document.querySelector('.hf-loc-mini') as unknown as { value: string; options: unknown[]; dispatchEvent: (e: unknown) => void };
    expect(mini.options.length).toBe(2);
    mini.value = 'copenhagen';
    mini.dispatchEvent(new p.window.Event('change'));
    expect((p.document.getElementById('hf-loc') as unknown as { value: string }).value).toBe('copenhagen');
    expect(p.window.localStorage.getItem('hf_loc')).toBe('copenhagen');
  });
});

describe('Account profile photo', () => {
  const HTML = `<div id="hf-acct-out"><a id="hf-join" href="/account">Join free</a><a id="hf-signin" href="/account">Sign in</a></div>
    <div id="hf-acct-in" data-hf-show="signed-in"><p id="hf-tally"></p><div id="hf-pledges"></div><div id="hf-actions"></div>
    <div id="hfp-settings"><div id="hfp-photo-row"><div class="hf-nav-avatar" data-hf-avatar="1"><span data-hf-fill="avatar-initial"></span></div>
    <a id="hfp-photo" href="#">Add a profile photo</a><a id="hfp-photo-remove" data-hf-show="photo" href="#">Remove photo</a></div><p id="hfp-settings-msg"></p></div></div>`;
  const ME = { data: { name: 'Tess', tally: 0, ripple: 0, pledges: [], done: [], stories: [], saved: [], joinedMyInvites: [], invitesIJoined: [], settings: {} } };

  it('uploads a photo to the member, shows it, and can remove it', async () => {
    const p = await page('/account', HTML, (_m, path) => (path === '/api/me' ? ME : undefined));
    let member: Record<string, unknown> = { customFields: { 'first-name': 'Tess' }, auth: { email: 't@example.com' }, profileImage: null };
    const uploads: unknown[] = [];
    (p.window as unknown as Record<string, unknown>).$memberstackDom = {
      getCurrentMember: async () => ({ data: member }),
      updateMemberProfileImage: async (a: { profileImage: unknown }) => { uploads.push(a.profileImage); member = { ...member, profileImage: 'https://img.test/t.jpg' }; },
      deleteMemberProfileImage: async () => { member = { ...member, profileImage: null }; },
    };
    await p.settle();
    const input = p.document.querySelector('#hfp-photo-row input[type=file]') as unknown as { dispatchEvent: (e: unknown) => void };
    const file = { type: 'image/jpeg', size: 1000, name: 'me.jpg' };
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new p.window.Event('change'));
    await p.settle();
    expect(uploads).toEqual([file]);
    const avatar = p.document.querySelector('[data-hf-avatar]')!;
    expect(avatar.getAttribute('data-hf-photo')).toBe('1');
    expect(p.document.getElementById('hfp-photo-remove')!.getAttribute('data-hf-on')).toBe('1');
    expect(p.document.getElementById('hfp-settings-msg')!.textContent).toBe(WORDING['photo-saved']);
    (p.document.getElementById('hfp-photo-remove') as unknown as { click: () => void }).click();
    await p.settle();
    expect(avatar.getAttribute('data-hf-photo')).toBeNull();
    expect(p.document.getElementById('hfp-photo-remove')!.getAttribute('data-hf-on')).toBeNull();
  });

  it('refuses a file that is not a photo or is too large', async () => {
    const p = await page('/account', HTML, (_m, path) => (path === '/api/me' ? ME : undefined));
    (p.window as unknown as Record<string, unknown>).$memberstackDom = { getCurrentMember: async () => ({ data: {} }) };
    await p.settle();
    const input = p.document.querySelector('#hfp-photo-row input[type=file]') as unknown as { dispatchEvent: (e: unknown) => void };
    Object.defineProperty(input, 'files', { value: [{ type: 'image/png', size: 9e6 }], configurable: true });
    input.dispatchEvent(new p.window.Event('change'));
    await p.settle();
    expect(p.document.getElementById('hfp-settings-msg')!.textContent).toBe(WORDING['photo-too-big']);
    Object.defineProperty(input, 'files', { value: [{ type: 'application/pdf', size: 10 }], configurable: true });
    input.dispatchEvent(new p.window.Event('change'));
    await p.settle();
    expect(p.document.getElementById('hfp-settings-msg')!.textContent).toBe(WORDING['photo-not-image']);
  });
});

describe('Impact numbers', () => {
  it('fills in the live counts and hides one that is still zero', async () => {
    const html = '<section><div><p data-hf-fill="impact-people">–</p><p>people made happy</p></div><div id="st"><p data-hf-fill="impact-stories">–</p><p>stories shared</p></div></section>';
    const p = await page('/', html, (m, path) => (path === '/api/impact' ? { data: { peopleMadeHappy: 1234, actions: 114, stories: 0 } } : undefined));
    expect(p.document.querySelector('[data-hf-fill="impact-people"]')!.textContent).toBe((1234).toLocaleString());
    expect((p.document.getElementById('st') as unknown as { hidden: boolean }).hidden).toBe(true);
  });
});

const DARE_HTML = `<section id="hf-dare" data-hf-show="dare"><p data-hf-fill="dare-title">x</p><p data-hf-fill="dare-short">x</p><p data-hf-fill="dare-count">x</p><a id="hf-dare-link" href="/actions">Take the dare</a></section>`;

describe('Weekly dare', () => {
  it('fills and shows the home block, with encouraging words below 10', async () => {
    const p = await page('/', DARE_HTML, (_m, path) => (path === '/api/dare' ? { data: { dare: { slug: 'call-a-grandparent', title: 'Call a grandparent', shortAnswer: 'Ring them today.', count: null } } } : undefined));
    const box = p.document.getElementById('hf-dare')!;
    expect(box.hasAttribute('data-hf-on')).toBe(true);
    expect(box.textContent).toContain('Call a grandparent');
    expect(box.textContent).toContain("Be one of the first to take this week's dare");
    expect(p.document.getElementById('hf-dare-link')!.getAttribute('href')).toBe('/action/call-a-grandparent');
  });

  it('shows the count from 10 up', async () => {
    const p = await page('/', DARE_HTML, (_m, path) => (path === '/api/dare' ? { data: { dare: { slug: 'x', title: 'X', shortAnswer: '', count: 142 } } } : undefined));
    expect(p.document.getElementById('hf-dare')!.textContent).toContain('142 people took the dare this week');
  });

  it('stays hidden when no dare is set', async () => {
    const p = await page('/', DARE_HTML, (_m, path) => (path === '/api/dare' ? { data: { dare: null } } : undefined));
    expect(p.document.getElementById('hf-dare')!.hasAttribute('data-hf-on')).toBe(false);
  });

  it("shows the dare line only on the dare's own action page", async () => {
    const tag = `<div id="hf-dare-tag" data-hf-show="dare"><p>This week's dare</p><p data-hf-fill="dare-count">x</p></div>`;
    const handler = (_m: string, path: string) => (path === '/api/dare' ? { data: { dare: { slug: 'cook-a-meal', title: 'Cook', shortAnswer: '', count: 12 } } } : undefined);
    const on = await page('/action/cook-a-meal', tag, handler);
    expect(on.document.getElementById('hf-dare-tag')!.hasAttribute('data-hf-on')).toBe(true);
    expect(on.document.getElementById('hf-dare-tag')!.textContent).toContain('12 people took the dare this week');
    const off = await page('/action/something-else', tag, handler);
    expect(off.document.getElementById('hf-dare-tag')!.hasAttribute('data-hf-on')).toBe(false);
  });
});
