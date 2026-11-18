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

// The action template as built in Webflow. Webflow leaves out the buttons whose
// switch is off: a group action has "Do this with me" first and a second "I did this";
// an on-my-own action has the main "I did this" only.
function actionHtml(group: boolean) {
  const buttons = group
    ? `<a data-hf-act="with-me" href="#" class="hf-button">Do this with me</a><a data-hf-act="done" href="#" class="hf-button-light">I did this</a>`
    : `<a id="hf-did-this" data-hf-act="done" href="#" class="hf-button">I did this</a>`;
  return `<h1>Cook a meal</h1><p class="hf-lead">Cook for someone.</p><p data-hf-show="suggested" data-hf-fill="suggested">Suggested by</p>
<section data-hf-pages="1"><div>
<p data-hf-show="count" data-hf-fill="count">12 people</p>
<div class="hf-button-row" data-hf-row="action">${buttons}<a data-hf-act="save" data-hf-show="save" href="#">♡ Save</a><a data-hf-act="story" data-hf-show="story" href="/share-your-story">Share your story</a></div>
${group ? '<p class="hf-note">Invite someone to do it with you, not the person you are doing it for.</p>' : ''}
<p data-hf-show="group" data-hf-fill="group">x</p>
<p id="hf-did-msg" class="hf-status"></p>
<a data-hf-act="undo" data-hf-show="undo" href="#">Undo</a>
<p data-hf-show="together" data-hf-fill="together">x</p>
<p data-hf-fill="share-note"></p>
<div data-hf-show="compose"><form data-hf-form="compose"><label for="note">Add a short note (optional)</label><textarea id="note" data-hf-field="note"></textarea><p data-hf-fill="note-left">280 characters left</p><div><input type="submit" value="Share invite"><a data-hf-act="compose-cancel" href="#">Cancel</a></div></form></div>
<div data-hf-show="ask-name"><form data-hf-form="ask-name"><input id="first-name" data-hf-field="first-name"><input type="submit" value="Save and share"></form></div>
<div data-hf-show="win"><p>Shared moment</p><p>I made someone happy today</p>
<div data-hf-show="ripple"><p data-hf-fill="ripple-h">x</p><div data-hf-slot="ripple"></div><p data-hf-fill="ripple-caption">x</p><p data-hf-show="ripple-more" data-hf-fill="ripple-more">x</p><p data-hf-show="ripple-hint">Share your action to see it spread.</p></div>
<div data-hf-show="proof"><div data-hf-slot="proof"></div><div data-hf-show="proof-name"><form data-hf-form="proof-name"><input type="checkbox" data-hf-field="proof-name"> Add my first name</form></div><a data-hf-act="card-share" data-hf-show="card-share" href="#">Share to your Story</a><a data-hf-act="card-download" href="#">Download the card</a><p data-hf-show="card-hint">Save it, then post it to your Story.</p></div>
<div data-hf-show="pass"><a data-hf-act="pass" href="#">Pass it on</a></div>
<div data-hf-show="keep"><h3>Keep this – create a free account</h3><a data-hf-act="signup" href="/account">Create a free account</a><a data-hf-act="signin" href="/account">I have an account</a></div>
</div>
<div data-hf-show="keep-line"><p>It's saved on this device for 30 days.</p><a data-hf-act="signup" href="/account">Create a free account</a></div>
</div></section>
<section data-hf-show="stories"><h2>Stories</h2><div data-hf-slot="clips"></div><div data-hf-slot="stories"></div></section>
<div data-hf-show="templates"><article class="hf-story" data-hf-template="story"><div class="hf-clip" data-hf-part="clip"><a data-hf-part="sound" href="#">Tap for sound</a><p data-hf-part="sorry" hidden>This video can't play in this browser.</p></div><div class="hf-video-frame" data-hf-part="embed"></div><div data-hf-part="photo"></div><p data-hf-part="text">x</p><p data-hf-part="meta">x</p><p data-hf-part="action"><a data-hf-part="action-link" href="/actions">x</a></p><div><a data-hf-act="report" href="#">Report this story</a><p data-hf-part="report-note"></p></div></article></div>
<footer></footer>`;
}
/** Shown on the page: not inside a [data-hf-show] that is still off. */
function shown(e: Element | null): boolean {
  for (let n: Element | null = e; n; n = n.parentElement) if (n.hasAttribute('data-hf-show') && !n.hasAttribute('data-hf-on')) return false;
  return !!e;
}
const act = (doc: { querySelector(s: string): Element | null }, name: string) => doc.querySelector(`[data-hf-act="${name}"]`) as unknown as HTMLElement;

describe('Action page', () => {
  it('marks done, shows the win, then "I did this again" and undo', async () => {
    let me = { done: false, doneToday: false, canUndo: false, liked: false, tally: 0, doneWith: [] as string[], story: null };
    const state = () => ({ data: { actionId: 'a1', slug: 'cook-a-meal', title: 'Cook a meal', count: 12, canDoWithOthers: false, suggestedBy: 'Ana', stories: [], me } });
    const p = await page('/action/cook-a-meal', actionHtml(false), (m, path) => {
      if (path.endsWith('/state')) return state();
      if (m === 'POST' && path === '/api/actions/a1/done') {
        me = { ...me, done: true, doneToday: true, canUndo: true, tally: 1 };
        return { status: 201, data: { tally: 1, count: null, ripple: 0, rippleView: { reached: 1, rings: [{ marks: 1, people: 1, dots: ['Cook a meal'] }] } } };
      }
      if (m === 'DELETE' && path === '/api/actions/a1/done') {
        me = { ...me, done: false, doneToday: false, canUndo: false, tally: 0 };
        return { data: { done: false, tally: 0 } };
      }
    });
    const d = p.document;
    expect(d.querySelector('[data-hf-fill="suggested"]')!.textContent).toBe('Suggested by Ana');
    expect(shown(d.querySelector('[data-hf-fill="count"]'))).toBe(true);
    expect(d.querySelector('[data-hf-fill="count"]')!.textContent).toBe('12 people have done this');
    expect(shown(act(d, 'save'))).toBe(true);
    expect(shown(d.querySelector('[data-hf-show="win"]'))).toBe(false);
    act(d, 'done').click();
    await p.settle();
    // A calm "Done" moment first, then back to "I did this again".
    expect(act(d, 'done').textContent).toBe('✓ Done – nice one');
    expect(act(d, 'done').classList.contains('is-done')).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect(act(d, 'done').textContent).toBe('I did this again');
    expect(shown(d.querySelector('[data-hf-show="win"]'))).toBe(true);
    expect(d.querySelector('[data-hf-fill="ripple-h"]')!.textContent).toBe('Your actions have reached 1 person');
    expect(d.querySelector('[data-hf-slot="ripple"] svg')).toBeTruthy();
    expect(shown(d.querySelector('[data-hf-show="pass"]'))).toBe(true);
    expect(shown(d.querySelector('[data-hf-show="keep"]'))).toBe(false);
    expect(d.getElementById('hf-did-msg')!.textContent).toBe('You have made 1 person happy.');
    expect(shown(act(d, 'undo'))).toBe(true);
    expect(shown(act(d, 'story'))).toBe(true);
    expect(act(d, 'story').getAttribute('href')).toBe('/share-your-story?action=cook-a-meal');
    act(d, 'undo').click();
    await p.settle();
    expect(act(d, 'done').textContent).toBe('I did this');
    expect(shown(d.querySelector('[data-hf-show="win"]'))).toBe(false);
    // Undo straight after "I did this" ends the Done moment with the right label.
    act(d, 'done').click();
    await p.settle();
    expect(act(d, 'done').textContent).toBe('✓ Done – nice one');
    act(d, 'undo').click();
    await p.settle();
    expect(act(d, 'done').textContent).toBe('I did this');
    expect(act(d, 'done').classList.contains('is-done')).toBe(false);
    await new Promise((r) => setTimeout(r, 2500));
    expect(act(d, 'done').textContent).toBe('I did this');
    expect(d.getElementById('hf-did-msg')!.textContent).toBe('Undone.');
    // Nothing visible is made by the script: no buttons, forms or cards of its own.
    expect(d.querySelectorAll('button').length).toBe(0);
  });

  it('"Do this with me" opens the note form, then shares the invite', async () => {
    const p = await page('/action/cook-a-meal', actionHtml(true), (m, path, body) => {
      if (path.endsWith('/state')) return { data: { actionId: 'a1', canDoWithOthers: true, stories: [], me: { done: false } } };
      if (m === 'POST' && path === '/api/invites') return { status: 201, data: { code: 'AbCdEfGh23', url: 'https://site.test/join/AbCdEfGh23', text: (body as { note: string }).note } };
    });
    const shared: unknown[] = [];
    Object.defineProperty(p.window.navigator, 'share', { value: async (d: unknown) => void shared.push(d), configurable: true });
    const d = p.document;
    act(d, 'with-me').click();
    await p.settle();
    expect(shown(d.querySelector('[data-hf-show="compose"]'))).toBe(true);
    const ta = d.querySelector('[data-hf-field="note"]') as unknown as HTMLTextAreaElement;
    expect(ta.getAttribute('placeholder')).toContain('Want to do this with me');
    ta.value = 'Saturday?';
    d.querySelector('[data-hf-form="compose"]')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls.find((c) => c.path === '/api/invites')!.body).toEqual({ actionId: 'a1', kind: 'with_me', note: 'Saturday?' });
    expect(shared).toEqual([expect.objectContaining({ text: 'Saturday?', url: 'https://site.test/join/AbCdEfGh23' })]);
    expect(shown(d.querySelector('[data-hf-show="compose"]'))).toBe(false);
  });

  it('asks for a first name before the first invite, then sends it', async () => {
    let named = false;
    const p = await page('/action/cook-a-meal', actionHtml(true), (m, path) => {
      if (path.endsWith('/state')) return { data: { actionId: 'a1', canDoWithOthers: true, stories: [], me: { done: false } } };
      if (m === 'PATCH' && path === '/api/me/settings') { named = true; return { data: {} }; }
      if (m === 'POST' && path === '/api/invites') return named ? { status: 201, data: { code: 'AbCdEfGh23', url: 'https://site.test/join/AbCdEfGh23', text: 'x' } } : { status: 409, data: { error: 'need_first_name' } };
    });
    Object.defineProperty(p.window.navigator, 'share', { value: async () => undefined, configurable: true });
    const d = p.document;
    act(d, 'with-me').click();
    await p.settle();
    d.querySelector('[data-hf-form="compose"]')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(shown(d.querySelector('[data-hf-show="ask-name"]'))).toBe(true);
    (d.querySelector('[data-hf-field="first-name"]') as unknown as HTMLInputElement).value = 'Mickey';
    d.querySelector('[data-hf-form="ask-name"]')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.calls).toContainEqual({ method: 'PATCH', path: '/api/me/settings', body: { firstName: 'Mickey' } });
    expect(p.calls.filter((c) => c.path === '/api/invites')).toHaveLength(2);
    expect(shown(d.querySelector('[data-hf-show="ask-name"]'))).toBe(false);
  });

  it('sends a signed-out visitor to sign in for Save, and remembers the click', async () => {
    const p = await page('/action/cook-a-meal', actionHtml(false), (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [] } } : undefined), { signedIn: false });
    act(p.document, 'save').click();
    await p.settle();
    expect(p.signIns).toEqual([{ kind: 'like', actionId: 'a1' }]);
    expect(p.document.getElementById('hf-did-msg')!.textContent).toContain('Taking you to sign in');
  });

  it('lets a signed-out visitor mark it done, shows the win, then a soft ask to keep it', async () => {
    let done = false;
    const p = await page(
      '/action/cook-a-meal',
      actionHtml(false),
      (m, path) => {
        if (path.endsWith('/state')) return { data: { actionId: 'a1', stories: [], me: done ? { done: true, guest: true, tally: 1, canUndo: true, doneWith: [] } : { done: false, guest: true, tally: 0 } } };
        if (m === 'POST' && path === '/api/actions/a1/done') { done = true; return { status: 201, data: { guest: true, ripple: 0, tally: 1 } }; }
      },
      { signedIn: false },
    );
    const d = p.document;
    act(d, 'done').click();
    await p.settle();
    expect(p.signIns).toEqual([]);
    expect(p.calls).toContainEqual({ method: 'POST', path: '/api/actions/a1/done', body: undefined });
    expect(shown(d.querySelector('[data-hf-show="win"]'))).toBe(true);
    expect(shown(d.querySelector('[data-hf-show="keep"]'))).toBe(true);
    expect(shown(d.querySelector('[data-hf-show="pass"]'))).toBe(false);
    expect(d.getElementById('hf-did-msg')!.textContent).toBe('You have made 1 person happy.');
    // Sharing a story needs an account, so it waits.
    expect(shown(act(d, 'story'))).toBe(false);
  });

  it('shows approved stories from the Webflow story card, videos and report link included', async () => {
    const story = { id: 7, text: 'They cried.', name: 'Ana', with: ['Ben'], createdAt: '2026-11-16T09:00:00Z', photo: null, video: { embed: 'https://www.tiktok.com/embed/v2/1?muted=1', vertical: true }, clip: null, action: { title: 'Cook', slug: 'cook' } };
    const clip = { ...story, id: 8, video: null, clip: { key: 'videos/abcdefghijklmnopqrstuvwx.mp4', poster: null, codec: 'avc1' } };
    const p = await page('/action/cook-a-meal', actionHtml(false), (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [story, clip] } } : undefined));
    const d = p.document;
    expect(shown(d.querySelector('[data-hf-show="stories"]'))).toBe(true);
    const list = d.querySelector('[data-hf-slot="stories"]')!;
    expect(list.querySelector('.hf-video-frame.is-vertical iframe')!.getAttribute('src')).toContain('muted=1');
    expect(list.textContent).toContain('Ana, with Ben');
    expect(list.querySelector('[data-hf-act="report"]')!.getAttribute('data-story-id')).toBe('7');
    expect(d.querySelector('[data-hf-slot="clips"] video')!.getAttribute('src')).toBe('/join/media/videos/abcdefghijklmnopqrstuvwx.mp4');
  });
});

const INVITE_HTML = `<div><h1 id="hf-join-title">Do this with me</h1><blockquote data-hf-show="note" data-hf-fill="note">x</blockquote>
  <div><p id="hf-join-action"></p><p id="hf-join-desc"></p></div>
  <div data-hf-show="alternatives"><ul data-hf-slot="alternatives"><li data-hf-template="alternative" data-hf-show="template"><a data-hf-part="title" href="/actions">x</a></li></ul></div>
  <p data-hf-show="group" data-hf-fill="group">x</p>
  <p><a id="hf-join-in" href="/x" class="hf-button">I'm in</a><a data-hf-show="see" data-hf-link="see" href="/actions">See the action</a></p>
  <div data-hf-show="ask-name"><form data-hf-form="ask-name"><label for="first-name">Your first name</label><input id="first-name" data-hf-field="first-name" required><input type="submit" value="I'm in"></form></div>
  <div data-hf-show="joined"><span data-hf-fill="joined">x</span><a data-hf-act="leave" href="#">Leave this invite</a></div>
  <p id="hf-join-note"></p></div>`;
const invOn = (d: Document, k: string) => d.querySelector(`[data-hf-show="${k}"]`)!.hasAttribute('data-hf-on');

describe('Invite page', () => {
  it("shows who it is from and joins on \"I'm in\"", async () => {
    let joined = false;
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, (m, path) => {
      if (m === 'GET' && path === '/api/invites/AbCdEfGh23') return { data: { kind: 'with_me', inviterName: 'Ana', note: 'Saturday?', action: { title: 'Cook a meal', shortAnswer: 'Cook for someone', slug: 'cook', live: true }, alternatives: [], me: { isMine: false, joined } } };
      if (m === 'POST') { joined = true; return { data: { joined: true } }; }
      if (m === 'DELETE') { joined = false; return { data: { left: true } }; }
    });
    expect(p.document.getElementById('hf-join-title')!.textContent).toBe('Ana wants to do this with you');
    expect(p.document.querySelector('[data-hf-fill="note"]')!.textContent).toBe('“Saturday?” – Ana');
    expect(invOn(p.document as unknown as Document, 'note')).toBe(true);
    p.document.getElementById('hf-join-in')!.click();
    await p.settle();
    expect(p.document.getElementById('hf-join-in')!.textContent).toBe("You're in");
    expect(invOn(p.document as unknown as Document, 'joined')).toBe(true);
    expect(invOn(p.document as unknown as Document, 'see')).toBe(true);
    expect(p.document.querySelector('[data-hf-link="see"]')!.getAttribute('href')).toBe('/action/cook');
    (p.document.querySelector('[data-hf-act="leave"]') as unknown as { click: () => void }).click();
    await p.settle();
    expect(p.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/invites/AbCdEfGh23/join' }));
  });

  it('a signed-out visitor joins with just a first name, and sees the group', async () => {
    let joined = false;
    const p = await page(
      '/do-this-with-me?i=AbCdEfGh23',
      INVITE_HTML,
      (m, path) => {
        if (m === 'POST' && path.endsWith('/join')) { joined = true; return { data: { joined: true } }; }
        return { data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Cook', shortAnswer: 'Cook', slug: 'cook', live: true }, alternatives: [], group: joined ? { count: 2, names: ['Ben'], more: 0 } : { count: 1, names: [], more: 0 }, me: joined ? { isMine: false, joined: true } : null } };
      },
      { signedIn: false },
    );
    expect(p.document.querySelector('[data-hf-fill="group"]')!.textContent).toContain('Just you so far');
    expect(invOn(p.document as unknown as Document, 'ask-name')).toBe(false);
    p.document.getElementById('hf-join-in')!.click();
    await p.settle();
    expect(p.signIns).toEqual([]);
    expect(invOn(p.document as unknown as Document, 'ask-name')).toBe(true);
    const input = p.document.getElementById('first-name') as unknown as { value: string };
    input.value = 'Ben';
    p.document.querySelector('[data-hf-form="ask-name"]')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }));
    await p.settle();
    expect(p.calls).toContainEqual({ method: 'POST', path: '/api/invites/AbCdEfGh23/join', body: { firstName: 'Ben' } });
    expect(p.document.getElementById('hf-join-in')!.textContent).toBe("You're in");
    expect(p.document.querySelector('[data-hf-fill="group"]')!.textContent).toBe('2 of you are in: Ben');
    expect(invOn(p.document as unknown as Document, 'ask-name')).toBe(false);
  });

  it('caps the names at five, then "+ N more"', async () => {
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, () => ({ data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Cook', shortAnswer: '', slug: 'cook', live: true }, alternatives: [], group: { count: 201, names: ['A', 'B', 'C', 'D', 'E'], more: 195 }, me: null } }));
    expect(p.document.querySelector('[data-hf-fill="group"]')!.textContent).toBe('201 of you are in: A, B, C, D, E + 195 more');
  });

  it('a removed action shows three others', async () => {
    const alts = [1, 2, 3].map((n) => ({ slug: `a${n}`, title: `Action ${n}` }));
    const p = await page('/do-this-with-me?i=AbCdEfGh23', INVITE_HTML, () => ({ data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Old', slug: null, live: false }, alternatives: alts, me: null } }));
    expect(p.document.getElementById('hf-join-title')!.textContent).toBe('This action is no longer available');
    const links = [...p.document.querySelectorAll('[data-hf-slot="alternatives"] > li:not([data-hf-template]) a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/action/a1', '/action/a2', '/action/a3']);
    expect(invOn(p.document as unknown as Document, 'alternatives')).toBe(true);
    expect(p.document.getElementById('hf-join-in')!.style.display).toBe('none');
  });
});

const STORY_HTML = `<h1>Share your story</h1><p id="hf-story-note"></p><div data-hf-show="note-link"><a data-hf-link="note" href="/account">x</a></div><p data-hf-show="deleted">Deleted</p>
<div class="w-form hf-form" data-hf-show="story-form"><form id="hf-story-form"><p id="hf-story-title">Your action</p><p id="hf-story-status"></p><label for="hfp-story-text">Your story</label><textarea id="hfp-story-text"></textarea>
<input type="file" id="hfp-photo"><div id="hfp-photo-area"><p data-hf-fill="photo-msg"></p><img data-hf-show="photo" data-hf-part="photo-preview" alt=""><a data-hf-show="photo" data-hf-act="remove-photo" href="#">Remove photo</a></div><input id="hfp-photo-desc">
<div><input type="file" data-hf-field="video-file"><p data-hf-show="file-off">x</p><p data-hf-fill="video-msg"></p><video data-hf-show="video" data-hf-part="video-preview"></video><a data-hf-show="video-retry" data-hf-act="video-retry" href="#">Try again</a><a data-hf-show="video" data-hf-act="video-remove" href="#">Remove video</a>
<div data-hf-show="video-ask"><label><input type="checkbox" data-hf-field="video-consent"><span>Agreed</span></label><label><input type="radio" name="k" data-hf-field="kids-yes"><span>Yes</span></label><label><input type="radio" name="k" data-hf-field="kids-no"><span>No</span></label></div></div>
<input id="hfp-video"><p data-hf-show="link-off">x</p>
<div id="hfp-with"><fieldset data-hf-show="with"><legend>Who did it with you?</legend><div data-hf-slot="with"><label data-hf-template="with" data-hf-show="template"><input type="checkbox" data-hf-part="box"><span data-hf-part="name">x</span></label></div></fieldset></div>
<label class="w-checkbox"><input type="checkbox" id="hfp-show-name"><span class="w-form-label">Show my first name</span></label><label class="w-checkbox"><input type="checkbox" id="hfp-consent" required><span class="w-form-label">Everyone agreed</span></label><input type="submit" value="Share my story"><p data-hf-fill="story-msg"></p><div data-hf-show="delete"><a data-hf-act="delete" href="#">Delete my story</a></div></form>
<div class="w-form-done" style="display:none"><p>Thank you for sharing.</p><a data-hf-link="back" href="/actions">Back to the action</a></div><div class="w-form-fail" style="display:none"><p>Did not send.</p></div></div>`;

describe('Share your story', () => {
  it('needs the consent tick, then sends the story to the backend', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, (m, path, body) => {
      if (path.startsWith('/api/stories/mine')) return { data: { done: true, story: null, withCandidates: [{ id: 2, name: 'Ben' }], name: 'Ana' } };
      if (m === 'POST' && path === '/api/stories') return { status: 201, data: { id: 1, status: 'new', body } };
    });
    const d = p.document;
    const isOn = (k: string) => d.querySelector(`[data-hf-show="${k}"]`)!.hasAttribute('data-hf-on');
    expect(isOn('story-form')).toBe(true);
    expect(isOn('with')).toBe(true);
    expect(isOn('delete')).toBe(false);
    expect(isOn('video')).toBe(false);
    expect(isOn('photo')).toBe(false);
    expect(d.querySelector('[data-hf-link="back"]')!.getAttribute('href')).toBe('/action/cook');
    expect(d.getElementById('hf-story-title')!.textContent).toBe('cook');
    const form = d.getElementById('hf-story-form')!;
    (d.getElementById('hfp-story-text') as unknown as HTMLTextAreaElement).value = 'We cooked.';
    const box = d.querySelector('[data-hf-slot="with"] > label:not([data-hf-template]) input') as unknown as HTMLInputElement;
    expect(box.value).toBe('2');
    expect(box.parentElement!.textContent).toBe('Ben');
    box.checked = true;
    // A video link greys out the upload, and the other way round.
    const link = d.getElementById('hfp-video') as unknown as HTMLInputElement;
    link.value = 'https://youtu.be/x';
    link.dispatchEvent(new p.window.Event('input') as unknown as Event);
    expect((d.querySelector('[data-hf-field="video-file"]') as unknown as HTMLInputElement).disabled).toBe(true);
    expect(isOn('file-off')).toBe(true);
    link.value = '';
    link.dispatchEvent(new p.window.Event('input') as unknown as Event);
    expect(isOn('file-off')).toBe(false);
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

  it('shows a saved video story with its preview, and Delete takes it down', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, (m, path) => {
      if (path.startsWith('/api/stories/mine')) return { data: { done: true, story: { id: 7, status: 'new', text: 'Hi', videoKey: 'videos/a.mp4', posterKey: 'p/a.jpg', hasChildren: 0, showName: true }, withCandidates: [], name: 'Ana' } };
      if (m === 'DELETE') return { data: { deleted: true } };
    });
    const d = p.document;
    const isOn = (k: string) => d.querySelector(`[data-hf-show="${k}"]`)!.hasAttribute('data-hf-on');
    expect(isOn('video')).toBe(true);
    expect(isOn('video-ask')).toBe(true);
    expect(isOn('with')).toBe(false);
    expect(isOn('link-off')).toBe(true);
    expect(d.querySelector('[data-hf-part="video-preview"]')!.getAttribute('src')).toContain('videos/a.mp4');
    expect((d.querySelector('[data-hf-field="kids-no"]') as unknown as HTMLInputElement).checked).toBe(true);
    (p.window as unknown as { confirm: () => boolean }).confirm = () => true;
    (d.querySelector('[data-hf-act="delete"]') as unknown as { click: () => void }).click();
    await p.settle();
    expect(p.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/stories/7' }));
    expect(isOn('deleted')).toBe(true);
    expect(isOn('story-form')).toBe(false);
  });

  it('sends a member who has not done the action back to it', async () => {
    const p = await page('/share-your-story?action=cook', STORY_HTML, () => ({ data: { done: false, story: null, withCandidates: [] } }));
    expect(p.document.getElementById('hf-story-note')!.textContent).toContain('Mark it done first.');
    expect(p.document.querySelector('[data-hf-link="note"]')!.getAttribute('href')).toBe('/action/cook');
    expect(p.document.querySelector('[data-hf-show="note-link"]')!.hasAttribute('data-hf-on')).toBe(true);
    expect(p.document.querySelector('[data-hf-show="story-form"]')!.hasAttribute('data-hf-on')).toBe(false);
  });
});

describe('Suggest an action', () => {
  it('sends the idea to the backend instead of the Webflow form', async () => {
    const html = `<div class="w-form"><form id="wf-form-Suggest-an-action"><p data-hf-show="signin-note">You will be asked to sign in</p><textarea id="Idea"></textarea><input type="submit" value="Send"><p data-hf-fill="sug-msg"></p></form><div class="w-form-done" style="display:none"><p>Thank you. Your idea is with us.</p></div><div class="w-form-fail" style="display:none"></div></div>`;
    const p = await page('/suggest-an-action', html, (m, path) => (m === 'POST' && path === '/api/suggestions' ? { status: 201, data: { id: 1 } } : undefined));
    expect(p.document.querySelector('[data-hf-show="signin-note"]')!.hasAttribute('data-hf-on')).toBe(false);
    p.document.getElementById('wf-form-Suggest-an-action')!.dispatchEvent(new p.window.Event('submit', { cancelable: true }) as unknown as Event);
    await p.settle();
    expect(p.document.querySelector('[data-hf-fill="sug-msg"]')!.textContent).toBe(WORDING['sug-empty']);
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
    const field = (n: string, type: string) => `<div data-hf-show="auth-f-${n}"><label for="hfp-auth-${n}">${n}</label><input id="hfp-auth-${n}" class="hf-form-input" type="${type}" name="${n}" data-hf-field="${n}"></div>`;
    const link = (show: string, to: string, text: string) => `<a href="#" data-hf-act="auth-to" data-hf-to="${to}" data-hf-show="auth-l-${show}">${text}</a>`;
    const AUTH_HTML = `<footer><dialog id="hfp-auth" class="hf-auth" data-hf-auth="1"><a href="#" data-hf-act="auth-close" aria-label="Close">×</a><img class="hf-auth-logo" src="https://site.test/logo.png" alt="Happiness Foundation">
      <p id="hfp-auth-title" data-hf-fill="auth-title">Sign in</p>
      <div data-hf-show="auth-providers"><a href="#" data-hf-act="auth-google"><span>Continue with Google</span></a><a href="#" data-hf-act="auth-otp"><span>Email me a sign-in code</span></a><div><span>or</span></div></div>
      <div class="w-form"><form data-hf-form="auth" novalidate>${field('first-name', 'text')}${field('email', 'email')}${field('code', 'text')}${field('password', 'password')}${field('password-new', 'password')}<button type="submit" data-hf-fill="auth-go">Sign in</button><p data-hf-fill="auth-msg"></p></form><div class="w-form-done">Thank you</div><div class="w-form-fail">Oops</div></div>
      <div>${link('forgot', 'reset', 'Forgot password?')}${link('signup', 'signup', 'New here? Create a free account')}${link('signin', 'signin', 'Already have an account? Sign in')}${link('password', 'password', 'Use a password instead')}${link('back', 'signin', 'Back to sign in')}</div></dialog></footer>`;
    const p = await page('/account', AUTH_HTML, () => undefined);
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
      const i = p.document.querySelector(`#hfp-auth input[name="${name}"]:not([disabled])`) as unknown as { value: string };
      i.value = value;
    };
    const submit = async () => {
      (p.document.querySelector('#hfp-auth form') as unknown as { requestSubmit: () => void }).requestSubmit();
      await p.settle();
    };
    // What a visitor sees: text of the parts that are switched on (or never switched).
    const text = () => {
      const d = p.document.getElementById('hfp-auth')!.cloneNode(true) as unknown as Element;
      d.querySelectorAll('[data-hf-show]:not([data-hf-on])').forEach((e) => e.remove());
      return d.textContent || '';
    };
    const click = (sel: string) => (p.document.querySelector(`#hfp-auth ${sel}`) as unknown as { click: () => void }).click();
    return { ...p, w, done, fill, submit, text, click, reloads: () => reloads };
  }

  it('is ours: our logo and wording, no Memberstack window, and a way to create an account', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    expect((a.document.getElementById('hfp-auth') as unknown as { open: boolean }).open).toBe(true);
    expect(a.text()).toContain('New here? Create a free account');
    expect(a.text()).toContain('Continue with Google');
    expect(a.text()).not.toContain('Back to sign in');
    expect(a.document.getElementById('hfp-auth-title')!.textContent).toBe(WORDING['auth-signin-title']);
    expect((a.document.querySelector('[data-hf-field="first-name"]') as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(a.text().toLowerCase()).not.toContain('memberstack');
  });

  it('creates an account with the first name, and reloads signed in', async () => {
    const a = await authPage();
    a.w.HFP.auth('signin');
    a.click('[data-hf-to="signup"]');
    expect(a.text()).toContain(WORDING['auth-signup-title']);
    a.fill('first-name', 'Tess');
    a.fill('email', 'tess@example.com');
    a.fill('password-new', 'short');
    await a.submit();
    expect(a.text()).toContain(WORDING['auth-err-password']);
    a.fill('password-new', 'long enough');
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
    a.click('[data-hf-to="reset"]');
    a.fill('email', 'tess@example.com');
    await a.submit();
    expect(a.text()).toContain('We sent a code to tess@example.com');
    a.fill('code', '123456');
    a.fill('password-new', 'a new password');
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
    expect(a.text()).toContain('Email me a sign-in code');
    a.click('[data-hf-act="auth-otp"]');
    expect(a.text()).toContain('Use a password instead');
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
    a.click('[data-hf-act="auth-otp"]');
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

  it('the Account home area box follows the header, and browsing "All locations" keeps the home area', async () => {
    const html = HTML + '<select id="hfp-home-area"><option value="">No home area</option><option value="copenhagen">Copenhagen</option></select>';
    const p = await page('/', html, () => ({ data: {} }));
    const loc = p.document.getElementById('hf-loc') as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    const home = p.document.getElementById('hfp-home-area') as unknown as { value: string };
    loc.value = 'copenhagen';
    loc.dispatchEvent(new p.window.Event('change'));
    expect(home.value).toBe('copenhagen');
    await new Promise((r) => setTimeout(r, 700));
    p.calls.length = 0;
    loc.value = '';
    loc.dispatchEvent(new p.window.Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    expect(home.value).toBe('copenhagen');
    expect(p.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
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

describe('Account lists (built in Webflow)', () => {
  const T = (name: string, inner: string) => `<li data-hf-template="${name}" data-hf-show="template">${inner}</li>`;
  const HTML = `<div id="hf-acct-in" data-hf-show="signed-in"><p id="hf-tally"></p><p id="hfp-ripple">When someone you invite takes an action, it shows here.</p>
    <div class="hf-acct-card" id="acct-ripple" data-hf-show="ripple"><p data-hf-fill="ripple-h"></p><div data-hf-slot="ripple"></div><p data-hf-fill="ripple-caption"></p><p data-hf-show="ripple-more" data-hf-fill="ripple-more"></p><p data-hf-show="ripple-hint">Share</p></div>
    <div class="hf-acct-card" id="acct-pledges"><h2 class="hf-acct-card-title"><a data-hf-act="fold" href="#acct-pledges"><span>Your pledges</span><span data-hf-fill="fold-count"></span></a></h2>
      <div id="hf-pledges"><p data-hf-part="empty">No pledges yet.</p><ul data-hf-slot="pledges">${T('pledge', '<div><span data-hf-part="state">Open</span><span data-hf-part="date">x</span></div><p data-hf-part="kept">x</p><a data-hf-part="keep" href="/actions"><span>Find an action</span></a>')}</ul></div></div>
    <div class="hf-acct-card" id="acct-saved" data-hf-show="saved"><h2 class="hf-acct-card-title"><a data-hf-act="fold" href="#acct-saved"><span>Saved</span><span data-hf-fill="fold-count"></span></a></h2><ul data-hf-slot="saved">${T('saved', '<a data-hf-part="title" href="/actions">x</a>')}</ul></div>
    <div class="hf-acct-card" id="acct-actions"><h2 class="hf-acct-card-title"><a data-hf-act="fold" href="#acct-actions"><span>Actions</span><span data-hf-fill="fold-count"></span></a></h2>
      <div id="hf-actions"><p data-hf-part="empty">Nothing here yet.</p><ul data-hf-slot="done">${T('done', '<a data-hf-part="title" href="/actions">x</a><span data-hf-part="meta">x</span><div><a data-hf-part="story" href="/share-your-story"><span data-hf-part="story-label">x</span></a><span data-hf-part="story-state">x</span></div>')}</ul></div></div>
    <div class="hf-acct-card" id="acct-invited" data-hf-show="invited"><h2 class="hf-acct-card-title"><a data-hf-act="fold" href="#acct-invited"><span>Invites</span><span data-hf-fill="fold-count"></span></a></h2><ul data-hf-slot="invited">${T('invited', '<a data-hf-part="title" href="/actions">x</a><p data-hf-part="by">x</p><a data-hf-act="leave" href="#">Leave</a>')}</ul></div>
    <div class="hf-acct-card" id="acct-joined" data-hf-show="joined"><ul data-hf-slot="joined">${T('joined', '<p data-hf-part="text">x</p>')}</ul></div>
  </div>`;
  const ME = { data: {
    name: 'Tess', tally: 3, ripple: 4, settings: {},
    rippleView: { reached: 4, rings: [{ marks: 2, dots: ['Call a grandparent', 'Cook a meal'] }] },
    pledges: [{ status: 'open', orderedAt: '2026-11-01T00:00:00Z' }, { status: 'kept', orderedAt: '2026-10-01T00:00:00Z', keptBySlug: 'cook-a-meal', keptByTitle: 'Cook a meal', keptOn: '2026-10-03T00:00:00Z' }],
    done: [{ actionId: 'a', slug: 'cook-a-meal', title: 'Cook a meal', actionStatus: 'published', doneAt: '2026-11-02T00:00:00Z' }, { actionId: 'a', slug: 'cook-a-meal', title: 'Cook a meal', actionStatus: 'published', doneAt: '2026-11-01T00:00:00Z' }, { actionId: 'b', slug: 'old', title: 'Old one', actionStatus: 'archived', doneAt: '2026-10-01T00:00:00Z' }],
    stories: [{ actionId: 'a', status: 'pending' }],
    saved: [], joinedMyInvites: [],
    invitesIJoined: [{ code: 'abc', actionSlug: 'cook-a-meal', actionTitle: 'Cook a meal', inviterName: 'Ana' }],
  } };

  it('fills the Webflow templates and leaves the designs hidden', async () => {
    const calls: string[] = [];
    const p = await page('/account', HTML, (m, path) => { calls.push(m + ' ' + path); return path === '/api/me' ? ME : { data: {} }; });
    (p.window as unknown as Record<string, unknown>).$memberstackDom = { getCurrentMember: async () => ({ data: {} }) };
    await p.settle();
    const d = p.document;
    const items = (slot: string) => [...d.querySelectorAll(`[data-hf-slot="${slot}"] > li:not([data-hf-template])`)];
    // Pledges: an open one with the keep link, a kept one with its action.
    const pl = items("pledges");
    expect(pl.length).toBe(2);
    expect(pl[0].querySelector('[data-hf-part="state"]')!.classList.contains('is-open')).toBe(true);
    expect(pl[0].querySelector('[data-hf-part="keep"]')).not.toBeNull();
    expect(pl[0].querySelector('[data-hf-part="kept"]')).toBeNull();
    expect(pl[1].querySelector('[data-hf-part="keep"]')).toBeNull();
    expect(pl[1].querySelector('[data-hf-part="kept"] a')!.getAttribute('href')).toBe('/action/cook-a-meal');
    expect((d.querySelector('#hf-pledges [data-hf-part="empty"]') as unknown as { style: { display: string } }).style.display).toBe('none');
    // Actions: one row per action, repeats counted, a story chip only for live actions.
    const dn = items('done');
    expect(dn.length).toBe(2);
    expect(dn[0].querySelector('[data-hf-part="meta"]')!.textContent).toContain('2 times');
    expect(dn[0].querySelector('[data-hf-part="story-state"]')!.textContent).toBe(WORDING['acct-story-review']);
    expect(dn[1].querySelector('[data-hf-part="title"]')!.hasAttribute('href')).toBe(false);
    expect(dn[1].querySelector('[data-hf-part="story"]')).toBeNull();
    // Cards with nothing in them stay hidden; the rest show.
    expect(d.getElementById('acct-saved')!.hasAttribute('data-hf-on')).toBe(false);
    expect(d.getElementById('acct-joined')!.hasAttribute('data-hf-on')).toBe(false);
    expect(d.getElementById('acct-invited')!.hasAttribute('data-hf-on')).toBe(true);
    expect(d.getElementById('acct-ripple')!.hasAttribute('data-hf-on')).toBe(true);
    expect(d.querySelector('[data-hf-fill="ripple-h"]')!.textContent).toBe('Your actions have reached 4 people');
    expect(d.querySelectorAll('[data-hf-slot="ripple"] svg').length).toBe(1);
    expect(d.getElementById('hfp-ripple')!.textContent).toBe('Your actions have led to 4 more.');
    // The designs themselves are untouched.
    expect(d.querySelectorAll('[data-hf-template]').length).toBe(5);
    // Fold: counts in the title, and the title opens and closes its card.
    expect(d.querySelector('#acct-pledges [data-hf-fill="fold-count"]')!.textContent).toBe('1 to keep');
    const fold = d.querySelector('#acct-actions [data-hf-act="fold"]') as unknown as { click: () => void };
    expect(d.getElementById('acct-actions')!.hasAttribute('data-hf-closed')).toBe(false);
    fold.click();
    expect(d.getElementById('acct-actions')!.hasAttribute('data-hf-closed')).toBe(true);
    fold.click();
    expect(d.getElementById('acct-actions')!.hasAttribute('data-hf-closed')).toBe(false);
    // Leaving an invite removes it and hides the empty card.
    (items('invited')[0].querySelector('[data-hf-act="leave"]') as unknown as { click: () => void }).click();
    await p.settle();
    expect(calls).toContain('DELETE /api/invites/abc/join');
    expect(items('invited').length).toBe(0);
    expect(d.getElementById('acct-invited')!.hasAttribute('data-hf-on')).toBe(false);
  });
});

describe('Keep your pledge', () => {
  const HTML = `<div id="hf-claim"><p data-hf-fill="claim-msg"></p><div data-hf-show="claim-out"><a data-hf-act="signup" href="/account">Create a free account</a><a data-hf-act="signin" href="/account">Sign in</a></div><div data-hf-show="claim-done"><a href="/actions">Find an action</a></div></div>`;
  const on = (d: Document, k: string) => d.querySelector(`[data-hf-show="${k}"]`)!.hasAttribute('data-hf-on');

  it('asks a signed-out visitor to create an account or sign in', async () => {
    const p = await page('/keep-your-pledge?c=ABC', HTML, () => undefined, { signedIn: false });
    expect(on(p.document as unknown as Document, 'claim-out')).toBe(true);
    expect(on(p.document as unknown as Document, 'claim-done')).toBe(false);
  });

  it('adds the pledge to the account and shows what to do next', async () => {
    const p = await page('/keep-your-pledge?c=ABC', HTML, (m, path) => (m === 'POST' && path === '/api/pledges/claim' ? { data: { claimed: 2 } } : undefined));
    expect(p.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/pledges/claim', body: { code: 'ABC' } }));
    expect(p.document.querySelector('[data-hf-fill="claim-msg"]')!.textContent).toContain('Your 2 pledges are in your account');
    expect(on(p.document as unknown as Document, 'claim-done')).toBe(true);
    expect(on(p.document as unknown as Document, 'claim-out')).toBe(false);
  });
});

describe('Gen Z touches', () => {
  it('the dare block shows how long is left', async () => {
    const end = new Date(Date.now() + 3 * 24 * 3600e3 + 3600e3).toISOString();
    const html = `<section id="hf-dare" data-hf-show="dare"><p data-hf-fill="dare-title">x</p><p data-hf-fill="dare-short">x</p><p data-hf-fill="dare-count">x</p><p data-hf-show="dare-ends" data-hf-fill="dare-ends">x</p><a id="hf-dare-link" href="/actions">Take the dare</a></section>`;
    const p = await page('/', html, (_m, path) => (path === '/api/dare' ? { data: { dare: { slug: 'x', title: 'X', shortAnswer: '', count: null, weekEnd: end } } } : undefined));
    const ends = p.document.querySelector('[data-hf-show="dare-ends"]')!;
    expect(ends.hasAttribute('data-hf-on')).toBe(true);
    expect(ends.textContent).toBe('Ends in 3 days');
  });

  it('the live line names no one: only who was made happy, where and when', async () => {
    const html = `<select id="hf-loc"><option value="">Everywhere</option><option value="copenhagen">Copenhagen</option></select><div data-hf-show="live"><span></span><p data-hf-fill="live-line">x</p></div>`;
    const at = new Date(Date.now() - 5 * 60e3).toISOString();
    const p = await page('/', html, (_m, path) => (path === '/api/activity' ? { data: { items: [{ at, who: 'stranger', place: 'copenhagen' }, { at, who: null, place: null }] } } : undefined));
    const box = p.document.querySelector('[data-hf-show="live"]')!;
    expect(box.hasAttribute('data-hf-on')).toBe(true);
    expect(box.textContent).toContain('Someone in Copenhagen made a stranger happy · 5 min ago');
  });

  it('the live line stays hidden when nothing happened lately', async () => {
    const html = `<div data-hf-show="live"><p data-hf-fill="live-line">x</p></div>`;
    const p = await page('/', html, (_m, path) => (path === '/api/activity' ? { data: { items: [] } } : undefined));
    expect(p.document.querySelector('[data-hf-show="live"]')!.hasAttribute('data-hf-on')).toBe(false);
  });
});

describe('Active membership card', () => {
  const HTML = `<a class="hf-nav-avatar"></a><div id="hf-acct-in" data-hf-show="signed-in"><p id="hf-tally"></p>
    <div class="hf-acct-card" id="acct-active" data-hf-show="active-card"><span data-hf-show="active-badge">Active member</span><p data-hf-fill="active-status">x</p>
    <ul data-hf-slot="active-weeks"><li data-hf-template="week" data-hf-show="template"><span data-hf-part="dot">✓</span><span data-hf-part="label">x</span></li></ul></div></div>`;
  const weeks = (done: boolean[]) => done.map((d, i) => ({ start: `2026-10-${12 + i * 7}`, done: d }));
  const ME = (active: Record<string, unknown>) => ({ data: { name: 'Tess', tally: 3, ripple: 0, pledges: [], done: [], stories: [], saved: [], joinedMyInvites: [], invitesIJoined: [], settings: {}, active } });

  it('shows the badge, five weeks and the ring on the avatar for an Active member', async () => {
    const p = await page('/account', HTML, (_m, path) => (path === '/api/me' ? ME({ active: true, weeks: weeks([true, true, false, true, true]), weeksDone: 4, needed: 4, thisWeekDone: true, toGo: 0 }) : undefined));
    (p.window as unknown as Record<string, unknown>).$memberstackDom = { getCurrentMember: async () => ({ data: {} }) };
    await p.settle();
    const d = p.document;
    expect(d.querySelector('[data-hf-show="active-badge"]')!.hasAttribute('data-hf-on')).toBe(true);
    expect(d.querySelector('[data-hf-fill="active-status"]')!.textContent).toContain('4 of the last 5 weeks');
    const lis = [...d.querySelectorAll('[data-hf-slot="active-weeks"] > li:not([data-hf-template])')];
    expect(lis.length).toBe(5);
    expect(lis.filter((l) => l.querySelector('[data-hf-part="dot"]')!.classList.contains('is-done')).length).toBe(4);
    expect(lis[4].textContent).toContain('This week');
  });

  it('says what one more week does, and never says "Inactive"', async () => {
    const p = await page('/account', HTML, (_m, path) => (path === '/api/me' ? ME({ active: false, weeks: weeks([false, true, true, true, false]), weeksDone: 3, needed: 4, thisWeekDone: false, toGo: 1 }) : undefined));
    (p.window as unknown as Record<string, unknown>).$memberstackDom = { getCurrentMember: async () => ({ data: {} }) };
    await p.settle();
    const d = p.document;
    expect(d.querySelector('[data-hf-show="active-badge"]')!.hasAttribute('data-hf-on')).toBe(false);
    const line = d.querySelector('[data-hf-fill="active-status"]')!.textContent!;
    expect(line).toBe('3 of 4 weeks done. One more week with an action makes you an Active member.');
    expect(d.body.textContent).not.toMatch(/inactive/i);
    expect(d.querySelectorAll('[data-hf-part="dot"].is-now').length).toBe(1);
  });
});
