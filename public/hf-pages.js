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
 *   Drop hero        #hf-drop-count      pieces left, pledges made and kept
 *   Actions          /actions            "Most done" list
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
  // Text kept in Webflow. [data-hf-show="x"] is shown once the script turns it on
  // (the site head hides it until then), [data-hf-fill="x"] receives data, and
  // [data-hf-copy="x"] holds wording the script reads but never shows.
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
  // The drop's state, asked for once per page: the hero and "The pieces" both need it.
  var dropStates = {};
  function dropState(slug) {
    var q = '/api/drops/state' + (slug ? '?drop=' + slug : '');
    return dropStates[q] || (dropStates[q] = HFB.call(q, { auth: false }));
  }
  function copyText(key, vars) {
    var e = document.querySelector('[data-hf-copy="' + key + '"]');
    var t = e ? e.textContent.trim() : '';
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
  // "64 of 100 left" and "100 pledges made, 81 kept", worded in Webflow's footer.
  function leftText(left, quantity) { return copyText('facts-left', { left: left, quantity: quantity }); }
  function pledgesText(p) { return copyText(p.made === 1 ? 'pledges-one' : 'pledges-many', { made: p.made, kept: p.kept }); }
  /** A product's label from the backend's facts: "Drop 01 · 100 pieces", "… · 64 of 100 left", "… · Sold out". */
  function labelText(l) {
    if (!l) return '';
    if (typeof l === 'string') return l;
    var name = l.name || copyText('label-edition');
    if (l.soldOut) return copyText('label-sold-out', { name: name });
    if (l.left !== null && l.left !== undefined && l.size) return copyText('label-left', { name: name, left: l.left, size: l.size });
    if (l.size) return copyText('label-pieces', { name: name, size: l.size });
    return name;
  }
  function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function signedIn() { return !!(window.HF && HF.token && HF.token()); }
  function wait(test, ms) {
    return new Promise(function (r) { var t0 = Date.now(); (function c() { if (test()) return r(true); if (Date.now() - t0 > ms) return r(false); setTimeout(c, 50); })(); });
  }
  function slugFromPath() { return location.pathname.split('/').filter(Boolean).pop() || ''; }
  function msgOf(r, fallback) { return (r && r.data && r.data.message) || fallback || copyText('error-something'); }

  // A few styles for the parts this script adds; everything else uses the site's classes.
  var css = '.hfp-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:16px 0}' +
    '.hfp-status{margin:8px 0}.hfp-status[data-kind=error]{color:#a11}' +
    '.hfp-muted{color:#555}.hfp-small{font-size:15px}.hfp-card{border:2px solid #222;border-radius:12px;padding:20px;margin:16px 0}' +
    '.hfp-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}' +
    '.hfp-video{position:relative;width:100%;aspect-ratio:16/9;margin:0 0 12px;border-radius:8px;overflow:hidden;background:#eee}' +
    '.hfp-video.is-vertical{max-width:340px;aspect-ratio:9/16}.hfp-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}' +
    '.hfp-photo{display:block;width:100%;max-width:640px;border-radius:8px;margin:0 0 12px}' +
    '.hfp-list{list-style:none;padding:0;margin:8px 0 16px}.hfp-list li{padding:10px 0;border-bottom:1px solid #e5e5e5}' +
    '.hfp-field{margin:0 0 16px}.hfp-check{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px}.hfp-check input{margin-top:5px;width:18px;height:18px;flex:none}' +
    '.hfp-check label{font-size:17px;font-weight:400;line-height:1.5;margin:0;cursor:pointer}' +
    '.hfp-pill{display:inline-block;font-size:13px;padding:2px 10px;border-radius:999px;border:1px solid #bbb;margin-left:8px}' +
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
  function section(title, kids) { return el('div', null, [el('h2', { text: title })].concat(kids)); }

  async function accountPage() {
    var inn = $('hf-acct-in');
    var out = $('hf-acct-out');
    if (!inn || inn.getAttribute('data-hfp')) return;
    inn.setAttribute('data-hfp', '1');
    var si = $('hf-signin');
    var so = $('hf-signout');
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (si) si.addEventListener('click', function (e) { e.preventDefault(); HF.signin(); });
    if (so) so.addEventListener('click', function (e) { e.preventDefault(); HF.signout(); });
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }
    if (!signedIn()) return;
    var r = await HFB.call('/api/me');
    if (!r.ok) return;
    var me = r.data;
    if (out) out.style.display = 'none';
    inn.style.display = 'block';
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || copyText('acct-there');
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var tally = $('hf-tally');
    if (tally && !$('hfp-ripple')) {
      tally.insertAdjacentElement('afterend', el('p', { id: 'hfp-ripple', class: 'hfp-muted', text: me.ripple > 0 ? copyText('ripple', { n: me.ripple }) : copyText('acct-ripple-none') }));
    }

    // Pledges
    var pl = $('hf-pledges');
    if (pl) {
      pl.innerHTML = '';
      if (!me.pledges.length) pl.appendChild(el('p', { text: copyText('acct-pledges-none') }));
      else {
        var ul = el('ul', { class: 'hfp-list' });
        me.pledges.forEach(function (p) {
          var li = el('li', null, [copyText('acct-pledged', { date: day(p.orderedAt) }) + ' · ']);
          if (p.status === 'kept') {
            var by = p.keptBySlug ? el('a', { href: '/action/' + p.keptBySlug, text: p.keptByTitle }) : p.keptByTitle || copyText('acct-pledge-an-action');
            copyNodes('acct-pledge-kept', { action: by, date: day(p.keptOn) }).forEach(function (n) { li.appendChild(n); });
          } else {
            li.appendChild(document.createTextNode(copyText('acct-pledge-open') + ' '));
            li.appendChild(el('a', { href: '/actions', text: copyText('acct-pledge-keep') }));
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
          var li = el('li');
          li.appendChild(d.slug && d.actionStatus === 'published' ? el('a', { href: '/action/' + d.slug, text: d.title }) : document.createTextNode(d.title));
          li.appendChild(el('span', { class: 'hfp-muted', text: ' · ' + day(d.doneAt) + (times > 1 ? ' · ' + copyText('acct-times', { n: times }) : '') }));
          var s = storyFor[d.actionId];
          if (d.slug && d.actionStatus === 'published') {
            li.appendChild(document.createTextNode(' · '));
            li.appendChild(el('a', { class: 'hf-story-link', href: '/share-your-story?action=' + encodeURIComponent(d.slug), text: copyText(s ? 'story-edit' : 'story-share') }));
          }
          if (s) li.appendChild(el('span', { class: 'hfp-pill', text: copyText(s.status === 'approved' ? 'acct-story-approved' : s.status === 'rejected' ? 'acct-story-rejected' : 'acct-story-review') }));
          list.appendChild(li);
        });
        ah.appendChild(list);
      }
      var holder = ah.parentNode;
      // Saved for later
      if (me.saved && me.saved.length && !$('hfp-saved')) {
        var sv = el('ul', { class: 'hfp-list', id: 'hfp-saved' });
        me.saved.forEach(function (d) { sv.appendChild(el('li', null, [el('a', { href: '/action/' + d.slug, text: d.title })])); });
        holder.insertBefore(section(copyText('acct-saved-h'), [sv]), ah.previousElementSibling);
      }
      // Invites
      if (!$('hfp-invites')) {
        var inv = el('div', { id: 'hfp-invites' });
        if (me.joinedMyInvites.length) {
          var j = el('ul', { class: 'hfp-list' });
          me.joinedMyInvites.forEach(function (x) { j.appendChild(el('li', { text: copyText('acct-joined', { name: x.name || copyText('acct-someone'), action: x.actionTitle || '', date: day(x.joinedAt) }) })); });
          inv.appendChild(section(copyText('acct-joined-h'), [j]));
        }
        if (me.invitesIJoined.length) {
          var k = el('ul', { class: 'hfp-list' });
          me.invitesIJoined.forEach(function (x) {
            var leave = el('button', { type: 'button', class: 'hfp-link hfp-small', text: copyText('acct-leave') });
            var li = el('li', null, [copyText('acct-invited', { name: x.inviterName || copyText('acct-someone') }) + ' · ', x.actionSlug ? el('a', { href: '/action/' + x.actionSlug, text: x.actionTitle }) : (x.actionTitle || ''), ' · ', leave]);
            leave.addEventListener('click', async function () {
              var rr = await HFB.call('/api/invites/' + encodeURIComponent(x.code) + '/join', { method: 'DELETE' });
              if (rr.ok) li.remove();
            });
            k.appendChild(li);
          });
          inv.appendChild(section(copyText('acct-invited-h'), [k]));
        }
        ah.nextElementSibling ? holder.insertBefore(inv, ah.nextElementSibling.nextElementSibling) : holder.appendChild(inv);
      }
    }

    // Orders (from Shopify, as before)
    if ($('hf-orders') && HF.load) {
      try {
        var c = await HF.load();
        var o = (c && c.orders && c.orders.nodes) || [];
        if (o.length) {
          var ol = el('ul', { class: 'hfp-list' });
          o.forEach(function (x) { ol.appendChild(el('li', { text: x.name + ' · ' + day(x.processedAt) + ' · ' + x.totalPrice.amount + ' ' + x.totalPrice.currencyCode })); });
          $('hf-orders').innerHTML = '';
          $('hf-orders').appendChild(ol);
        }
      } catch (e) {}
    }

    // Settings and your data
    if (!$('hfp-settings') && so) {
      var box = el('div', { id: 'hfp-settings' });
      var nameIn = el('input', { id: 'hfp-share-name', class: 'hf-form-input w-input', value: me.name || '', maxlength: '40', autocomplete: 'given-name' });
      var nameMsg = status();
      var nameSave = el('button', { type: 'button', class: 'hf-button-light', text: copyText('acct-save-name') });
      nameSave.addEventListener('click', async function () {
        var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: { firstName: nameIn.value } });
        nameMsg.textContent = rr.ok ? copyText('saved') : msgOf(rr);
      });
      box.appendChild(el('h2', { text: copyText('acct-settings-h') }));
      box.appendChild(el('div', { class: 'hfp-field' }, [el('label', { for: 'hfp-share-name', class: 'hf-form-label', text: copyText('acct-name-label') }), nameIn, nameSave, nameMsg]));
      var labels = {};
      ['invite_summary', 'story_approved', 'suggestion_live', 'pledge_reminder'].forEach(function (k) { labels[k] = copyText('acct-email-' + k); });
      var fs = el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0;margin:0 0 16px' }, [el('legend', { class: 'hf-form-label', text: copyText('acct-email-me') })]);
      var setMsg = status();
      Object.keys(labels).forEach(function (kind) {
        var cb = el('input', { type: 'checkbox', id: 'hfp-n-' + kind, checked: me.settings[kind] ? true : false });
        cb.addEventListener('change', async function () {
          var body = { notifications: {} };
          body.notifications[kind] = cb.checked;
          var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: body });
          setMsg.textContent = rr.ok ? copyText('saved') : msgOf(rr);
          if (!rr.ok) cb.checked = !cb.checked;
        });
        fs.appendChild(el('div', { class: 'hfp-check' }, [cb, el('label', { for: 'hfp-n-' + kind, text: labels[kind] })]));
      });
      fs.appendChild(setMsg);
      box.appendChild(fs);
      var dl = el('button', { type: 'button', class: 'hf-button-light', text: copyText('acct-download') });
      dl.addEventListener('click', function () {
        var blob = new Blob([JSON.stringify(me, null, 2)], { type: 'application/json' });
        var a = el('a', { href: URL.createObjectURL(blob), download: 'happiness-foundation-my-data.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      var del = el('button', { type: 'button', class: 'hf-button-light', text: copyText('acct-delete') });
      var delMsg = status();
      del.addEventListener('click', async function () {
        if (!window.confirm(copyText('acct-delete-confirm'))) return;
        var rr = await HFB.call('/api/me', { method: 'DELETE' });
        delMsg.textContent = rr.ok ? copyText('acct-deleted') : msgOf(rr);
        if (rr.ok) setTimeout(function () { HF.signout(); }, 2500);
      });
      box.appendChild(el('h2', { text: copyText('acct-data-h') }));
      box.appendChild(el('div', { class: 'hfp-row' }, [dl, del]));
      box.appendChild(delMsg);
      so.parentNode.insertAdjacentElement('beforebegin', box);
    }
  }

  // ---------------------------------------------------------------------------
  // Suggest an action
  // ---------------------------------------------------------------------------
  async function suggestPage() {
    var f = $('wf-form-Suggest-an-action');
    if (location.pathname !== '/suggest-an-action' && !f) return;
    if (!f) {
      // The old Webflow form has been removed: build the form here.
      if ($('hfp-suggest')) return;
      f = el('form', { id: 'hfp-suggest', class: 'hf-form', novalidate: true }, [
        el('label', { for: 'Idea', class: 'hf-form-label', text: copyText('sug-label') }),
        el('textarea', { id: 'Idea', name: 'Idea', class: 'hf-form-input is-textarea w-input', maxlength: '2000', required: true, placeholder: copyText('sug-placeholder') }),
        el('div', { class: 'hfp-row' }, [el('button', { type: 'submit', class: 'hf-button', text: copyText('sug-send') })]),
      ]);
      var anchor = document.querySelector('.hf-lead') || document.querySelector('h1');
      if (!anchor) return;
      anchor.insertAdjacentElement('afterend', el('div', { class: 'w-form' }, [f]));
    }
    if (f.getAttribute('data-hfp')) return;
    f.setAttribute('data-hfp', '1');
    var wrap = f.closest('.w-form') || f;
    var ta = f.querySelector('textarea');
    // Name and email come from the account; the fields are not needed.
    ['name', 'email'].forEach(function (n) {
      var i = f.querySelector('#' + n);
      if (i) { i.required = false; i.style.display = 'none'; var l = f.querySelector('label[for="' + n + '"]'); if (l) l.style.display = 'none'; }
    });
    var msg = status();
    f.appendChild(msg);
    var draft = HFB.keepDraft(f);
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (!signedIn()) {
      var note = el('p', { class: 'hfp-muted', text: copyText('sug-signin') });
      f.insertBefore(note, f.firstChild);
    }
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      var text = (ta && ta.value || '').trim();
      if (text.length < 3) { msg.textContent = copyText('sug-empty'); msg.setAttribute('data-kind', 'error'); ta && ta.focus(); return; }
      if (!signedIn()) return HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      var submit = f.querySelector('[type=submit]');
      if (submit) submit.disabled = true;
      var r = await HFB.call('/api/suggestions', { method: 'POST', body: { text: text } });
      if (submit) submit.disabled = false;
      if (r.ok) {
        draft.clear();
        wrap.innerHTML = '';
        wrap.appendChild(el('div', { class: 'hfp-card', role: 'status' }, [
          el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: copyText('sug-thanks') }),
          el('p', { text: copyText('sug-thanks-more') }),
          el('p', null, [el('a', { class: 'hf-button-light', href: '/suggest-an-action', text: copyText('sug-another') })]),
        ]));
      } else if (r.status === 401) HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      else { msg.textContent = msgOf(r); msg.setAttribute('data-kind', 'error'); }
    }, true);
    document.addEventListener('hfb:resumed', function (ev) {
      if (ev.detail && ev.detail.kind === 'suggestion' && ev.detail.completed) {
        draft.clear();
        wrap.innerHTML = '';
        wrap.appendChild(el('p', { class: 'hfp-card', role: 'status', text: copyText('sug-thanks-resumed') }));
      }
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
    var fa = $('story-action');
    var native = fa && fa.closest('form');
    var note = $('hf-story-note');
    // Works with or without the old Webflow form on the page (it is no longer used).
    if ((!native && !note) || (note && note.getAttribute('data-hfp'))) return;
    if (!note) { note = status(); (native.closest('.w-form') || native).insertAdjacentElement('beforebegin', note); }
    note.setAttribute('data-hfp', '1');
    var wrap = native ? native.closest('.w-form') || native : null;
    if (wrap) wrap.style.display = 'none';
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
    var form = el('form', { class: 'hf-form', novalidate: true });
    var msg = status();
    function field(id, label, input, help) {
      return el('div', { class: 'hfp-field' }, [el('label', { for: id, class: 'hf-form-label', text: label }), help ? el('p', { class: 'hfp-muted hfp-small', id: id + '-help', text: help }) : null, input]);
    }
    var text = el('textarea', { id: 'hfp-story-text', class: 'hf-form-input is-textarea w-input', maxlength: '5000', placeholder: copyText('st-placeholder') });
    text.value = s.text || '';
    var photo = el('input', { id: 'hfp-photo', type: 'file', accept: 'image/*', 'aria-describedby': 'hfp-photo-help' });
    var photoKey = s.photoKey || null;
    var photoMsg = status('hfp-status hfp-small');
    var preview = el('img', { class: 'hfp-photo', alt: '', style: photoKey ? '' : 'display:none', src: photoKey ? HFB.base + '/media/' + photoKey : undefined });
    var removePhoto = el('button', { type: 'button', class: 'hfp-link hfp-small', style: photoKey ? '' : 'display:none', text: copyText('st-remove-photo') });
    var desc = el('input', { id: 'hfp-photo-desc', class: 'hf-form-input w-input', maxlength: '300', value: s.photoDescription || '', placeholder: copyText('st-desc-placeholder') });
    var video = el('input', { id: 'hfp-video', type: 'url', class: 'hf-form-input w-input', value: s.videoUrl || '', placeholder: 'https://', 'aria-describedby': 'hfp-video-help' });
    var showName = el('input', { type: 'checkbox', id: 'hfp-show-name', checked: s.showName === false ? false : true });
    var consent = el('input', { type: 'checkbox', id: 'hfp-consent', required: true });
    var submit = el('button', { type: 'submit', class: 'hf-button', text: copyText(mine.story ? 'st-save' : 'st-share') });

    photo.addEventListener('change', async function () {
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
    removePhoto.addEventListener('click', function () { photoKey = null; preview.style.display = 'none'; removePhoto.style.display = 'none'; photo.value = ''; photoMsg.textContent = copyText('st-photo-removed'); });

    form.appendChild(el('p', { class: 'hf-drop-label', text: copyText('st-about') }));
    form.appendChild(el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: title }));
    if (mine.story) form.appendChild(el('p', { class: 'hfp-muted', text: copyText(mine.story.status === 'approved' ? 'st-on-site' : 'st-in-review') }));
    form.appendChild(field('hfp-story-text', copyText('st-label'), text));
    form.appendChild(field('hfp-photo', copyText('st-photo-label'), el('div', null, [photo, photoMsg, preview, removePhoto]), copyText('st-photo-help')));
    form.appendChild(field('hfp-photo-desc', copyText('st-desc-label'), desc));
    form.appendChild(field('hfp-video', copyText('st-video-label'), video, copyText('st-video-help')));
    var withBoxes = [];
    if (mine.withCandidates && mine.withCandidates.length) {
      var fs = el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0' }, [el('legend', { class: 'hf-form-label', text: copyText('st-with') })]);
      mine.withCandidates.forEach(function (c) {
        var cb = el('input', { type: 'checkbox', id: 'hfp-with-' + c.id, value: String(c.id), checked: (s.withMemberIds || []).indexOf(c.id) >= 0 });
        withBoxes.push(cb);
        fs.appendChild(el('div', { class: 'hfp-check' }, [cb, el('label', { for: 'hfp-with-' + c.id, text: c.name })]));
      });
      form.appendChild(fs);
    }
    form.appendChild(el('div', { class: 'hfp-check' }, [showName, el('label', { for: 'hfp-show-name', text: mine.name ? copyText('st-show-name-named', { name: mine.name }) : copyText('st-show-name') })]));
    form.appendChild(el('div', { class: 'hfp-check' }, [consent, el('label', { for: 'hfp-consent', text: copyText('st-consent') })]));
    form.appendChild(el('div', { class: 'hfp-row' }, [submit]));
    form.appendChild(msg);
    if (mine.story) {
      var del = el('button', { type: 'button', class: 'hfp-link hfp-small', text: copyText('st-delete') });
      del.addEventListener('click', async function () {
        if (!window.confirm(copyText('st-delete-confirm'))) return;
        var rr = await HFB.call('/api/stories/' + mine.story.id, { method: 'DELETE' });
        if (rr.ok) { form.innerHTML = ''; form.appendChild(el('p', { role: 'status', text: copyText('st-deleted') })); }
        else msg.textContent = msgOf(rr);
      });
      form.appendChild(el('p', null, [del]));
    }
    var draftKey = 'hfb_story:' + slug;
    try { var d = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (d && !text.value) text.value = d.text || ''; } catch (e) {}
    text.addEventListener('input', function () { try { localStorage.setItem(draftKey, JSON.stringify({ text: text.value })); } catch (e) {} });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      msg.removeAttribute('data-kind');
      if (!consent.checked) { msg.textContent = copyText('st-need-consent'); msg.setAttribute('data-kind', 'error'); consent.focus(); return; }
      if (!text.value.trim() && !photoKey && !video.value.trim()) { msg.textContent = copyText('st-empty'); msg.setAttribute('data-kind', 'error'); text.focus(); return; }
      submit.disabled = true;
      var body = {
        actionId: slug,
        text: text.value,
        photoKey: photoKey,
        photoDescription: desc.value,
        videoUrl: video.value,
        showName: showName.checked,
        consent: true,
        withMemberIds: withBoxes.filter(function (b) { return b.checked; }).map(function (b) { return Number(b.value); }),
      };
      var rr = await HFB.call('/api/stories', { method: 'POST', body: body });
      submit.disabled = false;
      if (rr.ok) {
        try { localStorage.removeItem(draftKey); } catch (e2) {}
        form.innerHTML = '';
        form.appendChild(el('div', { class: 'hfp-card', role: 'status' }, [
          el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: copyText('st-thanks') }),
          el('p', { text: copyText('st-thanks-more') }),
          el('p', null, [el('a', { class: 'hf-button-light', href: '/action/' + slug, text: copyText('st-back') })]),
        ]));
      } else if (rr.status === 401) {
        HFB.requireSignIn({ kind: 'return', returnTo: back });
      } else { msg.textContent = msgOf(rr); msg.setAttribute('data-kind', 'error'); }
    });
    note.innerHTML = '';
    note.insertAdjacentElement('afterend', form);
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
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
  // Drop hero: pieces left, pledges made and kept
  // ---------------------------------------------------------------------------
  async function dropHero() {
    var count = $('hf-drop-count');
    if (!count || $('hfp-drop-facts')) return;
    // "Coming soon", "Out now" and "Sold out" are Webflow elements in the hero; show the one
    // for the drop's state: the CMS status at once, then the backend's (stock, launch time).
    var hero = count.parentNode;
    var cms = $('hf-drop-status');
    if (cms && cms.textContent.trim()) showOnly(hero, cms.textContent.trim().toLowerCase().replace(/ /g, '_'));
    var m = /^\/drops\/([a-z0-9-]+)/.exec(location.pathname);
    await wait(function () { return window.HFB; }, 10000);
    var r = await dropState(m && m[1]);
    if (!r.ok) return;
    var d = r.data;
    if (d.status && d.status !== 'unknown') showOnly(hero, d.status);
    var facts = el('p', { id: 'hfp-drop-facts', class: 'hfp-muted' });
    var parts = [];
    if (d.status === 'live' && d.left !== null && d.quantity) parts.push(leftText(d.left, d.quantity));
    if (d.pledges && d.pledges.made > 0) parts.push(pledgesText(d.pledges));
    if (!parts.length) return;
    facts.textContent = parts.join(' · ');
    count.insertAdjacentElement('afterend', facts);
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


  // ---------------------------------------------------------------------------
  // Shop: the current drop, then "Available now", then past drops. Each
  // section shows a Shopify collection: the drop's address (drop-01) or
  // "available-now". Empty sections hide themselves. Every product card and
  // product page shows its edition label ("Drop 01 · 100 pieces").
  // ---------------------------------------------------------------------------
  var STORE = 'r40e0y-zs.myshopify.com';
  // Shopify's own card (the fallback list): its buttons are worded in Webflow's footer.
  function cardHtml(previewOnly) {
    return '<div class="hf-product"><shopify-media query="product.selectedOrFirstAvailableVariant.image" width="320" height="320"></shopify-media>' +
      '<h3><shopify-data query="product.title"></shopify-data></h3><p><shopify-money query="product.selectedOrFirstAvailableVariant.price"></shopify-money></p>' +
      '<button type="button" class="hf-button-light" shopify-attr--data-handle="product.handle" onclick="location.href=\'/products/\'+this.dataset.handle">' + esc(copyText('card-details')) + '</button>' +
      (previewOnly ? '' : ' <button type="button" class="hf-button" onclick="document.getElementById(\'hf-cart\').addLine(event).showModal()" shopify-attr--disabled="!product.selectedOrFirstAvailableVariant.availableForSale">' + esc(copyText('card-add')) + '</button>') +
      '</div>';
  }
  var SKELETON = '<div class="hfp-skeleton" aria-hidden="true"><div></div><p></p><p></p></div>';
  function collectionGrid(handle, previewOnly) {
    var g = el('div', { class: 'hfp-grid', 'aria-busy': 'true' });
    // Grey placeholders hold the space until Shopify fills in the products.
    var mo = new MutationObserver(function () {
      if (g.querySelector('.hf-product')) { g.querySelectorAll('.hfp-skeleton').forEach(function (x) { x.remove(); }); g.removeAttribute('aria-busy'); mo.disconnect(); }
    });
    mo.observe(g, { childList: true, subtree: true });
    g.innerHTML = SKELETON + SKELETON + SKELETON + '<shopify-context type="collection" handle="' + handle + '"><template><shopify-list-context type="product" query="collection.products" first="48"><template>' + cardHtml(previewOnly) + '</template></shopify-list-context></template></shopify-context>';
    return g;
  }
  var GRID_CSS = '.hfp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:28px;margin:20px 0 8px}' +
    '.hfp-grid shopify-context,.hfp-grid shopify-list-context{display:contents}.hfp-grid .hf-product h3{font-size:20px;margin:12px 0 4px}' +
    '.hfp-grid shopify-media img{width:100%;height:auto;border-radius:8px;background:#eee}.hfp-shop-section{margin:0 0 56px}.hfp-past{opacity:.85}' +
    '.hfp-skeleton div{aspect-ratio:1;border-radius:8px;background:#eee}.hfp-skeleton p{height:16px;margin:12px 0 0;border-radius:4px;background:#eee;max-width:70%}.hfp-skeleton p+p{max-width:35%}' +
    '@media (prefers-reduced-motion:no-preference){.hfp-skeleton div,.hfp-skeleton p{animation:hfp-pulse 1.2s ease-in-out infinite alternate}}@keyframes hfp-pulse{to{opacity:.5}}';
  function ensureShopify() {
    if (!document.querySelector('script[src*="storefront/web-components"]')) {
      document.head.appendChild(el('script', { type: 'module', src: 'https://cdn.shopify.com/storefront/web-components.js' }));
    }
    if (!document.querySelector('shopify-store')) document.body.appendChild(el('shopify-store', { 'store-domain': STORE, country: 'US', language: 'en' }));
    if (!$('hf-cart')) document.body.appendChild(el('shopify-cart', { id: 'hf-cart' }));
  }

  /** A drop's own page: every piece in the drop, right there. */
  async function dropPage() {
    var m = /^\/drops\/([a-z0-9-]+)\/?$/.exec(location.pathname);
    var box = $('hfp-pieces'); // "The pieces" heading and its line are in Webflow, inside the drop's box
    if (!m || !box || box.getAttribute('data-hfp')) return;
    box.setAttribute('data-hfp', '1');
    await wait(function () { return window.HFB; }, 10000);
    var r = await dropState(m[1]);
    var upcoming = r.ok && r.data.status === 'upcoming';
    document.head.appendChild(el('style', { text: GRID_CSS + '.hfp-card-img{display:block;width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#eee}' }));
    ensureShopify();
    // The drop's pieces from the shop's one answer (fast); Shopify's own list as a fallback.
    var shop = await HFB.call('/api/shop', { auth: false });
    var all = shop.ok ? [shop.data.current].concat(shop.data.past || []).filter(Boolean) : [];
    var found = all.filter(function (d) { return d.drop === m[1]; })[0];
    box.classList.add('hfp-shop-section');
    box.style.cssText = 'flex:1 1 100%;margin:0'; // full width under the image and text (.hf-drop wraps)
    // Before launch the hero already says when the drop goes live, so the line under the heading waits.
    if (!upcoming) showOnly(box, 'live');
    box.appendChild(found ? grid(found.products, found.status === 'live') : collectionGrid(m[1], upcoming));
    editionLabels(box);
  }
  function hideIfEmpty(sec) {
    // An empty collection: hide the section once Shopify has answered (or after 6 seconds).
    setTimeout(function () { if (!sec.querySelector('.hf-product')) sec.style.display = 'none'; }, 6000);
  }

  var labelsPromise = null;
  function loadLabels() {
    if (!labelsPromise) labelsPromise = HFB.call('/api/products/labels', { auth: false }).then(function (r) { return r.ok ? r.data.labels : {}; });
    return labelsPromise;
  }
  /** Adds "Drop 01 · 100 pieces" or "Limited edition · 250 pieces" to each product card as it renders. */
  function editionLabels(root) {
    function paint(labels) {
      root.querySelectorAll('.hf-product').forEach(function (card) {
        if (card.querySelector('.hfp-edition')) return;
        var b = card.querySelector('button[data-handle]');
        var label = b && labelText(labels[b.getAttribute('data-handle')]);
        if (!label) return;
        var h = card.querySelector('h3') || card.firstChild;
        card.insertBefore(el('p', { class: 'hfp-edition hf-drop-label', style: 'margin:12px 0 0', text: label }), h);
      });
    }
    loadLabels().then(function (labels) {
      paint(labels);
      new MutationObserver(function () { paint(labels); }).observe(root, { childList: true, subtree: true });
    });
  }

  async function productLabel() {
    var m = /^\/products\/([^\/]+)/.exec(location.pathname);
    var target = $('hf-product');
    if (!m || !target || $('hfp-product-edition')) return;
    await wait(function () { return window.HFB; }, 10000);
    var labels = await loadLabels();
    var label = labelText(labels[m[1]]);
    if (!label) return;
    var h1 = document.querySelector('h1');
    (h1 || target).insertAdjacentElement('beforebegin', el('p', { id: 'hfp-product-edition', class: 'hf-drop-label', text: label }));
  }

  // The whole shop in one call, asked for as soon as this script runs.
  var shopEarly = location.pathname === '/shop'
    ? fetch((window.HFB ? HFB.base : '/join') + '/api/shop', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .catch(function () { return { ok: false }; })
    : null;

  function money(p) {
    if (!p) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currencyCode }).format(Number(p.amount)); } catch (e) { return p.amount + ' ' + p.currencyCode; }
  }

  /** A product card drawn straight from the backend's answer; its wording is in Webflow's footer. */
  function productCard(p, canBuy) {
    var href = '/products/' + p.handle;
    var img = p.image ? el('a', { href: href, tabindex: '-1', 'aria-hidden': 'true' }, [
      el('img', { class: 'hfp-card-img', src: p.image.url + (p.image.url.indexOf('?') >= 0 ? '&' : '?') + 'width=640', alt: p.image.alt || p.title, loading: 'lazy', width: '640', height: '640' }),
    ]) : el('div', { class: 'hfp-card-img', 'aria-hidden': 'true' });
    var buy = null;
    if (canBuy && p.available) {
      buy = el('span', { class: 'hfp-buy' });
      buy.innerHTML = '<shopify-context type="product" handle="' + p.handle + '"><template><button type="button" class="hf-button" onclick="document.getElementById(\'hf-cart\').addLine(event).showModal()">' + esc(copyText('card-add')) + '</button></template></shopify-context>';
    }
    return el('div', { class: 'hf-product' }, [
      img,
      labelText(p.label) ? el('p', { class: 'hfp-edition hf-drop-label', style: 'margin:12px 0 0', text: labelText(p.label) }) : null,
      el('h3', null, [el('a', { href: href, style: 'color:inherit;text-decoration:none', text: p.title })]),
      el('p', { text: p.available ? money(p.price) : copyText('card-sold-out', { price: money(p.price) }) }),
      el('div', { class: 'hfp-row', style: 'margin:8px 0 0' }, [el('a', { class: 'hf-button-light', href: href, text: copyText('card-details') }), buy]),
    ]);
  }
  function grid(products, canBuy) {
    return el('div', { class: 'hfp-grid' }, products.map(function (p) { return productCard(p, canBuy); }));
  }

  async function shopPage() {
    var root = $('hf-shop');
    if (location.pathname !== '/shop' || !root || root.getAttribute('data-hfp')) return;
    root.setAttribute('data-hfp', '1');
    var r = await shopEarly;
    if (!r || !r.ok) { document.documentElement.setAttribute('data-hfp-shop', 'fallback'); return; } // the page's own list stays
    var cur = r.data.current;
    var past = r.data.past || [];
    var now = r.data.availableNow || [];
    document.head.appendChild(el('style', { text: GRID_CSS + '.hfp-card-img{display:block;width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#eee}' }));
    root.innerHTML = '<shopify-store store-domain="' + STORE + '" country="US" language="en"></shopify-store><shopify-cart id="hf-cart"></shopify-cart>';
    // The sections and their wording are Webflow elements under the shop (hidden until shown
    // here); this fills in the data and shows the sections that have something in them.
    var dropBox = $('hfp-shop-drop');
    if (cur && dropBox) {
      var facts = [];
      if (cur.status === 'live' && cur.left !== null && cur.quantity) facts.push(leftText(cur.left, cur.quantity));
      if (cur.pledges && cur.pledges.made > 0) facts.push(pledgesText(cur.pledges));
      // The drop and its pieces sit in one box, apart from any other products below.
      dropBox.classList.add('hfp-shop-section');
      dropBox.style.marginTop = '0';
      showOnly(dropBox, cur.status);
      var h = fillText(dropBox, 'name', cur.name);
      if (h) h.style.marginTop = '0';
      fillText(dropBox, 'statement', cur.statement);
      var details = fillText(dropBox, 'details', cur.detailsLine);
      if (details) details.classList.add('hfp-muted');
      var f = fillText(dropBox, 'facts', facts.join(' · '));
      if (f) f.classList.add('hfp-muted');
      var link = slot(dropBox, 'link');
      if (link) link.setAttribute('href', '/drops/' + cur.drop);
      var dropGrid = slot(dropBox, 'grid');
      // Before launch the pieces are shown on the drop page only; the shop lists them once the drop is out.
      if (dropGrid) { if (cur.products.length && cur.status === 'live') dropGrid.appendChild(grid(cur.products, true)); else drop(dropGrid); }
      turnOn(dropBox);
      wait(function () { return $('hfb-notify'); }, 8000).then(function (found) {
        if (!found) return;
        var form = $('hfb-notify');
        var lab = form.querySelector('label');
        var wording = copyText('notify-label'); // the same for members and visitors
        if (lab && wording) lab.textContent = wording;
        (details || dropBox.firstElementChild).insertAdjacentElement('afterend', form);
      });
    }
    var nowBox = $('hfp-shop-now');
    if (now.length && nowBox) {
      nowBox.classList.add('hfp-shop-section');
      if (!cur) nowBox.firstElementChild.style.marginTop = '0';
      var line = nowBox.querySelector('p');
      if (line) line.classList.add('hfp-muted');
      var nowGrid = slot(nowBox, 'grid');
      if (nowGrid) nowGrid.appendChild(grid(now, true));
      turnOn(nowBox);
    }
    var pastBox = $('hfp-shop-past');
    var template = pastBox && pastBox.querySelector('[data-hf-template="past-drop"]');
    var withPieces = past.filter(function (d) { return d.products && d.products.length; });
    if (template) {
      drop(template);
      withPieces.forEach(function (d) {
        var item = template.cloneNode(true);
        item.removeAttribute('data-hf-template');
        fillText(item, 'name', d.name);
        var q = fillText(item, 'statement', d.statement);
        if (q) q.style.fontSize = '18px';
        // "Sold out" (Webflow's text) unless there are pledges to count.
        var pl = slot(item, 'pledges');
        if (pl) { pl.classList.add('hfp-muted'); if (d.pledges && d.pledges.made) pl.textContent = pledgesText(d.pledges); }
        var g = slot(item, 'grid');
        if (g) g.appendChild(grid(d.products, false));
        pastBox.appendChild(item);
      });
      if (withPieces.length) { pastBox.classList.add('hfp-shop-section', 'hfp-past'); turnOn(pastBox); }
    }
    document.documentElement.setAttribute('data-hfp-shop', 'ready');
  }

  function start() {
    // Pages that had their own embed code switch over once that code is
    // replaced in Webflow by the marker <div data-hf-pages hidden></div>.
    var marked = !!document.querySelector('[data-hf-pages]');
    var parts = [invitePage, storiesPage, dropHero, mostDone, shopPage, productLabel, dropPage];
    if (marked) parts.push(actionPage, accountPage, suggestPage, storyPage);
    parts.forEach(function (f) {
      try { var p = f(); if (p && p.catch) p.catch(function (e) { console.error('[hf-pages]', e); }); } catch (e) { console.error('[hf-pages]', e); }
    });
    try { storyItemPage(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
