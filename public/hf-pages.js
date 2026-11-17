/*
 * Happiness Foundation: page features, loaded by /join/hf-backend.js on every
 * page. Each part runs only on the page whose elements it finds:
 *
 *   Action page      #hf-did-this        done, again, undo, save, invite, pass it on, stories
 *   Account          #hf-acct-in         tally, ripple, pledges, invites, stories, settings, data
 *   Suggest          #wf-form-Suggest-an-action   sends the idea to the backend
 *   Share your story #story-action       story form with photo, video and "with" line
 *   Do this with me  #hf-join-title      invite page ("I'm in", leave, own invite, removed action)
 *   Stories          /stories            stories with video players and "Report this story"
 *   Actions          /actions            "Most done" list
 *   Home             [data-hf-fill=impact-*]  live impact numbers
 *   Keep your pledge #hf-claim           a shop's pledges join the member's account
 *   Sign-in window   HFP.auth()          sign in, create an account, reset a password
 *
 * Webflow keeps the layout and text; this script only adds behaviour and data.
 */
(function () {
  'use strict';
  if (window.HFP) return;
  window.HFP = { version: '2.0.0' };

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function status(cls) { return el('p', { class: cls || 'hfp-status', role: 'status', 'aria-live': 'polite' }); }
  // Webflow's bot check keeps a form's submit button disabled until it passes. Our forms are sent by
  // these scripts to the backend (which checks the member), not to Webflow, so the button is released
  // and kept released.
  function freeSubmit(form) {
    var b = form && form.querySelector('[type=submit]');
    if (!b) return;
    function free() { if (b.disabled && !b.getAttribute('data-hfp-busy')) b.disabled = false; b.classList.remove('w-form-loading'); }
    free();
    if (window.MutationObserver) new MutationObserver(free).observe(b, { attributes: true, attributeFilter: ['disabled', 'class'] });
  }
  // Page content is in Webflow: [data-hf-show="x"] is shown once the script turns
  // it on (site.css hides it until then) and [data-hf-fill="x"] receives data.
  // Interface text comes from src/wording/en.json (window.HFW, via /join/hf-wording.js).
  function showOnly(root, key) {
    root.querySelectorAll('[data-hf-show]').forEach(function (e) {
      if ((' ' + e.getAttribute('data-hf-show') + ' ').indexOf(' ' + key + ' ') >= 0) e.setAttribute('data-hf-on', ''); else e.removeAttribute('data-hf-on');
    });
  }
  function turnOn(e) { if (e) e.setAttribute('data-hf-on', ''); return e; }
  function slot(root, key) { return root.querySelector('[data-hf-fill="' + key + '"]'); }
  function fillText(root, key, text) {
    var e = slot(root, key);
    if (!e) return null;
    if (text) e.textContent = text; else drop(e);
    return text ? e : null;
  }
  function copyText(key, vars) {
    var t = (window.HFW && window.HFW[key]) || '';
    if (vars) Object.keys(vars).forEach(function (k) { t = t.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k])); });
    return t;
  }
  /** Worded line with elements inside, e.g. "Kept with {action} on {date}": a list of nodes. */
  function copyNodes(key, parts) {
    var out = [];
    copyText(key).split(/(\{\w+\})/).forEach(function (bit) {
      var m = /^\{(\w+)\}$/.exec(bit);
      if (!m) { if (bit) out.push(document.createTextNode(bit)); return; }
      var v = parts[m[1]];
      if (v !== null && v !== undefined) out.push(typeof v === 'string' ? document.createTextNode(v) : v);
    });
    return out;
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function signedIn() { return !!(window.HF && HF.token && HF.token()); }
  function wait(test, ms) {
    return new Promise(function (r) { var t0 = Date.now(); (function c() { if (test()) return r(true); if (Date.now() - t0 > ms) return r(false); setTimeout(c, 50); })(); });
  }
  function slugFromPath() { return location.pathname.split('/').filter(Boolean).pop() || ''; }
  function msgOf(r, fallback) { return (r && r.data && r.data.message) || fallback || copyText('error-something'); }

  // A few styles for the parts this script adds; everything else uses the site's classes.
  var css = '.hfp-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:16px 0}' +
    '.hfp-status{margin:8px 0}.hfp-status[data-kind=error]{color:#A3122A}' +
    '.hfp-muted{color:#3D434C}.hfp-small{font-size:15px}.hfp-card{background:#EEF4FA;border-radius:24px;padding:24px;margin:16px 0}' +
    '.hfp-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}' +
    '.hfp-video{position:relative;width:100%;aspect-ratio:16/9;margin:0 0 12px;border-radius:16px;overflow:hidden;background:#E3E8EF}' +
    '.hfp-video.is-vertical{max-width:340px;aspect-ratio:9/16}.hfp-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}' +
    '.hfp-photo{display:block;width:100%;max-width:640px;border-radius:16px;margin:0 0 12px}' +
    '.hfp-list{list-style:none;padding:0;margin:8px 0 16px}.hfp-list li{padding:12px 0;border-bottom:1px solid #E3E8EF}' +
    '.hfp-field{margin:0 0 16px}.hfp-check{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px}.hfp-check input{margin-top:4px;width:22px;height:22px;flex:none;accent-color:#2E5E8E}' +
    '.hfp-check label{font-size:17px;font-weight:400;line-height:1.5;margin:0;cursor:pointer}' +
    '.hfp-pill{display:inline-block;font-size:14px;font-weight:600;padding:2px 12px;border-radius:999px;background:#EEF4FA;color:#2E5E8E;margin-left:8px}' +
    // Account lists: one tidy, tappable item per row, built for phones.
    '.hfp-list li.hfp-item{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px 0}.hfp-list li.hfp-item:last-child{border-bottom:0;padding-bottom:4px}' +
    '.hfp-item-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.hfp-item .hfp-pill{margin-left:0}.hfp-item .hfp-pill.is-open{background:#2E5E8E;color:#fff}' +
    '.hfp-item-title{font-size:18px;font-weight:600;line-height:1.35;color:#111418}a.hfp-item-title{color:#2E5E8E;text-decoration:none}a.hfp-item-title:hover{text-decoration:underline}' +
    '.hfp-item-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}' +
    '.hfp-chip-link{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:2px solid #CFE0F2;border-radius:999px;background:#fff;color:#2E5E8E;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer;font-family:inherit}.hfp-chip-link:hover{background:#2E5E8E;border-color:#2E5E8E;color:#fff}' +
    '[aria-disabled=true].hf-button,[aria-disabled=true].hf-button-light,button[disabled]{opacity:.55;cursor:default}';
  document.head.appendChild(el('style', { text: css }));

  // ---------------------------------------------------------------------------
  // Sharing: the phone's own share sheet, or copy the link on a computer.
  // ---------------------------------------------------------------------------
  async function share(data, note) {
    if (navigator.share) {
      try { await navigator.share(data); return true; } catch (e) { if (e && e.name === 'AbortError') return false; }
    }
    try {
      await navigator.clipboard.writeText(data.url);
      if (note) note.textContent = copyText('share-copied');
    } catch (e) {
      if (note) note.textContent = data.url;
    }
    return true;
  }

  /** Asks for a first name before the first share, then saves it. */
  function askName(where, done) {
    var box = el('form', { class: 'hfp-card' });
    var input = el('input', { class: 'hf-form-input w-input', id: 'hfp-name', autocomplete: 'given-name', maxlength: '40', required: true });
    var msg = status();
    box.appendChild(el('label', { for: 'hfp-name', class: 'hf-form-label', text: copyText('name-label') }));
    box.appendChild(input);
    box.appendChild(el('button', { type: 'submit', class: 'hf-button', text: copyText('name-save-share') }));
    box.appendChild(msg);
    box.addEventListener('submit', async function (e) {
      e.preventDefault();
      var r = await HFB.call('/api/me/settings', { method: 'PATCH', body: { firstName: input.value } });
      if (!r.ok) { msg.textContent = msgOf(r); msg.setAttribute('data-kind', 'error'); return; }
      box.remove();
      done();
    });
    where.insertAdjacentElement('afterend', box);
    input.focus();
  }

  /** A short personal note before sharing, then the share sheet. */
  function drop(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }

  function compose(actionId, kind, anchor, note) {
    drop($('hfp-compose'));
    var form = el('form', { id: 'hfp-compose', class: 'hfp-card' });
    var ta = el('textarea', { id: 'hfp-note', class: 'hf-form-input is-textarea w-input', maxlength: '280', rows: '3', 'aria-describedby': 'hfp-note-count',
      placeholder: copyText(kind === 'with_me' ? 'note-example-with' : 'note-example-pass') });
    var countEl = el('p', { id: 'hfp-note-count', class: 'hfp-muted hfp-small', text: copyText('note-left', { n: 280 }) });
    ta.addEventListener('input', function () { countEl.textContent = copyText('note-left', { n: 280 - ta.value.length }); });
    var go = el('button', { type: 'submit', class: 'hf-button', text: copyText(kind === 'with_me' ? 'note-share-invite' : 'note-share') });
    var cancel = el('button', { type: 'button', class: 'hf-button-light', text: copyText('note-cancel') });
    cancel.addEventListener('click', function () { drop(form); });
    form.appendChild(el('label', { for: 'hfp-note', class: 'hf-form-label', text: copyText('note-label') }));
    form.appendChild(ta);
    form.appendChild(countEl);
    form.appendChild(el('div', { class: 'hfp-row' }, [go, cancel]));
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      go.disabled = true;
      var ok = await invite(actionId, kind, form, note, ta.value);
      go.disabled = false;
      if (ok) drop(form);
    });
    anchor.insertAdjacentElement('afterend', form);
    ta.focus();
  }

  async function invite(actionId, kind, anchor, note, text) {
    var r = await HFB.call('/api/invites', { method: 'POST', body: { actionId: actionId, kind: kind, note: text || '' } });
    if (r.status === 409 && r.data && r.data.error === 'need_first_name') {
      askName(anchor, function () { invite(actionId, kind, anchor, note, text); });
      return false;
    }
    if (!r.ok) { note.textContent = msgOf(r); return false; }
    await share({ title: document.title, text: r.data.text, url: r.data.url }, note);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Stories (action page and /stories)
  // ---------------------------------------------------------------------------
  function reportLink(id) {
    var note = status('hfp-status hfp-small');
    var b = el('button', { type: 'button', class: 'hfp-link hfp-small hfp-muted', text: copyText('report') });
    b.addEventListener('click', async function () {
      var reason = window.prompt(copyText('report-ask'));
      if (reason === null) return;
      b.disabled = true;
      var r = await HFB.call('/api/stories/' + id + '/report', { method: 'POST', body: { reason: reason }, turnstile: true, auth: false });
      note.textContent = r.ok ? copyText('report-thanks') : msgOf(r);
      b.disabled = false;
    });
    return el('span', null, [b, note]);
  }

  function storyCard(s, withAction) {
    var kids = [];
    if (s.photo) kids.push(el('img', { class: 'hfp-photo', src: HFB.base + '/media/' + s.photo.key, alt: s.photo.description || copyText('story-photo-alt'), loading: 'lazy' }));
    if (s.video) {
      kids.push(el('div', { class: 'hfp-video' + (s.video.vertical ? ' is-vertical' : '') }, [
        el('iframe', { src: s.video.embed, title: copyText('story-video-title', { name: s.name || copyText('member-anon') }), loading: 'lazy', allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true }),
      ]));
    }
    if (s.text) kids.push(el('p', { class: 'hf-story-text', text: s.text }));
    var who = s.with && s.with.length
      ? copyText('story-by-with', { name: s.name || copyText('member-anon'), with: s.with.join(', '), date: day(s.createdAt) })
      : copyText('story-by', { name: s.name || copyText('member-anon'), date: day(s.createdAt) });
    kids.push(el('p', { class: 'hf-story-meta', text: who }));
    if (withAction && s.action && s.action.title) {
      kids.push(s.action.slug ? el('p', null, [el('a', { class: 'hf-story-link', href: '/action/' + s.action.slug, text: copyText('story-action-link', { title: s.action.title }) })]) : el('p', { class: 'hf-story-meta', text: copyText('story-action', { title: s.action.title }) }));
    }
    kids.push(reportLink(s.id));
    return el('article', { class: 'hf-story' }, kids);
  }

  // ---------------------------------------------------------------------------
  // Action page
  // ---------------------------------------------------------------------------
  async function actionPage() {
    var btn = $('hf-did-this');
    if (!btn || btn.getAttribute('data-hfp')) return;
    btn.setAttribute('data-hfp', '1');
    var slug = slugFromPath();
    var msg = $('hf-did-msg') || status();
    var prompt = $('hf-signup-prompt');
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    btn.setAttribute('role', 'button');

    var count = el('p', { class: 'hfp-muted', style: 'display:none;margin:20px 0 0;font-weight:500' });
    var row = el('div', { class: 'hfp-row' });
    btn.parentNode.insertBefore(count, btn);
    btn.parentNode.insertBefore(row, btn);
    row.appendChild(btn);
    var save = el('button', { type: 'button', class: 'hf-button-light', 'aria-pressed': 'false', text: copyText('action-save') });
    var withMe = el('button', { type: 'button', class: 'hf-button-light', style: 'display:none', text: copyText('action-with-me') });
    var story = el('a', { class: 'hf-button-light', style: 'display:none', href: '/share-your-story?action=' + encodeURIComponent(slug), text: copyText('story-share') });
    row.appendChild(save);
    row.appendChild(withMe);
    row.appendChild(story);
    var undo = el('button', { type: 'button', class: 'hfp-link hfp-small', style: 'display:none', text: copyText('action-undo') });
    msg.insertAdjacentElement('afterend', undo);
    var together = el('p', { class: 'hfp-muted', style: 'display:none' });
    undo.insertAdjacentElement('afterend', together);
    var shareNote = status();
    var shareLine = el('p', { class: 'hfp-muted hfp-small', style: 'display:none', text: copyText('action-invite-hint') });
    together.insertAdjacentElement('afterend', shareLine);
    shareLine.insertAdjacentElement('afterend', shareNote);
    var card = el('div', { class: 'hfp-card', style: 'display:none' });
    shareNote.insertAdjacentElement('afterend', card);
    var lead = document.querySelector('.hf-lead');
    var suggested = el('p', { class: 'hfp-muted hfp-small', style: 'display:none' });
    if (lead) lead.insertAdjacentElement('afterend', suggested);

    await wait(function () { return window.HFB && window.HF; }, 10000);
    var st = {};
    var id = null;

    function render() {
      var me = st.me;
      if (st.count) { count.textContent = copyText('action-count', { n: st.count.toLocaleString() }); count.style.display = ''; } else count.style.display = 'none';
      if (st.suggestedBy) { suggested.textContent = copyText('action-suggested', { name: st.suggestedBy }); suggested.style.display = ''; }
      withMe.style.display = st.canDoWithOthers ? '' : 'none';
      shareLine.style.display = st.canDoWithOthers ? '' : 'none';
      save.textContent = copyText(me && me.liked ? 'action-saved' : 'action-save');
      save.setAttribute('aria-pressed', me && me.liked ? 'true' : 'false');
      if (me && me.done) {
        btn.textContent = copyText('action-did-again');
        btn.setAttribute('aria-disabled', 'false');
        msg.textContent = copyText(me.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: me.tally });
        story.style.display = '';
        story.textContent = copyText(me.story ? 'story-edit' : 'story-share');
        undo.style.display = me.canUndo ? '' : 'none';
        if (me.doneWith && me.doneWith.length) { together.textContent = copyText('action-together', { names: me.doneWith.join(', ') }); together.style.display = ''; } else together.style.display = 'none';
      } else {
        btn.textContent = copyText('action-did');
        btn.setAttribute('aria-disabled', 'false');
        story.style.display = 'none';
        undo.style.display = 'none';
        together.style.display = 'none';
      }
    }

    function showCard(ripple) {
      card.innerHTML = '';
      card.appendChild(el('p', { class: 'hf-drop-label', text: copyText('action-card-label') }));
      card.appendChild(el('p', { class: 'hf-drop-statement', style: 'font-size:28px', text: copyText('action-card-headline') }));
      if (ripple > 0) card.appendChild(el('p', { text: copyText('ripple', { n: ripple }) }));
      var pass = el('button', { type: 'button', class: 'hf-button', text: copyText('action-pass') });
      pass.addEventListener('click', function () { compose(id, 'pass_it_on', card, shareNote); });
      card.appendChild(el('div', { class: 'hfp-row' }, [pass]));
      card.style.display = '';
    }

    async function load() {
      var r = await HFB.call('/api/actions/' + encodeURIComponent(slug) + '/state');
      if (!r.ok) return;
      st = r.data;
      id = st.actionId;
      render();
      renderStories(st.stories || []);
    }

    var storiesBox = null;
    function renderStories(list) {
      if (!list.length) { if (storiesBox) storiesBox.remove(); storiesBox = null; return; }
      if (!storiesBox) {
        storiesBox = el('section', { 'aria-labelledby': 'hfp-stories-h' });
        var section = btn.closest('section') || row.parentNode;
        section.insertAdjacentElement('afterend', storiesBox);
      }
      storiesBox.innerHTML = '';
      storiesBox.appendChild(el('h2', { id: 'hfp-stories-h', text: copyText('action-stories-h') }));
      list.forEach(function (s) { storiesBox.appendChild(storyCard(s, false)); });
    }

    // Signed out: straight to sign-in. The click is remembered and finished
    // after sign-in, back on this action.
    function ask(kind) {
      msg.textContent = copyText(kind === 'like' ? 'action-signin-save' : 'action-signin-done');
      HFB.requireSignIn({ kind: kind, actionId: id });
    }

    var busy = false;
    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      if (busy || !id || btn.getAttribute('aria-disabled') === 'true') return;
      if (!signedIn()) return ask('done');
      busy = true;
      btn.setAttribute('aria-busy', 'true');
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'POST' });
      busy = false;
      btn.removeAttribute('aria-busy');
      if (r.ok) {
        await load();
        showCard(r.data.ripple || 0);
      } else if (r.status === 401) ask('done');
      else msg.textContent = msgOf(r);
    });

    undo.addEventListener('click', async function () {
      if (!id) return;
      undo.disabled = true;
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'DELETE' });
      undo.disabled = false;
      if (r.ok) { card.style.display = 'none'; await load(); msg.textContent = copyText('action-undone', { message: msg.textContent }); }
      else msg.textContent = msgOf(r);
    });

    var lbusy = false;
    save.addEventListener('click', async function () {
      if (lbusy || !id) return;
      if (!signedIn()) return ask('like');
      lbusy = true;
      var want = !(st.me && st.me.liked);
      var r = await HFB.call('/api/actions/' + id + '/like', { method: 'PUT', body: { liked: want } });
      lbusy = false;
      if (r.ok) { st.me = Object.assign({}, st.me, { liked: want }); render(); }
      else if (r.status === 401) ask('like');
      else msg.textContent = msgOf(r);
    });

    withMe.addEventListener('click', function () {
      if (!id) return;
      if (!signedIn()) return HFB.requireSignIn({ kind: 'return', actionId: id });
      compose(id, 'with_me', withMe.parentNode, shareNote);
    });

    document.addEventListener('hfb:resumed', function () { load(); });
    await load();
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------
  // An extra account section, drawn as the same card as the Webflow ones.
  function section(title, kids) { return el('div', { class: 'hf-acct-card' }, [el('h2', { class: 'hf-acct-card-title', text: title })].concat(kids)); }

  // The account page shows at once: the site head marks a signed-in visitor (html.hf-in) so the
  // signed-in layout is there from the first paint; the last account data seen on this device
  // fills it straight away, and fresh data from the backend replaces it moments later. The saved
  // copy belongs to this sign-in only (keyed by the end of its token) and goes on sign-out.
  var ME_CACHE = 'hfp_me';
  var accountMe = null;
  function signInMark() { try { return (localStorage.getItem('_ms-mid') || '').slice(-16); } catch (e) { return ''; } }
  function cachedMe() {
    try {
      var c = JSON.parse(localStorage.getItem(ME_CACHE) || 'null');
      return c && c.mark && c.mark === signInMark() ? c.me : null;
    } catch (e) { return null; }
  }
  function cacheMe(me) { try { localStorage.setItem(ME_CACHE, JSON.stringify({ mark: signInMark(), me: me })); } catch (e) {} }
  function forgetMe() { try { localStorage.removeItem(ME_CACHE); } catch (e) {} }

  async function accountPage() {
    var inn = $('hf-acct-in');
    var out = $('hf-acct-out');
    if (!inn || inn.getAttribute('data-hfp')) return;
    inn.setAttribute('data-hfp', '1');
    var si = $('hf-signin');
    var so = $('hf-signout');
    function showIn() {
      if (out) out.style.display = 'none';
      inn.style.display = 'block';
      inn.setAttribute('data-hf-on', '1');
    }
    var early = cachedMe();
    if (early) { showIn(); renderAccount(early); }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (si) si.addEventListener('click', function (e) { e.preventDefault(); HF.signin(); });
    if (so) so.addEventListener('click', function (e) { e.preventDefault(); forgetMe(); HF.signout(); });
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }
    await wait(function () { return !!window.$memberstackDom; }, 5000);
    if (!signedIn()) {
      // Not signed in after all (an old sign-in): show the sign-in view.
      forgetMe();
      document.documentElement.classList.remove('hf-in');
      inn.removeAttribute('data-hf-on');
      inn.style.display = '';
      if (out) out.style.display = '';
      return;
    }
    var r = await HFB.call('/api/me');
    if (!r.ok) return;
    cacheMe(r.data);
    showIn();
    renderAccount(r.data);
  }

  function renderAccount(me) {
    var inn = $('hf-acct-in');
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || copyText('acct-there');
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var tally = $('hf-tally');
    var rippleText = me.ripple > 0 ? copyText('ripple', { n: me.ripple }) : copyText('acct-ripple-none');
    if ($('hfp-ripple')) $('hfp-ripple').textContent = rippleText;
    else if (tally) tally.insertAdjacentElement('afterend', el('p', { id: 'hfp-ripple', class: 'hfp-muted', text: rippleText }));
    // People who can open the Lab dashboard get a link to it (the card is in Webflow).
    if ($('hf-acct-lab') && me.lab) $('hf-acct-lab').setAttribute('data-hf-on', '1');

    // Pledges
    var pl = $('hf-pledges');
    if (pl) {
      pl.innerHTML = '';
      if (!me.pledges.length) pl.appendChild(el('p', { text: copyText('acct-pledges-none') }));
      else {
        var ul = el('ul', { class: 'hfp-list' });
        me.pledges.forEach(function (p) {
          var kept = p.status === 'kept';
          var li = el('li', { class: 'hfp-item' }, [el('div', { class: 'hfp-item-top' }, [
            el('span', { class: 'hfp-pill' + (kept ? '' : ' is-open'), text: copyText(kept ? 'acct-pledge-done' : 'acct-pledge-open') }),
            el('span', { class: 'hfp-muted hfp-small', text: copyText('acct-pledged', { date: day(p.orderedAt) }) }),
          ])]);
          if (kept) {
            var by = p.keptBySlug ? el('a', { href: '/action/' + p.keptBySlug, text: p.keptByTitle }) : p.keptByTitle || copyText('acct-pledge-an-action');
            var line = el('div');
            copyNodes('acct-pledge-kept', { action: by, date: day(p.keptOn) }).forEach(function (n) { line.appendChild(n); });
            li.appendChild(line);
          } else {
            li.appendChild(el('a', { class: 'hfp-chip-link', href: '/actions', text: copyText('acct-pledge-keep') }));
          }
          ul.appendChild(li);
        });
        pl.appendChild(ul);
      }
    }

    // Actions taken
    var ah = $('hf-actions');
    if (ah) {
      ah.innerHTML = '';
      if (!me.done.length) ah.appendChild(el('p', { text: copyText('acct-actions-none') }));
      else {
        var storyFor = {};
        me.stories.forEach(function (s) { storyFor[s.actionId] = s; });
        var seen = {};
        var list = el('ul', { class: 'hfp-list' });
        me.done.forEach(function (d) {
          if (seen[d.actionId]) return;
          seen[d.actionId] = 1;
          var times = me.done.filter(function (x) { return x.actionId === d.actionId; }).length;
          var live = d.slug && d.actionStatus === 'published';
          var li = el('li', { class: 'hfp-item' });
          li.appendChild(live ? el('a', { class: 'hfp-item-title', href: '/action/' + d.slug, text: d.title }) : el('span', { class: 'hfp-item-title', text: d.title }));
          li.appendChild(el('span', { class: 'hfp-muted hfp-small', text: day(d.doneAt) + (times > 1 ? ' · ' + copyText('acct-times', { n: times }) : '') }));
          var s = storyFor[d.actionId];
          var acts = el('div', { class: 'hfp-item-acts' });
          if (live) acts.appendChild(el('a', { class: 'hfp-chip-link hf-story-link', href: '/share-your-story?action=' + encodeURIComponent(d.slug), text: copyText(s ? 'story-edit' : 'story-share') }));
          if (s) acts.appendChild(el('span', { class: 'hfp-pill', text: copyText(s.status === 'approved' ? 'acct-story-approved' : s.status === 'rejected' ? 'acct-story-rejected' : 'acct-story-review') }));
          if (acts.firstChild) li.appendChild(acts);
          list.appendChild(li);
        });
        ah.appendChild(list);
      }
      // The actions list sits in its own card; extra sections go next to that card.
      var card = ah.closest('.hf-acct-card') || ah;
      var holder = card.parentNode;
      // Saved for later
      if ($('hfp-saved')) ($('hfp-saved').closest('.hf-acct-card') || $('hfp-saved')).remove();
      if ($('hfp-invites')) $('hfp-invites').remove();
      if (me.saved && me.saved.length) {
        var sv = el('ul', { class: 'hfp-list', id: 'hfp-saved' });
        me.saved.forEach(function (d) { sv.appendChild(el('li', { class: 'hfp-item' }, [el('a', { class: 'hfp-item-title', href: '/action/' + d.slug, text: d.title })])); });
        holder.insertBefore(section(copyText('acct-saved-h'), [sv]), card === ah ? ah.previousElementSibling : card);
      }
      // Invites
      {
        var inv = el('div', { id: 'hfp-invites' });
        if (me.joinedMyInvites.length) {
          var j = el('ul', { class: 'hfp-list' });
          me.joinedMyInvites.forEach(function (x) { j.appendChild(el('li', { class: 'hfp-item', text: copyText('acct-joined', { name: x.name || copyText('acct-someone'), action: x.actionTitle || '', date: day(x.joinedAt) }) })); });
          inv.appendChild(section(copyText('acct-joined-h'), [j]));
        }
        if (me.invitesIJoined.length) {
          var k = el('ul', { class: 'hfp-list' });
          me.invitesIJoined.forEach(function (x) {
            var leave = el('button', { type: 'button', class: 'hfp-chip-link', text: copyText('acct-leave') });
            var li = el('li', { class: 'hfp-item' }, [
              x.actionSlug ? el('a', { class: 'hfp-item-title', href: '/action/' + x.actionSlug, text: x.actionTitle }) : el('span', { class: 'hfp-item-title', text: x.actionTitle || '' }),
              el('span', { class: 'hfp-muted hfp-small', text: copyText('acct-invited', { name: x.inviterName || copyText('acct-someone') }) }),
              leave,
            ]);
            leave.addEventListener('click', async function () {
              var rr = await HFB.call('/api/invites/' + encodeURIComponent(x.code) + '/join', { method: 'DELETE' });
              if (rr.ok) li.remove();
            });
            k.appendChild(li);
          });
          inv.appendChild(section(copyText('acct-invited-h'), [k]));
        }
        if (card !== ah) holder.insertBefore(inv, card.nextElementSibling);
        else ah.nextElementSibling ? holder.insertBefore(inv, ah.nextElementSibling.nextElementSibling) : holder.appendChild(inv);
      }
    }

    // Settings and your data: the section, form and boxes are built in Webflow (#hfp-settings);
    // this fills them in and saves each change.
    accountMe = me;
    var setBox = $('hfp-settings');
    var nameNow = $('hfp-share-name');
    if (nameNow && document.activeElement !== nameNow) nameNow.value = me.name || '';
    ['invite_summary', 'story_approved', 'suggestion_live', 'pledge_reminder'].forEach(function (kind) {
      var cb = $('hfp-n-' + kind);
      if (cb) cb.checked = me.settings && me.settings[kind] ? true : false;
    });
    if (setBox && !setBox.getAttribute('data-hfp')) {
      setBox.setAttribute('data-hfp', '1');
      var setForm = $('hf-settings-form');
      var setMsg = $('hfp-settings-msg') || status();
      var nameIn = $('hfp-share-name');
      if (nameIn) nameIn.value = me.name || '';
      if (setForm) {
        freeSubmit(setForm);
        setForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: { firstName: nameIn ? nameIn.value : '' } });
          setMsg.textContent = rr.ok ? copyText('saved') : msgOf(rr);
        }, true);
      }
      ['invite_summary', 'story_approved', 'suggestion_live', 'pledge_reminder'].forEach(function (kind) {
        var cb = $('hfp-n-' + kind);
        if (!cb) return;
        cb.checked = me.settings && me.settings[kind] ? true : false;
        cb.addEventListener('change', async function () {
          var body = { notifications: {} };
          body.notifications[kind] = cb.checked;
          var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: body });
          setMsg.textContent = rr.ok ? copyText('saved') : msgOf(rr);
          if (!rr.ok) cb.checked = !cb.checked;
        });
      });
      var delMsg = $('hfp-data-msg') || setMsg;
      var dl = $('hfp-download');
      if (dl) dl.addEventListener('click', function (e) {
        e.preventDefault();
        var blob = new Blob([JSON.stringify(accountMe, null, 2)], { type: 'application/json' });
        var a = el('a', { href: URL.createObjectURL(blob), download: 'happiness-foundation-my-data.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      var del = $('hfp-delete');
      if (del) del.addEventListener('click', async function (e) {
        e.preventDefault();
        if (!window.confirm(copyText('acct-delete-confirm'))) return;
        var rr = await HFB.call('/api/me', { method: 'DELETE' });
        delMsg.textContent = rr.ok ? copyText('acct-deleted') : msgOf(rr);
        if (rr.ok) { forgetMe(); setTimeout(function () { HF.signout(); }, 2500); }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Suggest an action: the form is a Webflow form (#wf-form-Suggest-an-action);
  // this sends the idea to the backend instead of Webflow and shows Webflow's
  // own thank-you or error block.
  // ---------------------------------------------------------------------------
  async function suggestPage() {
    var f = $('wf-form-Suggest-an-action');
    if (!f || f.getAttribute('data-hfp')) return;
    f.setAttribute('data-hfp', '1');
    var wrap = f.closest('.w-form') || f.parentNode;
    var done = wrap.querySelector('.w-form-done');
    var fail = wrap.querySelector('.w-form-fail');
    var ta = f.querySelector('textarea');
    // Name and email come from the account; older versions of the form had fields for them.
    ['name', 'email'].forEach(function (n) {
      var i = f.querySelector('#' + n);
      if (i) { i.required = false; i.style.display = 'none'; var l = f.querySelector('label[for="' + n + '"]'); if (l) l.style.display = 'none'; }
    });
    var msg = status();
    f.appendChild(msg);
    freeSubmit(f);
    var draft = HFB.keepDraft(f);
    function finished() {
      draft.clear();
      f.style.display = 'none';
      if (fail) fail.style.display = 'none';
      if (done) { done.style.display = 'block'; done.setAttribute('role', 'status'); }
      else wrap.appendChild(el('p', { class: 'hfp-card', role: 'status', text: copyText('sug-thanks') }));
    }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (!signedIn()) f.insertBefore(el('p', { class: 'hfp-muted', text: copyText('sug-signin') }), f.firstChild);
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (fail) fail.style.display = 'none';
      var text = (ta && ta.value || '').trim();
      if (text.length < 3) { msg.textContent = copyText('sug-empty'); msg.setAttribute('data-kind', 'error'); ta && ta.focus(); return; }
      if (!signedIn()) return HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      var submit = f.querySelector('[type=submit]');
      if (submit) { submit.setAttribute('data-hfp-busy', '1'); submit.disabled = true; }
      var r = await HFB.call('/api/suggestions', { method: 'POST', body: { text: text } });
      if (submit) { submit.removeAttribute('data-hfp-busy'); submit.disabled = false; }
      if (r.ok) finished();
      else if (r.status === 401) HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      else { msg.textContent = msgOf(r); msg.setAttribute('data-kind', 'error'); if (fail) fail.style.display = 'block'; }
    }, true);
    document.addEventListener('hfb:resumed', function (ev) {
      if (ev.detail && ev.detail.kind === 'suggestion' && ev.detail.completed) finished();
    });
  }

  // ---------------------------------------------------------------------------
  // Share your story
  // ---------------------------------------------------------------------------
  function resizeToJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600;
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('convert')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('read')); };
      img.src = url;
    });
  }

  async function storyPage() {
    // The form and its fields are built in Webflow (#hf-story-form, hidden until the
    // member may share); this checks the member, fills it in and sends it to the backend.
    var form = $('hf-story-form');
    var note = $('hf-story-note');
    if (!form || form.getAttribute('data-hfp')) return;
    form.setAttribute('data-hfp', '1');
    freeSubmit(form);
    var wrap = form.closest('.w-form') || form.parentNode;
    var shown = form.closest('[data-hf-show]') || wrap;
    var done = wrap.querySelector('.w-form-done');
    var fail = wrap.querySelector('.w-form-fail');
    if (!note) { note = status(); shown.insertAdjacentElement('beforebegin', note); }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }
    var slug = new URLSearchParams(location.search).get('action') || '';
    var back = location.pathname + location.search;
    function sayLink(text, label, href, fn) {
      note.innerHTML = '';
      note.appendChild(document.createTextNode(text + ' '));
      var a = el('a', { class: 'hf-button', href: href, text: label });
      if (fn) a.addEventListener('click', function (e) { e.preventDefault(); fn(); });
      note.appendChild(el('span', { class: 'hfp-row' }, [a]));
    }
    if (!slug) return sayLink(copyText('st-no-action'), copyText('st-account'), '/account');
    if (!signedIn()) return sayLink(copyText('st-signin'), copyText('st-signin-button'), '/account', function () { HFB.requireSignIn({ kind: 'return', returnTo: back }); });
    var r = await HFB.call('/api/stories/mine?action=' + encodeURIComponent(slug));
    if (!r.ok) return sayLink(msgOf(r), copyText('st-account'), '/account');
    var mine = r.data;
    if (!mine.done) return sayLink(copyText('st-not-done'), copyText('st-go-action'), '/action/' + slug);
    var title = slug.replace(/-/g, ' ');
    try {
      var h = await fetch('/action/' + slug).then(function (x) { return x.ok ? x.text() : ''; });
      var t = new DOMParser().parseFromString(h, 'text/html').querySelector('h1');
      if (t && t.textContent.trim()) title = t.textContent.trim();
    } catch (e) {}
    var s = mine.story || {};
    var msg = status();
    if ($('hf-story-title')) $('hf-story-title').textContent = title;
    if ($('hf-story-status') && mine.story) $('hf-story-status').textContent = copyText(mine.story.status === 'approved' ? 'st-on-site' : 'st-in-review');
    var text = $('hfp-story-text');
    var photo = $('hfp-photo');
    var desc = $('hfp-photo-desc');
    var video = $('hfp-video');
    var showName = $('hfp-show-name');
    var consent = $('hfp-consent');
    var submit = form.querySelector('[type=submit]');
    if (text) text.value = s.text || '';
    if (desc) desc.value = s.photoDescription || '';
    if (video) video.value = s.videoUrl || '';
    if (showName) {
      showName.checked = s.showName === false ? false : true;
      var snl = showName.parentNode && showName.parentNode.querySelector('label, .w-form-label');
      if (snl && mine.name) snl.textContent = copyText('st-show-name-named', { name: mine.name });
    }
    if (submit && mine.story) { if ('value' in submit && submit.tagName === 'INPUT') submit.value = copyText('st-save'); else submit.textContent = copyText('st-save'); }

    // Photo: upload straight to the backend, show a preview.
    var photoKey = s.photoKey || null;
    var area = $('hfp-photo-area') || (photo && photo.parentNode);
    var photoMsg = status('hfp-status hfp-small');
    var preview = el('img', { class: 'hfp-photo', alt: '', style: photoKey ? '' : 'display:none', src: photoKey ? HFB.base + '/media/' + photoKey : undefined });
    var removePhoto = el('button', { type: 'button', class: 'hfp-link hfp-small', style: photoKey ? '' : 'display:none', text: copyText('st-remove-photo') });
    if (area) { area.appendChild(photoMsg); area.appendChild(preview); area.appendChild(removePhoto); }
    if (photo) photo.addEventListener('change', async function () {
      var file = photo.files && photo.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { photoMsg.textContent = copyText('st-too-big'); return; }
      photoMsg.textContent = copyText('st-preparing');
      var blob;
      try { blob = await resizeToJpeg(file); } catch (e) {
        photoMsg.textContent = copyText('st-unreadable');
        return;
      }
      var tok = await HFB.token();
      var res = await fetch(HFB.base + '/api/stories/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg' }, body: blob });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) { photoMsg.textContent = (data && data.message) || copyText('st-upload-failed'); return; }
      photoKey = data.photoKey;
      preview.src = URL.createObjectURL(blob);
      preview.style.display = '';
      removePhoto.style.display = '';
      photoMsg.textContent = copyText('st-photo-added');
    });
    removePhoto.addEventListener('click', function () { photoKey = null; preview.style.display = 'none'; removePhoto.style.display = 'none'; if (photo) photo.value = ''; photoMsg.textContent = copyText('st-photo-removed'); });

    // People the member did the action with (from their account).
    var withBoxes = [];
    var withHolder = $('hfp-with');
    if (withHolder && mine.withCandidates && mine.withCandidates.length) {
      var fs = el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0' }, [el('legend', { class: 'hf-form-label', text: copyText('st-with') })]);
      mine.withCandidates.forEach(function (c) {
        var cb = el('input', { type: 'checkbox', id: 'hfp-with-' + c.id, value: String(c.id), checked: (s.withMemberIds || []).indexOf(c.id) >= 0 });
        withBoxes.push(cb);
        fs.appendChild(el('div', { class: 'hfp-check' }, [cb, el('label', { for: 'hfp-with-' + c.id, text: c.name })]));
      });
      withHolder.appendChild(fs);
    }
    if (submit) submit.insertAdjacentElement('afterend', msg); else form.appendChild(msg);
    if (mine.story) {
      var del = el('button', { type: 'button', class: 'hfp-link hfp-small', text: copyText('st-delete') });
      del.addEventListener('click', async function () {
        if (!window.confirm(copyText('st-delete-confirm'))) return;
        var rr = await HFB.call('/api/stories/' + mine.story.id, { method: 'DELETE' });
        if (rr.ok) { form.style.display = 'none'; shown.insertAdjacentElement('beforebegin', el('p', { role: 'status', text: copyText('st-deleted') })); }
        else msg.textContent = msgOf(rr);
      });
      form.appendChild(el('p', null, [del]));
    }
    var draftKey = 'hfb_story:' + slug;
    if (text) {
      try { var d = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (d && !text.value) text.value = d.text || ''; } catch (e) {}
      text.addEventListener('input', function () { try { localStorage.setItem(draftKey, JSON.stringify({ text: text.value })); } catch (e) {} });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      msg.removeAttribute('data-kind');
      if (fail) fail.style.display = 'none';
      if (!consent || !consent.checked) { msg.textContent = copyText('st-need-consent'); msg.setAttribute('data-kind', 'error'); consent && consent.focus(); return; }
      var words = text ? text.value : '';
      var link = video ? video.value : '';
      if (!words.trim() && !photoKey && !link.trim()) { msg.textContent = copyText('st-empty'); msg.setAttribute('data-kind', 'error'); text && text.focus(); return; }
      if (submit) { submit.setAttribute('data-hfp-busy', '1'); submit.disabled = true; }
      var body = {
        actionId: slug,
        text: words,
        photoKey: photoKey,
        photoDescription: desc ? desc.value : '',
        videoUrl: link,
        showName: showName ? showName.checked : true,
        consent: true,
        withMemberIds: withBoxes.filter(function (b) { return b.checked; }).map(function (b) { return Number(b.value); }),
      };
      var rr = await HFB.call('/api/stories', { method: 'POST', body: body });
      if (submit) { submit.removeAttribute('data-hfp-busy'); submit.disabled = false; }
      if (rr.ok) {
        try { localStorage.removeItem(draftKey); } catch (e2) {}
        form.style.display = 'none';
        if (done) {
          done.style.display = 'block';
          done.setAttribute('role', 'status');
          done.appendChild(el('p', null, [el('a', { class: 'hf-button-light', href: '/action/' + slug, text: copyText('st-back') })]));
        } else shown.insertAdjacentElement('beforebegin', el('p', { class: 'hfp-card', role: 'status', text: copyText('st-thanks') }));
      } else if (rr.status === 401) {
        HFB.requireSignIn({ kind: 'return', returnTo: back });
      } else { msg.textContent = msgOf(rr); msg.setAttribute('data-kind', 'error'); if (fail) fail.style.display = 'block'; }
    }, true);
    note.innerHTML = '';
    shown.setAttribute('data-hf-on', '1');
  }

  // ---------------------------------------------------------------------------
  // Do this with me (invite page)
  // ---------------------------------------------------------------------------
  async function invitePage() {
    var titleEl = $('hf-join-title');
    if (!titleEl || titleEl.getAttribute('data-hfp')) return;
    var code = new URLSearchParams(location.search).get('i');
    if (!code) return; // older links (?action=...) keep the page's own behaviour
    titleEl.setAttribute('data-hfp', '1');
    var actionEl = $('hf-join-action');
    var descEl = $('hf-join-desc');
    var inBtn = $('hf-join-in');
    var noteEl = $('hf-join-note') || status();
    noteEl.setAttribute('role', 'status');
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }

    async function render() {
      var r = await HFB.call('/api/invites/' + encodeURIComponent(code));
      if (!r.ok) { titleEl.textContent = copyText('inv-invalid-h'); actionEl.textContent = copyText('inv-invalid'); descEl.textContent = ''; inBtn.textContent = copyText('inv-find'); inBtn.href = '/actions'; return; }
      var v = r.data;
      var who = v.inviterName || copyText('inv-someone');
      if (!v.action.live) {
        titleEl.textContent = copyText('inv-gone-h');
        actionEl.textContent = v.action.title ? copyText('inv-gone', { title: v.action.title }) : '';
        descEl.textContent = copyText('inv-others');
        inBtn.style.display = 'none';
        var ul = el('ul', { class: 'hfp-list' });
        v.alternatives.forEach(function (a) { ul.appendChild(el('li', null, [el('a', { href: '/action/' + a.slug, text: a.title })])); });
        descEl.insertAdjacentElement('afterend', ul);
        return;
      }
      actionEl.textContent = v.action.title;
      descEl.textContent = v.action.shortAnswer;
      var link = el('a', { class: 'hf-button-light', href: '/action/' + v.action.slug, text: copyText('inv-see') });
      if (v.me && v.me.isMine) {
        titleEl.textContent = copyText('inv-mine-h');
        inBtn.textContent = copyText('inv-share');
        inBtn.onclick = function (e) {
          e.preventDefault();
          share({ title: document.title, text: copyText(v.kind === 'with_me' ? 'inv-share-with' : 'inv-share-pass', { name: who, title: v.action.title }), url: location.origin + HFB.base + '/' + code }, noteEl);
        };
        return;
      }
      titleEl.textContent = copyText(v.kind === 'with_me' ? 'inv-with-h' : 'inv-pass-h', { name: who });
      var noteBox = $('hfp-invite-note');
      if (v.note && !noteBox) titleEl.insertAdjacentElement('afterend', el('blockquote', { id: 'hfp-invite-note', class: 'hf-lead', style: 'margin:0 0 16px;padding-left:16px;border-left:3px solid #222', text: copyText('inv-note', { note: v.note, name: who }) }));
      if (v.me && v.me.joined) {
        inBtn.textContent = copyText('inv-in');
        inBtn.setAttribute('aria-disabled', 'true');
        inBtn.onclick = function (e) { e.preventDefault(); };
        noteEl.innerHTML = '';
        noteEl.appendChild(document.createTextNode(copyText('inv-joined', { name: who }) + ' '));
        var leave = el('button', { type: 'button', class: 'hfp-link', text: copyText('inv-leave') });
        leave.addEventListener('click', async function () {
          var lr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'DELETE' });
          if (lr.ok) render();
        });
        noteEl.appendChild(leave);
        if (!$('hfp-see-action')) { link.id = 'hfp-see-action'; inBtn.parentNode.appendChild(document.createTextNode(' ')); inBtn.parentNode.appendChild(link); }
        return;
      }
      inBtn.textContent = copyText('inv-join');
      inBtn.removeAttribute('aria-disabled');
      noteEl.textContent = '';
      inBtn.onclick = async function (e) {
        e.preventDefault();
        if (!signedIn()) return HFB.requireSignIn({ kind: 'join', inviteCode: code, returnTo: location.pathname + location.search });
        var jr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'POST' });
        if (jr.ok || (jr.data && jr.data.error === 'own_invite')) render();
        else noteEl.textContent = msgOf(jr);
      };
    }
    document.addEventListener('hfb:resumed', function () { render(); });
    await render();
  }

  // ---------------------------------------------------------------------------
  // Stories page: newest first, 20 at a time, with players and report links
  // ---------------------------------------------------------------------------
  async function storiesPage() {
    if (location.pathname !== '/stories') return;
    var native = document.querySelector('.w-dyn-list');
    await wait(function () { return window.HFB; }, 10000);
    var r = await HFB.call('/api/stories?page=1', { auth: false });
    if (!r.ok || !r.data.stories.length) return;
    var box = el('div', { id: 'hfp-stories' });
    var more = el('button', { type: 'button', class: 'hf-button-light', text: copyText('stories-more') });
    var page = 1;
    function add(list) { list.forEach(function (s) { box.appendChild(storyCard(s, true)); }); more.style.display = list.length === 20 ? '' : 'none'; }
    add(r.data.stories);
    more.addEventListener('click', async function () {
      page++;
      var rr = await HFB.call('/api/stories?page=' + page, { auth: false });
      if (rr.ok) add(rr.data.stories);
    });
    if (native) { native.parentNode.insertBefore(box, native); native.style.display = 'none'; }
    else document.querySelector('h1').insertAdjacentElement('afterend', box);
    box.insertAdjacentElement('afterend', el('div', { class: 'hfp-row' }, [more]));
  }

  // Stories template page (/stories/story-12): report link.
  function storyItemPage() {
    var m = /^\/stories\/story-(\d+)$/.exec(location.pathname);
    if (!m || $('hfp-report')) return;
    var target = document.querySelector('.hf-story') || document.querySelector('h1');
    if (target) { var r = reportLink(m[1]); r.id = 'hfp-report'; target.appendChild(r); }
  }

  // ---------------------------------------------------------------------------
  // /actions: "Most done"
  // ---------------------------------------------------------------------------
  async function mostDone() {
    if (location.pathname !== '/actions' || $('hfp-most-done')) return;
    await wait(function () { return window.HFB; }, 10000);
    var r = await HFB.call('/api/most-done', { auth: false });
    if (!r.ok || !r.data.actions.length) return;
    var ol = el('ol', { class: 'hfp-list' });
    r.data.actions.slice(0, 10).forEach(function (a) {
      ol.appendChild(el('li', null, [el('a', { href: '/action/' + a.slug, text: a.title }), el('span', { class: 'hfp-muted', text: ' · ' + copyText('most-done-people', { n: a.people.toLocaleString() }) })]));
    });
    var box = el('section', { id: 'hfp-most-done', 'aria-labelledby': 'hfp-most-done-h' }, [el('h2', { id: 'hfp-most-done-h', text: copyText('most-done-h') }), ol]);
    var footer = document.querySelector('footer');
    footer ? footer.parentNode.insertBefore(box, footer) : document.body.appendChild(box);
  }


  // Header button (Webflow element with class hf-nav-cta, linking to /account):
  // "Join free" opens the create-account window for visitors; members see
  // "My account". Worded in src/wording/en.json (nav-join, nav-account).
  function headerAccount() {
    var b = document.querySelector('.hf-nav-cta');
    if (!b || b.getAttribute('data-hfp-cta')) return;
    b.setAttribute('data-hfp-cta', '1');
    if (signedIn()) { b.textContent = copyText('nav-account'); return; }
    b.textContent = copyText('nav-join');
    // Visitors who already have an account: the "Sign in" link built in Webflow (data-hf-show="signed-out").
    document.querySelectorAll('.hf-nav-signin').forEach(function (si) {
      si.setAttribute('data-hf-on', '1');
      si.addEventListener('click', function (e) {
        if (!window.HFP || !window.HFP.auth || signedIn()) return;
        e.preventDefault();
        window.HFP.auth('signin');
      });
    });
    b.addEventListener('click', function (e) {
      if (!window.HFP || !window.HFP.auth || signedIn()) return;
      e.preventDefault();
      window.HFP.auth('signup');
    });
  }

  // Home page impact numbers: Webflow elements with data-hf-fill="impact-people",
  // "impact-actions" or "impact-stories" get the live count (they keep their
  // Webflow text until it arrives, and keep it if the backend can't answer).
  // A count of zero hides its item.
  async function impactNumbers() {
    var slots = document.querySelectorAll('[data-hf-fill^="impact-"]');
    if (!slots.length) return;
    await wait(function () { return window.HFB; }, 10000);
    var r = await HFB.call('/api/impact', { auth: false });
    if (!r.ok) return;
    var map = { 'impact-people': r.data.peopleMadeHappy, 'impact-actions': r.data.actions, 'impact-stories': r.data.stories };
    slots.forEach(function (e) {
      var v = map[e.getAttribute('data-hf-fill')];
      if (typeof v !== 'number') return;
      // A zero says nothing yet: its whole item stays out until there is something to count.
      if (v === 0 && e.parentNode) { e.parentNode.hidden = true; return; }
      e.textContent = v.toLocaleString();
    });
  }

  // ---------------------------------------------------------------------------
  // Small site-wide helpers that used to sit in Webflow's site footer
  // ---------------------------------------------------------------------------

  /** An empty CMS list hides itself and the heading right before it. */
  function emptyLists() {
    document.querySelectorAll('.w-dyn-empty').forEach(function (e) {
      var w = e.closest('.w-dyn-list');
      if (!w) return;
      var h = w.previousElementSibling;
      w.style.display = 'none';
      if (h && /^H[1-6]$/.test(h.tagName)) h.style.display = 'none';
    });
  }

  /** /actions-by-time/1-hour also lists the quicker actions (and likewise for cost). */
  function shorterAlsoFits() {
    var m = location.pathname.match(/^\/(actions-by-time|actions-by-cost)\/([^\/]+)/);
    if (!m) return;
    var steps = {
      'actions-by-time': ['1-minute', '5-minutes', '15-minutes', '30-minutes', '1-hour', '2-hours', 'half-a-day', '1-day', '1-week'],
      'actions-by-cost': ['free', 'up-to-5', 'up-to-10', 'up-to-50', 'up-to-100', 'up-to-500', 'up-to-1000', 'up-to-5000'],
    }[m[1]];
    var i = steps.indexOf(m[2]);
    if (i < 1) return;
    var wrap = document.querySelector('.w-dyn-list');
    if (!wrap) return;
    var list = wrap.querySelector('.w-dyn-items');
    if (!list) {
      list = el('div', { class: 'w-dyn-items' });
      wrap.appendChild(list);
      var empty = wrap.querySelector('.w-dyn-empty');
      if (empty) empty.style.display = 'none';
    }
    wrap.style.display = '';
    var seen = {};
    list.querySelectorAll('a').forEach(function (a) { seen[a.getAttribute('href')] = 1; });
    steps.slice(0, i).reverse().forEach(function (s) {
      fetch('/' + m[1] + '/' + s).then(function (r) { return r.text(); }).then(function (h) {
        var d = new DOMParser().parseFromString(h, 'text/html');
        d.querySelectorAll('.w-dyn-items > .w-dyn-item').forEach(function (it) {
          var a = it.querySelector('a');
          if (!a || seen[a.getAttribute('href')]) return;
          seen[a.getAttribute('href')] = 1;
          list.appendChild(document.importNode(it, true));
        });
      });
    });
  }

  /** The location picker remembers its choice. */
  function rememberLocation() {
    var s = $('hf-loc');
    if (!s || s.getAttribute('data-hfp')) return;
    s.setAttribute('data-hfp', '1');
    try { s.value = localStorage.getItem('hf_loc') || ''; } catch (e) {}
    s.addEventListener('change', function () {
      try { localStorage.setItem('hf_loc', s.value); } catch (e) {}
      window.dispatchEvent(new Event('hf-loc'));
    });
  }


  // ---------------------------------------------------------------------------
  // /keep-your-pledge?c=...: the buyer adds a shop's pledges to their account
  // ---------------------------------------------------------------------------
  async function claimPage() {
    var box = $('hf-claim');
    if (!box || box.getAttribute('data-hfp')) return;
    box.setAttribute('data-hfp', '1');
    // The code survives signing up or in (the page reloads, possibly without it).
    var code = new URLSearchParams(location.search).get('c');
    try { if (code) localStorage.setItem('hf_claim', code); else code = localStorage.getItem('hf_claim'); } catch (e) {}
    var msg = status();
    box.appendChild(msg);
    if (!code) { msg.textContent = copyText('claim-invalid'); return; }
    if (!signedIn()) {
      var join = el('button', { type: 'button', class: 'hf-button', text: copyText('claim-signup') });
      var login = el('button', { type: 'button', class: 'hf-button-light', text: copyText('claim-signin') });
      join.addEventListener('click', function () { HF.signup ? HF.signup() : HF.signin(); });
      login.addEventListener('click', function () { HF.signin(); });
      box.appendChild(el('div', { class: 'hfp-row' }, [join, login]));
      return;
    }
    msg.textContent = copyText('claim-working');
    var r = await HFB.call('/api/pledges/claim', { method: 'POST', body: { code: code } });
    if (!r.ok) { msg.textContent = msgOf(r); msg.setAttribute('data-kind', 'error'); return; }
    try { localStorage.removeItem('hf_claim'); } catch (e) {}
    msg.textContent = r.data.claimed === 1 ? copyText('claim-done-one') : copyText('claim-done-many', { n: r.data.claimed });
    box.appendChild(el('div', { class: 'hfp-row' }, [
      el('a', { class: 'hf-button', href: '/actions', text: copyText('claim-find') }),
      el('a', { class: 'hf-button-light', href: '/account', text: copyText('claim-account') }),
    ]));
  }

  // Sign-in window: our own look and wording, with Memberstack doing the work
  // behind it (no Memberstack window or logo). Modes: signin, signup, reset.
  var AUTH_CSS = '#hfp-auth{border:0;border-radius:28px;padding:32px 28px 26px;width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;color:#111418;font-family:inherit;box-shadow:0 24px 60px rgba(17,20,24,.25)}' +
    '#hfp-auth::backdrop{background:rgba(17,20,24,.55)}#hfp-auth h2{font-family:"Inter Tight",Inter,Arial,sans-serif;font-weight:800;font-size:30px;letter-spacing:-.02em;margin:14px 0 18px;text-align:center}' +
    '#hfp-auth .hfp-auth-logo{display:block;height:34px;width:auto;margin:0 auto}#hfp-auth label{display:block;font-size:16px;font-weight:600;margin:14px 0 6px}' +
    '#hfp-auth input{display:block;width:100%;box-sizing:border-box;min-height:52px;padding:10px 16px;border:2px solid #C9D6E5;border-radius:14px;font:inherit;font-size:17px;color:#111418;background:#fff}' +
    '#hfp-auth input:focus{border-color:#2E5E8E;outline:3px solid rgba(102,153,204,.35);outline-offset:1px}#hfp-auth .hfp-auth-go,#hfp-auth .hfp-auth-google{display:flex;gap:10px;justify-content:center;align-items:center;width:100%;min-height:54px;margin:20px 0 0;border-radius:999px;font:inherit;font-size:18px;font-weight:700;cursor:pointer}' +
    '#hfp-auth .hfp-auth-go{background:#2E5E8E;border:0;color:#fff}#hfp-auth .hfp-auth-go:hover{background:#1F4468}' +
    '#hfp-auth .hfp-auth-google{background:#fff;border:2px solid #111418;color:#111418;margin-top:0;margin-bottom:10px;font-weight:600}#hfp-auth .hfp-auth-google:hover{background:#EEF4FA}#hfp-auth button[disabled]{opacity:.55;cursor:default}' +
    '#hfp-auth .hfp-auth-or{display:flex;align-items:center;gap:10px;margin:16px 0;color:#3D434C;font-size:15px}#hfp-auth .hfp-auth-or::before,#hfp-auth .hfp-auth-or::after{content:"";flex:1;border-top:1px solid #E3E8EF}' +
    '#hfp-auth .hfp-auth-links{display:flex;flex-direction:column;gap:6px;align-items:center;margin:18px 0 0;font-size:16px}#hfp-auth .hfp-auth-links .hfp-link{min-height:40px;color:#2E5E8E;font-weight:600}' +
    '#hfp-auth .hfp-auth-x{position:absolute;top:12px;right:14px;width:44px;height:44px;background:none;border:0;border-radius:999px;font-size:28px;line-height:1;cursor:pointer;color:#3D434C}#hfp-auth .hfp-auth-x:hover{background:#EEF4FA}' +
    '#hfp-auth .hfp-status{text-align:center;font-size:16px;margin:12px 0 0}#hfp-auth .hfp-status:empty{display:none}';

  // Ways to sign in besides email: Google (on in Memberstack).
  function googleIcon() { return el('img', { src: 'https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png', alt: '', width: '20', height: '20' }); }
  function mailIcon() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="#2E5E8E" stroke-width="2"/><path d="M4 7l8 6 8-6" fill="none" stroke="#2E5E8E" stroke-width="2"/>';
    return s;
  }
  var SOCIAL = [{ id: 'google', key: 'auth-google', icon: googleIcon }];

  function authError(e, mode) {
    var t = String((e && (e.code || '')) + ' ' + (e && e.message || '')).toLowerCase();
    if (/already|exists|in use|taken/.test(t)) return copyText('auth-err-taken');
    if ((mode === 'reset' || mode === 'otp-code') && /token|code|expired|invalid/.test(t)) return copyText('auth-err-code');
    if (mode === 'otp' && /not found|no member|does not exist/.test(t)) return copyText('auth-otp-no-account');
    if (/weak|at least|length|characters/.test(t)) return copyText('auth-err-password');
    if (/credential|password|not found|no member|invalid/.test(t)) return mode === 'signin' ? copyText('auth-err-wrong') : copyText('auth-err-other');
    return copyText('auth-err-other');
  }

  function openAuth(mode) {
    var m = window.$memberstackDom;
    if (!m) return;
    if (!document.getElementById('hfp-auth-css')) document.head.appendChild(el('style', { id: 'hfp-auth-css', text: AUTH_CSS }));
    var old = document.getElementById('hfp-auth');
    if (old) { try { old.close(); } catch (e) {} drop(old); }
    var dlg = el('dialog', { id: 'hfp-auth', 'aria-labelledby': 'hfp-auth-title' });
    var logo = document.querySelector('.w-nav-brand img');
    var msg = status();
    var resetEmail = '';
    var otpFor = 'signin';
    var otpName = '';

    function field(key, name, type, auto, extra) {
      var id = 'hfp-auth-' + name;
      var input = el('input', Object.assign({ id: id, name: name, type: type, autocomplete: auto, required: true }, extra || {}));
      return [el('label', { for: id, text: copyText(key) }), input];
    }
    function link(key, to) { return el('button', { type: 'button', class: 'hfp-link', text: copyText(key), onclick: function () { draw(to); } }); }
    function say(text, error) { msg.textContent = text || ''; if (error) msg.setAttribute('data-kind', 'error'); else msg.removeAttribute('data-kind'); }

    function draw(to) {
      mode = to;
      dlg.innerHTML = '';
      say('');
      dlg.appendChild(el('button', { type: 'button', class: 'hfp-auth-x', 'aria-label': copyText('auth-close'), text: '×', onclick: function () { dlg.close(); } }));
      if (logo) dlg.appendChild(el('img', { class: 'hfp-auth-logo', src: logo.currentSrc || logo.src, alt: logo.alt || '' }));
      var titles = { signin: 'auth-signin-title', signup: 'auth-signup-title', reset: 'auth-reset-title', code: 'auth-reset-title', otp: otpFor === 'signup' ? 'auth-signup-title' : 'auth-signin-title', 'otp-code': otpFor === 'signup' ? 'auth-signup-title' : 'auth-signin-title' };
      dlg.appendChild(el('h2', { id: 'hfp-auth-title', text: copyText(titles[mode]) }));
      var form = el('form', { novalidate: true });
      var kids = [];
      var go;
      if (mode === 'signin' || mode === 'signup') {
        // Sign in with: Google, or a code by email.
        SOCIAL.forEach(function (p) {
          var b = el('button', { type: 'button', class: 'hfp-auth-google' }, [p.icon(), copyText(p.key)]);
          b.onclick = async function () {
            b.disabled = true;
            try {
              if (mode === 'signup') await m.signupWithProvider({ provider: p.id });
              else await m.loginWithProvider({ provider: p.id });
              location.reload();
            } catch (e) { b.disabled = false; say(authError(e, mode), true); }
          };
          dlg.appendChild(b);
        });
        var codeFor = mode;
        dlg.appendChild(el('button', { type: 'button', class: 'hfp-auth-google hfp-auth-mail', onclick: function () { otpFor = codeFor; draw('otp'); } }, [mailIcon(), copyText('auth-otp')]));
        dlg.appendChild(el('div', { class: 'hfp-auth-or', text: copyText('auth-or') }));
      }
      if (mode === 'signup' || (mode === 'otp' && otpFor === 'signup')) kids = kids.concat(field('auth-first-name', 'first-name', 'text', 'given-name', { maxlength: '40', value: otpName || undefined }));
      if (mode !== 'code' && mode !== 'otp-code') kids = kids.concat(field('auth-email', 'email', 'email', 'email', { value: resetEmail || undefined }));
      if (mode === 'code' || mode === 'otp-code') kids = kids.concat(field('auth-code', 'code', 'text', 'one-time-code', { inputmode: 'numeric' }));
      if (mode === 'signin') kids = kids.concat(field('auth-password', 'password', 'password', 'current-password'));
      if (mode === 'signup' || mode === 'code') kids = kids.concat(field('auth-password-new', 'password', 'password', 'new-password', { minlength: '8' }));
      var labels = { signin: 'auth-signin-button', signup: 'auth-signup-button', reset: 'auth-reset-send', code: 'auth-reset-button', otp: 'auth-reset-send', 'otp-code': otpFor === 'signup' ? 'auth-signup-button' : 'auth-signin-button' };
      go = el('button', { type: 'submit', class: 'hfp-auth-go', text: copyText(labels[mode]) });
      kids.forEach(function (k) { form.appendChild(k); });
      form.appendChild(go);
      form.appendChild(msg);
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var v = {};
        Array.prototype.forEach.call(form.elements, function (i) { if (i.name) v[i.name] = i.value.trim(); });
        if (Object.keys(v).some(function (k) { return !v[k]; })) { say(copyText('auth-err-fields'), true); return; }
        if ((mode === 'signup' || mode === 'code') && v.password.length < 8) { say(copyText('auth-err-password'), true); return; }
        go.disabled = true;
        say(copyText('auth-working'));
        try {
          if (mode === 'signin') { await m.loginMemberEmailPassword({ email: v.email, password: v.password }); location.reload(); return; }
          if (mode === 'signup') { await m.signupMemberEmailPassword({ email: v.email, password: v.password, customFields: { 'first-name': v['first-name'] } }); location.reload(); return; }
          if (mode === 'reset') { await m.sendMemberResetPasswordEmail({ email: v.email }); resetEmail = v.email; draw('code'); say(copyText('auth-reset-sent', { email: v.email })); return; }
          if (mode === 'code') { await m.resetMemberPassword({ token: v.code, newPassword: v.password }); draw('signin'); say(copyText('auth-reset-done')); return; }
          if (mode === 'otp') {
            if (otpFor === 'signup') await m.sendMemberSignupPasswordlessEmail({ email: v.email });
            else await m.sendMemberLoginPasswordlessEmail({ email: v.email });
            resetEmail = v.email;
            otpName = v['first-name'] || '';
            draw('otp-code');
            say(copyText('auth-otp-sent', { email: v.email }));
            return;
          }
          if (mode === 'otp-code') {
            if (otpFor === 'signup') await m.signupMemberPasswordless({ passwordlessToken: v.code, email: resetEmail, customFields: { 'first-name': otpName } });
            else await m.loginMemberPasswordless({ passwordlessToken: v.code, email: resetEmail });
            location.reload();
            return;
          }
        } catch (e) {
          go.disabled = false;
          say(authError(e, mode), true);
        }
      });
      dlg.appendChild(form);
      var links = el('div', { class: 'hfp-auth-links' });
      if (mode === 'signin') { links.appendChild(link('auth-forgot', 'reset')); links.appendChild(link('auth-to-signup', 'signup')); }
      else if (mode === 'signup') links.appendChild(link('auth-to-signin', 'signin'));
      else if (mode === 'otp' || mode === 'otp-code') links.appendChild(link('auth-otp-password', otpFor === 'signup' ? 'signup' : 'signin'));
      else links.appendChild(link('auth-back', 'signin'));
      dlg.appendChild(links);
      var first = form.querySelector('input');
      if (first && dlg.open) { first.focus({ preventScroll: true }); dlg.scrollTop = 0; }
    }

    draw(mode === 'signup' ? 'signup' : 'signin');
    dlg.addEventListener('close', function () { drop(dlg); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    document.body.appendChild(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    // Open at the top (logo and title in view), even when the window is taller than the screen.
    var f = dlg.querySelector('form input');
    if (f) f.focus({ preventScroll: true });
    dlg.scrollTop = 0;
  }
  window.HFP.auth = openAuth;

  function start() {
    // Pages that had their own embed code switch over once that code is
    // replaced in Webflow by the marker <div data-hf-pages hidden></div>.
    var marked = !!document.querySelector('[data-hf-pages]');
    var parts = [emptyLists, shorterAlsoFits, rememberLocation, headerAccount, impactNumbers, claimPage, invitePage, storiesPage, mostDone];
    if (marked) parts.push(actionPage, accountPage, suggestPage, storyPage);
    parts.forEach(function (f) {
      try { var p = f(); if (p && p.catch) p.catch(function (e) { console.error('[hf-pages]', e); }); } catch (e) { console.error('[hf-pages]', e); }
    });
    try { storyItemPage(); } catch (e) {}
  }
  // Start once the page and the interface text are there
  // (and Memberstack, which says who is signed in).
  function go() {
    wait(function () { return window.HFW && (window.$memberstackDom || !document.querySelector('script[data-memberstack-app]')); }, 10000).then(start);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
