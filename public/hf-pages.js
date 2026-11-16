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
  function plural(n, one, many) { return n === 1 ? one : many; }
  function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function signedIn() { return !!(window.HF && HF.token && HF.token()); }
  function wait(test, ms) {
    return new Promise(function (r) { var t0 = Date.now(); (function c() { if (test()) return r(true); if (Date.now() - t0 > ms) return r(false); setTimeout(c, 50); })(); });
  }
  function slugFromPath() { return location.pathname.split('/').filter(Boolean).pop() || ''; }
  function msgOf(r, fallback) { return (r && r.data && r.data.message) || fallback || 'Something went wrong. Please try again.'; }

  // A few styles for the parts this script adds; everything else uses the site's classes.
  var css = '.hfp-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:16px 0}' +
    '.hfp-status{margin:8px 0}.hfp-status[data-kind=error]{color:#a11}' +
    '.hfp-muted{color:#555}.hfp-small{font-size:15px}.hfp-card{border:2px solid #222;border-radius:12px;padding:20px;margin:16px 0}' +
    '.hfp-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}' +
    '.hfp-video{position:relative;width:100%;aspect-ratio:16/9;margin:0 0 12px;border-radius:8px;overflow:hidden;background:#eee}' +
    '.hfp-video.is-vertical{max-width:340px;aspect-ratio:9/16}.hfp-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}' +
    '.hfp-photo{display:block;width:100%;max-width:640px;border-radius:8px;margin:0 0 12px}' +
    '.hfp-list{list-style:none;padding:0;margin:8px 0 16px}.hfp-list li{padding:10px 0;border-bottom:1px solid #e5e5e5}' +
    '.hfp-field{margin:0 0 16px}.hfp-check{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px}.hfp-check input{margin-top:5px}' +
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
      if (note) note.textContent = 'Link copied. Paste it in a message to the person you want to invite.';
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
    box.appendChild(el('label', { for: 'hfp-name', class: 'hf-form-label', text: 'Your first name, so they know who the invite is from' }));
    box.appendChild(input);
    box.appendChild(el('button', { type: 'submit', class: 'hf-button', text: 'Save and share' }));
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

  async function invite(actionId, kind, anchor, note) {
    var r = await HFB.call('/api/invites', { method: 'POST', body: { actionId: actionId, kind: kind } });
    if (r.status === 409 && r.data && r.data.error === 'need_first_name') {
      askName(anchor, function () { invite(actionId, kind, anchor, note); });
      return;
    }
    if (!r.ok) { note.textContent = msgOf(r); return; }
    await share({ title: document.title, text: r.data.text, url: r.data.url }, note);
  }

  // ---------------------------------------------------------------------------
  // Stories (action page and /stories)
  // ---------------------------------------------------------------------------
  function reportLink(id) {
    var note = status('hfp-status hfp-small');
    var b = el('button', { type: 'button', class: 'hfp-link hfp-small hfp-muted', text: 'Report this story' });
    b.addEventListener('click', async function () {
      var reason = window.prompt('What is wrong with this story? (optional)');
      if (reason === null) return;
      b.disabled = true;
      var r = await HFB.call('/api/stories/' + id + '/report', { method: 'POST', body: { reason: reason }, turnstile: true, auth: false });
      note.textContent = r.ok ? 'Thank you. We will look at it.' : msgOf(r);
      b.disabled = false;
    });
    return el('span', null, [b, note]);
  }

  function storyCard(s, withAction) {
    var kids = [];
    if (s.photo) kids.push(el('img', { class: 'hfp-photo', src: HFB.base + '/media/' + s.photo.key, alt: s.photo.description, loading: 'lazy' }));
    if (s.video) {
      kids.push(el('div', { class: 'hfp-video' + (s.video.vertical ? ' is-vertical' : '') }, [
        el('iframe', { src: s.video.embed, title: 'Video from ' + (s.name || 'a member') + "'s story", loading: 'lazy', allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true }),
      ]));
    }
    if (s.text) kids.push(el('p', { class: 'hf-story-text', text: s.text }));
    var who = (s.name || 'A member') + (s.with && s.with.length ? ', with ' + s.with.join(', ') : '') + ' · ' + day(s.createdAt);
    kids.push(el('p', { class: 'hf-story-meta', text: who }));
    if (withAction && s.action && s.action.title) {
      kids.push(s.action.slug ? el('p', null, [el('a', { class: 'hf-story-link', href: '/action/' + s.action.slug, text: 'The action: ' + s.action.title + ' →' })]) : el('p', { class: 'hf-story-meta', text: 'The action: ' + s.action.title }));
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
    var save = el('button', { type: 'button', class: 'hf-button-light', 'aria-pressed': 'false', text: '♡ Save' });
    var withMe = el('button', { type: 'button', class: 'hf-button-light', style: 'display:none', text: 'Do this with me' });
    var story = el('a', { class: 'hf-button-light', style: 'display:none', href: '/share-your-story?action=' + encodeURIComponent(slug), text: 'Share your story' });
    row.appendChild(save);
    row.appendChild(withMe);
    row.appendChild(story);
    var undo = el('button', { type: 'button', class: 'hfp-link hfp-small', style: 'display:none', text: 'Undo' });
    msg.insertAdjacentElement('afterend', undo);
    var together = el('p', { class: 'hfp-muted', style: 'display:none' });
    undo.insertAdjacentElement('afterend', together);
    var shareNote = status();
    var shareLine = el('p', { class: 'hfp-muted hfp-small', style: 'display:none', text: 'Invite someone to do it with you, not the person you are doing it for.' });
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
      if (st.count) { count.textContent = st.count.toLocaleString() + ' people have done this'; count.style.display = ''; } else count.style.display = 'none';
      if (st.suggestedBy) { suggested.textContent = 'Suggested by ' + st.suggestedBy; suggested.style.display = ''; }
      withMe.style.display = st.canDoWithOthers ? '' : 'none';
      shareLine.style.display = st.canDoWithOthers ? '' : 'none';
      save.textContent = me && me.liked ? '♥ Saved' : '♡ Save';
      save.setAttribute('aria-pressed', me && me.liked ? 'true' : 'false');
      if (me && me.done) {
        btn.textContent = me.doneToday ? 'Done today' : 'I did this again';
        btn.setAttribute('aria-disabled', me.doneToday ? 'true' : 'false');
        msg.textContent = 'You have made ' + me.tally + ' ' + plural(me.tally, 'person', 'people') + ' happy.';
        story.style.display = '';
        story.textContent = me.story ? 'Edit your story' : 'Share your story';
        undo.style.display = me.canUndo ? '' : 'none';
        if (me.doneWith && me.doneWith.length) { together.textContent = 'Done together with ' + me.doneWith.join(', '); together.style.display = ''; } else together.style.display = 'none';
      } else {
        btn.textContent = 'I did this';
        btn.setAttribute('aria-disabled', 'false');
        story.style.display = 'none';
        undo.style.display = 'none';
        together.style.display = 'none';
      }
    }

    function showCard(ripple) {
      card.innerHTML = '';
      card.appendChild(el('p', { class: 'hf-drop-label', text: 'Shared moment' }));
      card.appendChild(el('p', { class: 'hf-drop-statement', style: 'font-size:28px', text: 'I made someone happy today' }));
      if (ripple > 0) card.appendChild(el('p', { text: 'Your actions have led to ' + ripple + ' more.' }));
      var pass = el('button', { type: 'button', class: 'hf-button', text: 'Pass it on' });
      pass.addEventListener('click', function () { invite(id, 'pass_it_on', card, shareNote); });
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
      storiesBox.appendChild(el('h2', { id: 'hfp-stories-h', text: 'Stories' }));
      list.forEach(function (s) { storiesBox.appendChild(storyCard(s, false)); });
    }

    function ask(kind) {
      if (!prompt) return HFB.requireSignIn({ kind: kind, actionId: id });
      prompt.innerHTML = '';
      prompt.appendChild(el('p', { text: kind === 'like' ? 'Sign in to save actions for later. It is free.' : 'Sign in to count the people you make happy. It is free.' }));
      var b = el('button', { type: 'button', class: 'hf-button', text: 'Sign in' });
      b.addEventListener('click', function () { HFB.requireSignIn({ kind: kind, actionId: id }); });
      prompt.appendChild(b);
      prompt.style.display = 'block';
      b.focus();
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
      if (r.ok) { card.style.display = 'none'; await load(); msg.textContent = 'Undone. ' + msg.textContent; }
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
      invite(id, 'with_me', withMe.parentNode, shareNote);
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
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || 'there';
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var tally = $('hf-tally');
    if (tally && !$('hfp-ripple')) {
      tally.insertAdjacentElement('afterend', el('p', { id: 'hfp-ripple', class: 'hfp-muted', text: me.ripple > 0 ? 'Your actions have led to ' + me.ripple + ' more.' : 'When someone you invite takes an action, it shows here.' }));
    }

    // Pledges
    var pl = $('hf-pledges');
    if (pl) {
      pl.innerHTML = '';
      if (!me.pledges.length) pl.appendChild(el('p', { text: 'No pledges yet. Every piece in the shop comes with one.' }));
      else {
        var ul = el('ul', { class: 'hfp-list' });
        me.pledges.forEach(function (p) {
          var li = el('li', null, ['Pledged ' + day(p.orderedAt) + ' · ']);
          if (p.status === 'kept') {
            li.appendChild(document.createTextNode('Kept with '));
            li.appendChild(p.keptBySlug ? el('a', { href: '/action/' + p.keptBySlug, text: p.keptByTitle }) : document.createTextNode(p.keptByTitle || 'an action'));
            li.appendChild(document.createTextNode(' on ' + day(p.keptOn)));
          } else {
            li.appendChild(document.createTextNode('Open. '));
            li.appendChild(el('a', { href: '/actions', text: 'Find an action to keep it' }));
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
      if (!me.done.length) ah.appendChild(el('p', { text: 'Nothing here yet. Pick an action and make someone happy.' }));
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
          li.appendChild(el('span', { class: 'hfp-muted', text: ' · ' + day(d.doneAt) + (times > 1 ? ' · ' + times + ' times' : '') }));
          var s = storyFor[d.actionId];
          if (d.slug && d.actionStatus === 'published') {
            li.appendChild(document.createTextNode(' · '));
            li.appendChild(el('a', { class: 'hf-story-link', href: '/share-your-story?action=' + encodeURIComponent(d.slug), text: s ? 'Edit your story' : 'Share your story' }));
          }
          if (s) li.appendChild(el('span', { class: 'hfp-pill', text: s.status === 'approved' ? 'Story on the site' : s.status === 'rejected' ? 'Story not shown' : 'Story in review' }));
          list.appendChild(li);
        });
        ah.appendChild(list);
      }
      var holder = ah.parentNode;
      // Saved for later
      if (me.saved && me.saved.length && !$('hfp-saved')) {
        var sv = el('ul', { class: 'hfp-list', id: 'hfp-saved' });
        me.saved.forEach(function (d) { sv.appendChild(el('li', null, [el('a', { href: '/action/' + d.slug, text: d.title })])); });
        holder.insertBefore(section('Saved for later', [sv]), ah.previousElementSibling);
      }
      // Invites
      if (!$('hfp-invites')) {
        var inv = el('div', { id: 'hfp-invites' });
        if (me.joinedMyInvites.length) {
          var j = el('ul', { class: 'hfp-list' });
          me.joinedMyInvites.forEach(function (x) { j.appendChild(el('li', { text: (x.name || 'Someone') + ' is in · ' + (x.actionTitle || '') + ' · ' + day(x.joinedAt) })); });
          inv.appendChild(section('People who joined you', [j]));
        }
        if (me.invitesIJoined.length) {
          var k = el('ul', { class: 'hfp-list' });
          me.invitesIJoined.forEach(function (x) {
            var leave = el('button', { type: 'button', class: 'hfp-link hfp-small', text: 'Leave' });
            var li = el('li', null, [(x.inviterName || 'Someone') + ' invited you · ', x.actionSlug ? el('a', { href: '/action/' + x.actionSlug, text: x.actionTitle }) : (x.actionTitle || ''), ' · ', leave]);
            leave.addEventListener('click', async function () {
              var rr = await HFB.call('/api/invites/' + encodeURIComponent(x.code) + '/join', { method: 'DELETE' });
              if (rr.ok) li.remove();
            });
            k.appendChild(li);
          });
          inv.appendChild(section('Invites you joined', [k]));
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
      var nameSave = el('button', { type: 'button', class: 'hf-button-light', text: 'Save name' });
      nameSave.addEventListener('click', async function () {
        var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: { firstName: nameIn.value } });
        nameMsg.textContent = rr.ok ? 'Saved.' : msgOf(rr);
      });
      box.appendChild(el('h2', { text: 'Settings' }));
      box.appendChild(el('div', { class: 'hfp-field' }, [el('label', { for: 'hfp-share-name', class: 'hf-form-label', text: 'First name shown when you share' }), nameIn, nameSave, nameMsg]));
      var labels = {
        invite_summary: 'A daily email when someone joins your invite',
        story_approved: 'An email when your story is on the site',
        suggestion_live: 'An email when your suggested action is live',
        pledge_reminder: 'One reminder if a pledge is still open after a week',
      };
      var fs = el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0;margin:0 0 16px' }, [el('legend', { class: 'hf-form-label', text: 'Emails' })]);
      var setMsg = status();
      Object.keys(labels).forEach(function (kind) {
        var cb = el('input', { type: 'checkbox', id: 'hfp-n-' + kind, checked: me.settings[kind] ? true : false });
        cb.addEventListener('change', async function () {
          var body = { notifications: {} };
          body.notifications[kind] = cb.checked;
          var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: body });
          setMsg.textContent = rr.ok ? 'Saved.' : msgOf(rr);
          if (!rr.ok) cb.checked = !cb.checked;
        });
        fs.appendChild(el('div', { class: 'hfp-check' }, [cb, el('label', { for: 'hfp-n-' + kind, text: labels[kind] })]));
      });
      fs.appendChild(setMsg);
      box.appendChild(fs);
      var dl = el('button', { type: 'button', class: 'hf-button-light', text: 'Download my data' });
      dl.addEventListener('click', function () {
        var blob = new Blob([JSON.stringify(me, null, 2)], { type: 'application/json' });
        var a = el('a', { href: URL.createObjectURL(blob), download: 'happiness-foundation-my-data.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      var del = el('button', { type: 'button', class: 'hf-button-light', text: 'Delete my data' });
      var delMsg = status();
      del.addEventListener('click', async function () {
        if (!window.confirm('Delete your stories, your name and your settings? Your counted actions stay in the totals without your name. This cannot be undone.')) return;
        var rr = await HFB.call('/api/me', { method: 'DELETE' });
        delMsg.textContent = rr.ok ? 'Your data has been deleted. You will now be signed out.' : msgOf(rr);
        if (rr.ok) setTimeout(function () { HF.signout(); }, 2500);
      });
      box.appendChild(el('h2', { text: 'Your data' }));
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
    if (!f || f.getAttribute('data-hfp')) return;
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
      var note = el('p', { class: 'hfp-muted', text: 'You will be asked to sign in when you send it. It is free.' });
      f.insertBefore(note, f.firstChild);
    }
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      var text = (ta && ta.value || '').trim();
      if (text.length < 3) { msg.textContent = 'Please write your idea before sending it.'; msg.setAttribute('data-kind', 'error'); ta && ta.focus(); return; }
      if (!signedIn()) return HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      var submit = f.querySelector('[type=submit]');
      if (submit) submit.disabled = true;
      var r = await HFB.call('/api/suggestions', { method: 'POST', body: { text: text } });
      if (submit) submit.disabled = false;
      if (r.ok) {
        draft.clear();
        wrap.innerHTML = '';
        wrap.appendChild(el('div', { class: 'hfp-card', role: 'status' }, [
          el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: 'Thank you. Your idea is with us.' }),
          el('p', { text: 'We read every suggestion. If it goes on the site, we will email you.' }),
          el('p', null, [el('a', { class: 'hf-button-light', href: '/suggest-an-action', text: 'Suggest another' })]),
        ]));
      } else if (r.status === 401) HFB.requireSignIn({ kind: 'suggestion', data: { text: text } });
      else { msg.textContent = msgOf(r); msg.setAttribute('data-kind', 'error'); }
    }, true);
    document.addEventListener('hfb:resumed', function (ev) {
      if (ev.detail && ev.detail.kind === 'suggestion' && ev.detail.completed) {
        draft.clear();
        wrap.innerHTML = '';
        wrap.appendChild(el('p', { class: 'hfp-card', role: 'status', text: 'Thank you. Your idea is with us. If it goes on the site, we will email you.' }));
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
    if (!native || native.getAttribute('data-hfp')) return;
    native.setAttribute('data-hfp', '1');
    var wrap = native.closest('.w-form') || native;
    var note = $('hf-story-note') || status();
    wrap.style.display = 'none';
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
    if (!slug) return sayLink('Stories are shared from an action you have taken.', 'Go to your account', '/account');
    if (!signedIn()) return sayLink('Sign in to share your story. It is free.', 'Sign in', '/account', function () { HFB.requireSignIn({ kind: 'return', returnTo: back }); });
    var r = await HFB.call('/api/stories/mine?action=' + encodeURIComponent(slug));
    if (!r.ok) return sayLink(msgOf(r), 'Go to your account', '/account');
    var mine = r.data;
    if (!mine.done) return sayLink('Stories are shared from an action you have taken. Mark it done first.', 'Go to the action', '/action/' + slug);
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
    var text = el('textarea', { id: 'hfp-story-text', class: 'hf-form-input is-textarea w-input', maxlength: '5000', placeholder: 'What did you do, and how did they react?' });
    text.value = s.text || '';
    var photo = el('input', { id: 'hfp-photo', type: 'file', accept: 'image/*', 'aria-describedby': 'hfp-photo-help' });
    var photoKey = s.photoKey || null;
    var photoMsg = status('hfp-status hfp-small');
    var preview = el('img', { class: 'hfp-photo', alt: '', style: photoKey ? '' : 'display:none', src: photoKey ? HFB.base + '/media/' + photoKey : undefined });
    var removePhoto = el('button', { type: 'button', class: 'hfp-link hfp-small', style: photoKey ? '' : 'display:none', text: 'Remove photo' });
    var desc = el('input', { id: 'hfp-photo-desc', class: 'hf-form-input w-input', maxlength: '300', value: s.photoDescription || '', placeholder: 'For example: My neighbour holding the cake' });
    var video = el('input', { id: 'hfp-video', type: 'url', class: 'hf-form-input w-input', value: s.videoUrl || '', placeholder: 'https://', 'aria-describedby': 'hfp-video-help' });
    var showName = el('input', { type: 'checkbox', id: 'hfp-show-name', checked: s.showName === false ? false : true });
    var consent = el('input', { type: 'checkbox', id: 'hfp-consent', required: true });
    var submit = el('button', { type: 'submit', class: 'hf-button', text: mine.story ? 'Save changes' : 'Share my story' });

    photo.addEventListener('change', async function () {
      var file = photo.files && photo.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { photoMsg.textContent = 'That photo is larger than 10 MB. Please choose a smaller one.'; return; }
      photoMsg.textContent = 'Preparing your photo...';
      var blob;
      try { blob = await resizeToJpeg(file); } catch (e) {
        photoMsg.textContent = 'This browser cannot read that photo. Please choose a JPEG or PNG, or use your phone.';
        return;
      }
      var tok = await HFB.token();
      var res = await fetch(HFB.base + '/api/stories/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg' }, body: blob });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) { photoMsg.textContent = (data && data.message) || 'The photo could not be uploaded. Please try again.'; return; }
      photoKey = data.photoKey;
      preview.src = URL.createObjectURL(blob);
      preview.style.display = '';
      removePhoto.style.display = '';
      photoMsg.textContent = 'Photo added. Location data has been removed.';
    });
    removePhoto.addEventListener('click', function () { photoKey = null; preview.style.display = 'none'; removePhoto.style.display = 'none'; photo.value = ''; photoMsg.textContent = 'Photo removed.'; });

    form.appendChild(el('p', { class: 'hf-drop-label', text: 'Your story about' }));
    form.appendChild(el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: title }));
    if (mine.story) form.appendChild(el('p', { class: 'hfp-muted', text: mine.story.status === 'approved' ? 'Your story is on the site. Saving changes sends it back for a quick review.' : 'Your story is waiting for review.' }));
    form.appendChild(field('hfp-story-text', 'Your story', text));
    form.appendChild(field('hfp-photo', 'A photo (optional)', el('div', null, [photo, photoMsg, preview, removePhoto]), 'Up to 10 MB. Location data is removed.'));
    form.appendChild(field('hfp-photo-desc', 'Describe the photo for people who cannot see it (optional)', desc));
    form.appendChild(field('hfp-video', 'A video link (optional)', video, 'A link from YouTube, TikTok, Instagram or Vimeo.'));
    var withBoxes = [];
    if (mine.withCandidates && mine.withCandidates.length) {
      var fs = el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0' }, [el('legend', { class: 'hf-form-label', text: 'Who did it with you?' })]);
      mine.withCandidates.forEach(function (c) {
        var cb = el('input', { type: 'checkbox', id: 'hfp-with-' + c.id, value: String(c.id), checked: (s.withMemberIds || []).indexOf(c.id) >= 0 });
        withBoxes.push(cb);
        fs.appendChild(el('div', { class: 'hfp-check' }, [cb, el('label', { for: 'hfp-with-' + c.id, text: c.name })]));
      });
      form.appendChild(fs);
    }
    form.appendChild(el('div', { class: 'hfp-check' }, [showName, el('label', { for: 'hfp-show-name', text: 'Show my first name' + (mine.name ? ' (' + mine.name + ')' : '') + ' with the story' })]));
    form.appendChild(el('div', { class: 'hfp-check' }, [consent, el('label', { for: 'hfp-consent', text: 'Everyone shown has agreed to this' })]));
    form.appendChild(el('div', { class: 'hfp-row' }, [submit]));
    form.appendChild(msg);
    if (mine.story) {
      var del = el('button', { type: 'button', class: 'hfp-link hfp-small', text: 'Delete my story' });
      del.addEventListener('click', async function () {
        if (!window.confirm('Delete your story? It is taken off the site straight away.')) return;
        var rr = await HFB.call('/api/stories/' + mine.story.id, { method: 'DELETE' });
        if (rr.ok) { form.innerHTML = ''; form.appendChild(el('p', { role: 'status', text: 'Your story has been deleted.' })); }
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
      if (!consent.checked) { msg.textContent = 'Please tick the box to confirm that everyone shown has agreed.'; msg.setAttribute('data-kind', 'error'); consent.focus(); return; }
      if (!text.value.trim() && !photoKey && !video.value.trim()) { msg.textContent = 'Please add some text, a photo or a video link.'; msg.setAttribute('data-kind', 'error'); text.focus(); return; }
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
          el('p', { class: 'hf-drop-statement', style: 'font-size:26px', text: 'Thank you for sharing.' }),
          el('p', { text: 'Your story is waiting for a quick review. We will email you when it is on the site.' }),
          el('p', null, [el('a', { class: 'hf-button-light', href: '/action/' + slug, text: 'Back to the action' })]),
        ]));
      } else if (rr.status === 401) {
        HFB.requireSignIn({ kind: 'return', returnTo: back });
      } else { msg.textContent = msgOf(rr); msg.setAttribute('data-kind', 'error'); }
    });
    note.innerHTML = '';
    wrap.parentNode.insertBefore(form, wrap);
    wrap.remove();
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
      if (!r.ok) { titleEl.textContent = 'This invite link is not valid'; actionEl.textContent = 'Ask the person who sent it for a new link, or find an action yourself.'; descEl.textContent = ''; inBtn.textContent = 'Find an action'; inBtn.href = '/actions'; return; }
      var v = r.data;
      var who = v.inviterName || 'Someone';
      if (!v.action.live) {
        titleEl.textContent = 'This action is no longer available';
        actionEl.textContent = v.action.title ? '"' + v.action.title + '" has been taken off the site.' : '';
        descEl.textContent = 'Here are three others to try:';
        inBtn.style.display = 'none';
        var ul = el('ul', { class: 'hfp-list' });
        v.alternatives.forEach(function (a) { ul.appendChild(el('li', null, [el('a', { href: '/action/' + a.slug, text: a.title })])); });
        descEl.insertAdjacentElement('afterend', ul);
        return;
      }
      actionEl.textContent = v.action.title;
      descEl.textContent = v.action.shortAnswer;
      var link = el('a', { class: 'hf-button-light', href: '/action/' + v.action.slug, text: 'See the action' });
      if (v.me && v.me.isMine) {
        titleEl.textContent = 'This is your invite';
        inBtn.textContent = 'Share it';
        inBtn.onclick = function (e) {
          e.preventDefault();
          share({ title: document.title, text: (v.kind === 'with_me' ? who + ' wants to do this with you: ' : who + ' is passing this on to you: ') + v.action.title, url: location.origin + HFB.base + '/' + code }, noteEl);
        };
        return;
      }
      titleEl.textContent = v.kind === 'with_me' ? who + ' wants to do this with you' : who + ' is passing this on to you';
      if (v.me && v.me.joined) {
        inBtn.textContent = "You're in";
        inBtn.setAttribute('aria-disabled', 'true');
        inBtn.onclick = function (e) { e.preventDefault(); };
        noteEl.innerHTML = '';
        noteEl.appendChild(document.createTextNode(who + ' can see that you are in. Mark the action as done when you have done it. '));
        var leave = el('button', { type: 'button', class: 'hfp-link', text: 'Leave this invite' });
        leave.addEventListener('click', async function () {
          var lr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'DELETE' });
          if (lr.ok) render();
        });
        noteEl.appendChild(leave);
        if (!$('hfp-see-action')) { link.id = 'hfp-see-action'; inBtn.parentNode.appendChild(document.createTextNode(' ')); inBtn.parentNode.appendChild(link); }
        return;
      }
      inBtn.textContent = "I'm in";
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
    var more = el('button', { type: 'button', class: 'hf-button-light', text: 'More stories' });
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
    var m = /^\/drops\/([a-z0-9-]+)/.exec(location.pathname);
    await wait(function () { return window.HFB; }, 10000);
    var r = await HFB.call('/api/drops/state' + (m ? '?drop=' + m[1] : ''), { auth: false });
    if (!r.ok) return;
    var d = r.data;
    var facts = el('p', { id: 'hfp-drop-facts', class: 'hfp-muted' });
    var parts = [];
    if (d.status === 'live' && d.left !== null && d.quantity) parts.push(d.left + ' of ' + d.quantity + ' left');
    if (d.pledges && d.pledges.made > 0) parts.push(d.pledges.made + ' ' + plural(d.pledges.made, 'pledge', 'pledges') + ' made, ' + d.pledges.kept + ' kept');
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
      ol.appendChild(el('li', null, [el('a', { href: '/action/' + a.slug, text: a.title }), el('span', { class: 'hfp-muted', text: ' · ' + a.people.toLocaleString() + ' people' })]));
    });
    var box = el('section', { id: 'hfp-most-done', 'aria-labelledby': 'hfp-most-done-h' }, [el('h2', { id: 'hfp-most-done-h', text: 'Most done' }), ol]);
    var footer = document.querySelector('footer');
    footer ? footer.parentNode.insertBefore(box, footer) : document.body.appendChild(box);
  }

  function start() {
    // Pages that had their own embed code switch over once that code is
    // replaced in Webflow by the marker <div data-hf-pages hidden></div>.
    var marked = !!document.querySelector('[data-hf-pages]');
    var parts = [invitePage, storiesPage, dropHero, mostDone];
    if (marked) parts.push(actionPage, accountPage, suggestPage, storyPage);
    parts.forEach(function (f) {
      try { var p = f(); if (p && p.catch) p.catch(function (e) { console.error('[hf-pages]', e); }); } catch (e) { console.error('[hf-pages]', e); }
    });
    try { storyItemPage(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
