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
  it('marks done, offers the share card, then "Done today" and undo', async () => {
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
    expect(btn.textContent).toBe('Done today');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(p.document.body.textContent).toContain('I made someone happy today');
    expect(p.document.getElementById('hf-did-msg')!.textContent).toBe('You have made 1 person happy.');
    btn.click();
    await p.settle();
    expect(p.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/done'))).toHaveLength(1);
    const undo = [...p.document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    undo.click();
    await p.settle();
    expect(btn.textContent).toBe('I did this');
  });

  it('asks a signed-out visitor to sign in and remembers the click', async () => {
    const p = await page('/action/cook-a-meal', ACTION_HTML, (_m, path) => (path.endsWith('/state') ? { data: { actionId: 'a1', stories: [] } } : undefined), { signedIn: false });
    p.document.getElementById('hf-did-this')!.click();
    await p.settle();
    const signIn = [...p.document.querySelectorAll('#hf-signup-prompt button')][0] as unknown as HTMLButtonElement;
    expect(signIn.textContent).toBe('Sign in');
    signIn.click();
    expect(p.signIns).toEqual([{ kind: 'done', actionId: 'a1' }]);
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
      if (m === 'GET' && path === '/api/invites/AbCdEfGh23') return { data: { kind: 'with_me', inviterName: 'Ana', action: { title: 'Cook a meal', shortAnswer: 'Cook for someone', slug: 'cook', live: true }, alternatives: [], me: { isMine: false, joined } } };
      if (m === 'POST') { joined = true; return { data: { joined: true } }; }
    });
    expect(p.document.getElementById('hf-join-title')!.textContent).toBe('Ana wants to do this with you');
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
