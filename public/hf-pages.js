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
    // Only change what needs changing: a no-op change (e.g. removing a class that is not there) still
    // counts as a change in browsers, and would wake this watcher again, forever.
    function free() {
      if (b.disabled && !b.getAttribute('data-hfp-busy')) b.disabled = false;
      if (b.classList.contains('w-form-loading')) b.classList.remove('w-form-loading');
    }
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
    '.hfp-muted{color:#3D434C}.hfp-small{font-size:15px}.hfp-card{background:#EEF4FA;border-radius:24px;padding:24px;margin:16px 0}.hfp-keep-title{font-size:20px;line-height:1.3;margin:24px 0 4px}.hfp-group{margin:12px 0 0;font-weight:600;color:var(--colour--deep-blue,#2E5E8E)}.hfp-proof{margin:20px 0 0}.hfp-clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:20px;margin:16px 0 32px}.hfp-clip{position:relative;aspect-ratio:9/16;border-radius:20px;overflow:hidden;background:#111418}.hfp-clip-video{display:block;width:100%;height:100%;object-fit:cover;cursor:pointer}.hfp-clip-sound{position:absolute;left:12px;bottom:12px;border:0;border-radius:999px;padding:8px 14px;background:rgba(17,20,24,.7);color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}.hfp-clip-sorry{display:none;position:absolute;inset:auto 12px 12px;margin:0;padding:10px 12px;border-radius:12px;background:rgba(17,20,24,.75);color:#fff;font-size:14px}.hfp-clip.is-broken .hfp-clip-sorry{display:block}.hfp-clip.is-broken .hfp-clip-sound{display:none}.hf-story.is-clip{max-width:420px}.hfp-video-box{margin:20px 0}.hfp-video-preview{display:block;width:min(100%,240px);aspect-ratio:9/16;object-fit:cover;border-radius:16px;margin:12px 0;background:#111418}.hfp-ripple{margin:16px 0 0}.hfp-ripple-h{margin:0 0 8px}.hfp-ripple-svg{display:block;height:auto;margin:0 auto}.hfp-ripple-dot{cursor:pointer;outline:none}.hfp-ripple-dot:focus-visible{stroke:var(--colour--ink,#111418);stroke-width:2}.hfp-ripple-caption{min-height:1.5em;text-align:center;font-weight:600;margin:8px 0 0}.hfp-proof-img{display:block;width:min(240px,60vw);aspect-ratio:9/16;border-radius:16px;margin:0 0 12px;box-shadow:0 8px 24px rgba(17,20,24,.15)}.hfp-proof-name{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-weight:500}' +
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

  // An uploaded vertical video: plays muted, looped and inline while on screen;
  // tap for sound. If the browser can't play it, the still and a short note show.
  var clipWatch = null;
  function clipPlayer(c, label) {
    var v = el('video', { class: 'hfp-clip-video', src: HFB.base + '/media/' + c.key, poster: c.poster ? HFB.base + '/media/' + c.poster : null, muted: true, loop: true, playsinline: true, preload: 'none', 'aria-label': label });
    v.muted = true;
    var sound = el('button', { type: 'button', class: 'hfp-clip-sound', text: copyText('clip-sound-on') });
    var sorry = el('p', { class: 'hfp-clip-sorry', text: copyText('clip-cant-play') });
    var box = el('div', { class: 'hfp-clip' }, [v, sound, sorry]);
    function toggle() {
      var on = v.muted;
      document.querySelectorAll('.hfp-clip-video').forEach(function (o) { if (o !== v) { o.muted = true; var b = o.parentNode.querySelector('.hfp-clip-sound'); if (b) b.textContent = copyText('clip-sound-on'); } });
      v.muted = !on;
      sound.textContent = copyText(on ? 'clip-sound-off' : 'clip-sound-on');
      if (v.paused) v.play().catch(function () {});
    }
    sound.addEventListener('click', toggle);
    v.addEventListener('click', toggle);
    v.addEventListener('error', function () { box.classList.add('is-broken'); });
    if (window.IntersectionObserver) {
      clipWatch = clipWatch || new IntersectionObserver(function (es) {
        es.forEach(function (e) { var x = e.target; if (e.isIntersecting && e.intersectionRatio >= 0.6) x.play().catch(function () {}); else x.pause(); });
      }, { threshold: [0, 0.6] });
      clipWatch.observe(v);
    }
    return box;
  }

  function storyCard(s, withAction) {
    var kids = [];
    if (s.clip) kids.push(clipPlayer(s.clip, copyText('clip-label', { title: (s.action && s.action.title) || '' })));
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
    return el('article', { class: 'hf-story' + (s.clip ? ' is-clip' : '') }, kids);
  }

  // A group's line: "3 of you are in: Ana, Ben + 1 more" (private to the group, so from 1).
  function groupLine(g) {
    if (!g) return '';
    if (g.count <= 1) return copyText('group-just-you');
    var names = g.names.join(', ') + (g.more > 0 ? ' ' + copyText('group-more', { n: g.more }) : '');
    return names ? copyText('group-names', { n: g.count, names: names }) : copyText('group-count', { n: g.count });
  }

  // ---------------------------------------------------------------------------
  // Shareable proof: a 1080 × 1920 card (Instagram Stories, TikTok), drawn in the
  // browser with the site's own fonts and colours, so a new look only means
  // changing CARD below (or the site's colour variables). No names unless the
  // person adds their first name.
  // ---------------------------------------------------------------------------
  var CARD = {
    w: 1080, h: 1920, pad: 96,
    bg: '--colour--deep-blue', ink: '--colour--white', soft: '--colour--pale-blue', accent: '--colour--brand-blue',
    display: '--font--display', body: '--font--body',
  };
  function cssVar(name, fallback) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; } catch (e) { return fallback; }
  }
  // Lines of about equal length (no long line over a short last word), never wider than `max`.
  function balanceLines(ctx, text, max) {
    var words = text.split(/\s+/);
    function wrap(width) {
      var lines = [], cur = '';
      words.forEach(function (w) {
        var t = cur ? cur + ' ' + w : w;
        if (cur && ctx.measureText(t).width > width) { lines.push(cur); cur = w; } else cur = t;
      });
      if (cur) lines.push(cur);
      return lines;
    }
    var lines = wrap(max), n = lines.length, lo = max / 3, hi = max;
    for (var i = 0; i < 12; i++) { var mid = (lo + hi) / 2; if (wrap(mid).length > n) lo = mid; else hi = mid; }
    return wrap(hi);
  }
  function drawCard(o) {
    var c = document.createElement('canvas');
    c.width = CARD.w; c.height = CARD.h;
    var x = c.getContext && c.getContext('2d');
    if (!x) return null; // no canvas (very old browser): no card
    var display = cssVar(CARD.display, 'sans-serif'), body = cssVar(CARD.body, 'sans-serif');
    var ink = cssVar(CARD.ink, '#fff'), soft = cssVar(CARD.soft, '#cfe0f2');
    x.fillStyle = cssVar(CARD.bg, '#2e5e8e');
    x.fillRect(0, 0, CARD.w, CARD.h);
    // The mark: a ring open at the bottom with a dot, as in the logo.
    var cx = CARD.pad + 56, cy = CARD.pad + 72;
    x.strokeStyle = soft; x.lineWidth = 22; x.lineCap = 'butt';
    x.beginPath(); x.arc(cx, cy, 46, Math.PI * 0.56, Math.PI * 2.44); x.stroke();
    x.fillStyle = soft; x.beginPath(); x.arc(cx, cy + 10, 16, 0, Math.PI * 2); x.fill();
    x.fillRect(cx - 4, cy + 22, 8, 36);
    x.font = '600 40px ' + body; x.textBaseline = 'middle'; x.fillText('Happiness Foundation', cx + 84, cy);
    // The line: as large as fits, balanced.
    var max = CARD.w - CARD.pad * 2, size = 132, lines;
    x.fillStyle = ink; x.textBaseline = 'alphabetic';
    do { x.font = '800 ' + size + 'px ' + display; lines = balanceLines(x, o.line, max); size -= 6; } while ((lines.length > 6 || lines.some(function (l) { return x.measureText(l).width > max; })) && size > 48);
    size += 6;
    var lh = Math.round(size * 1.06), top = 760 - (lines.length * lh) / 2 + size;
    lines.forEach(function (l, i) { x.fillText(l, CARD.pad, top + i * lh); });
    // What they did, smaller.
    if (o.title) {
      x.font = '500 46px ' + body; x.fillStyle = soft;
      var t = balanceLines(x, o.title, max).slice(0, 3);
      var ty = top + lines.length * lh + 40;
      t.forEach(function (l, i) { x.fillText(l, CARD.pad, ty + i * 60); });
    }
    // Motto and address at the foot.
    x.fillStyle = ink; x.font = '700 54px ' + display;
    balanceLines(x, copyText('card-motto'), max).forEach(function (l, i, all) { x.fillText(l, CARD.pad, CARD.h - CARD.pad - 120 - (all.length - 1 - i) * 64); });
    x.font = '600 44px ' + body; x.fillStyle = soft;
    x.fillText(copyText('card-address'), CARD.pad, CARD.h - CARD.pad - 20);
    return c;
  }
  /** The card's line for an action's "who" (card-who-<slug>), with or without a first name. */
  function cardLine(who, name) {
    var slug = who || 'any';
    var key = name ? 'card-named-' + slug : 'card-who-' + slug;
    var t = copyText(key, { name: name });
    if (t) return t;
    return name ? copyText('card-named-any', { name: name }) : copyText('card-who-any');
  }
  window.HFP = window.HFP || {};
  window.HFP.drawCard = drawCard;
  window.HFP.cardLine = cardLine;

  /** The share panel under the win: preview, "add my first name", share or download. */
  function sharePanel(where, o) {
    var old = $('hfp-proof'); if (old) old.remove();
    var box = el('div', { id: 'hfp-proof', class: 'hfp-proof' });
    var img = el('img', { class: 'hfp-proof-img', alt: '' });
    var nameBox = null;
    var msg = status();
    var blob = null;
    async function paint() {
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
      var line = cardLine(o.who, nameBox && nameBox.checked ? o.name : null);
      var c = drawCard({ line: line, title: o.title });
      if (!c) { box.style.display = 'none'; return line; }
      img.alt = line;
      img.src = c.toDataURL('image/png');
      blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
      return line;
    }
    var url = location.origin + '/action/' + o.slug + (o.ref ? '?r=' + o.ref : '');
    var go = el('button', { type: 'button', class: 'hf-button', text: copyText('card-share') });
    var save = el('a', { class: 'hf-button-light', href: '#', text: copyText('card-download'), download: 'happiness-' + o.slug + '.png' });
    go.addEventListener('click', async function () {
      var line = await paint();
      var file = blob && window.File ? new File([blob], 'happiness-' + o.slug + '.png', { type: 'image/png' }) : null;
      var data = { files: file ? [file] : [], text: copyText('card-share-text', { line: line, url: url }), url: url };
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share(data); } catch (e) {}
      } else {
        save.click();
      }
    });
    save.addEventListener('click', async function (e) {
      if (save.getAttribute('data-ready')) return;
      e.preventDefault();
      await paint();
      save.href = URL.createObjectURL(blob);
      save.setAttribute('data-ready', '1');
      save.click();
      setTimeout(function () { save.removeAttribute('data-ready'); }, 1000);
      msg.textContent = copyText('card-hint');
    });
    box.appendChild(img);
    if (o.name) {
      nameBox = el('input', { type: 'checkbox', id: 'hfp-proof-name' });
      nameBox.addEventListener('change', paint);
      box.appendChild(el('label', { class: 'hfp-proof-name', for: 'hfp-proof-name' }, [nameBox, ' ' + copyText('card-add-name')]));
    }
    var canFiles = false;
    try { canFiles = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })); } catch (e) {}
    box.appendChild(el('div', { class: 'hfp-row' }, canFiles ? [go, save] : [save]));
    if (!canFiles) msg.textContent = copyText('card-hint');
    box.appendChild(msg);
    where.appendChild(box);
    paint().catch(function () { box.style.display = 'none'; });
  }

  // ---------------------------------------------------------------------------
  // Your ripple: you in the middle, a ring per generation, a dot per action
  // done (titles only, never names). Tap or focus a dot to see the action.
  // ---------------------------------------------------------------------------
  function rippleViz(view, opts) {
    opts = opts || {};
    var SVGNS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs) { var e = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
    var rings = (view && view.rings) || [];
    var reached = (view && view.reached) || 0;
    var box = el('div', { class: 'hfp-ripple' });
    box.appendChild(el(opts.small ? 'p' : 'h2', { class: 'hfp-ripple-h', text: copyText(reached === 1 ? 'ripple-reached-one' : 'ripple-reached-many', { n: reached.toLocaleString() }) }));
    var size = 360, c = size / 2;
    // Only as big as the rings drawn, so a first ripple isn't lost in empty space.
    var reach = 36 + Math.max(rings.length, 1) * 28 + 12;
    var svg = s('svg', { viewBox: (c - reach) + ' ' + (c - reach) + ' ' + reach * 2 + ' ' + reach * 2, style: 'width:min(100%,' + Math.round(reach * 2.2) + 'px)', class: 'hfp-ripple-svg', role: 'img', 'aria-label': copyText(reached === 1 ? 'ripple-reached-one' : 'ripple-reached-many', { n: reached }) });
    var caption = el('p', { class: 'hfp-ripple-caption', 'aria-live': 'polite', text: rings.length ? copyText('ripple-tap') : '' });
    var shown = Math.max(rings.length, 1);
    for (var k = 1; k <= shown; k++) svg.appendChild(s('circle', { cx: c, cy: c, r: 36 + k * 28, fill: 'none', stroke: 'var(--colour--pale-blue, #cfe0f2)', 'stroke-width': 1.5 }));
    rings.forEach(function (ring, i) {
      var r = 36 + (i + 1) * 28, n = ring.dots.length, turn = i * 0.37;
      ring.dots.forEach(function (title, j) {
        var a = turn + (j / Math.max(n, 1)) * Math.PI * 2;
        var dot = s('circle', { cx: (c + r * Math.cos(a)).toFixed(1), cy: (c + r * Math.sin(a)).toFixed(1), r: i === 0 ? 7 : 5.5, fill: i === 0 ? 'var(--colour--deep-blue, #2e5e8e)' : i % 2 ? 'var(--colour--brand-blue, #69c)' : 'var(--colour--light-blue, #9ec0e3)', tabindex: '0', role: 'button', 'aria-label': title, class: 'hfp-ripple-dot' });
        var t = s('title'); t.textContent = title; dot.appendChild(t);
        function show() { caption.textContent = title; }
        dot.addEventListener('click', show);
        dot.addEventListener('focus', show);
        svg.appendChild(dot);
      });
    });
    svg.appendChild(s('circle', { cx: c, cy: c, r: 26, fill: 'var(--colour--deep-blue, #2e5e8e)' }));
    var you = s('text', { x: c, y: c + 5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 700 });
    you.textContent = copyText('ripple-you');
    svg.appendChild(you);
    box.appendChild(svg);
    box.appendChild(caption);
    var more = rings.map(function (r, i) { return r.marks > r.dots.length ? copyText('ripple-more', { n: (r.marks - r.dots.length).toLocaleString(), ring: i + 1 }) : ''; }).filter(Boolean);
    if (more.length) box.appendChild(el('p', { class: 'hfp-muted hfp-small', text: more.join(' · ') }));
    if (rings.length <= 1) box.appendChild(el('p', { class: 'hfp-muted', text: copyText('ripple-share-hint') }));
    return box;
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
    var group = el('p', { class: 'hfp-group', style: 'display:none' });
    var row = el('div', { class: 'hfp-row' });
    btn.parentNode.insertBefore(count, btn);
    btn.parentNode.insertBefore(row, btn);
    row.appendChild(btn);
    var save = el('button', { type: 'button', class: 'hf-button-light', 'aria-pressed': 'false', text: copyText('action-save') });
    var withMe = el('button', { type: 'button', class: 'hf-button-light', style: 'display:none', text: copyText('action-with-me') });
    var story = el('a', { class: 'hf-button-light', style: 'display:none', href: '/share-your-story?action=' + encodeURIComponent(slug), text: copyText('story-share') });
    row.appendChild(save);
    row.appendChild(withMe);
    row.insertAdjacentElement('afterend', group);
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
    // Try before sign-up: marks made signed out are kept on this device until an account keeps them.
    var keep = el('p', { class: 'hfp-muted hfp-small', style: 'display:none' });
    card.insertAdjacentElement('afterend', keep);
    function keepButtons() {
      var up = el('button', { type: 'button', class: 'hf-button', text: copyText('action-keep-signup') });
      up.addEventListener('click', function () { if (HF.signup) HF.signup(); else HF.signin(); });
      var inn = el('button', { type: 'button', class: 'hfp-link', text: copyText('action-keep-signin') });
      inn.addEventListener('click', function () { HF.signin(); });
      return el('div', { class: 'hfp-row' }, [up, inn]);
    }
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
      // Group-friendly actions: "Do this with me" comes first; "I did this" second.
      if (st.canDoWithOthers && withMe.className !== 'hf-button') {
        withMe.className = 'hf-button';
        btn.classList.remove('hf-button');
        btn.classList.add('hf-button-light');
        row.insertBefore(withMe, row.firstChild);
      }
      var g = me && me.group;
      if (g) { group.textContent = groupLine(g); group.style.display = ''; } else group.style.display = 'none';
      shareLine.style.display = st.canDoWithOthers ? '' : 'none';
      save.textContent = copyText(me && me.liked ? 'action-saved' : 'action-save');
      save.setAttribute('aria-pressed', me && me.liked ? 'true' : 'false');
      if (me && me.done) {
        btn.textContent = copyText('action-did-again');
        btn.setAttribute('aria-disabled', 'false');
        msg.textContent = copyText(me.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: me.tally });
        story.style.display = me.guest ? 'none' : '';
        story.textContent = copyText(me.story ? 'story-edit' : 'story-share');
        if (me.guest && card.style.display === 'none') {
          keep.innerHTML = '';
          keep.appendChild(document.createTextNode(copyText('action-keep-text') + ' '));
          var k = el('button', { type: 'button', class: 'hfp-link', text: copyText('action-keep-signup') });
          k.addEventListener('click', function () { if (HF.signup) HF.signup(); else HF.signin(); });
          keep.appendChild(k);
          keep.style.display = '';
        } else keep.style.display = 'none';
        undo.style.display = me.canUndo ? '' : 'none';
        if (me.doneWith && me.doneWith.length) { together.textContent = copyText('action-together', { names: me.doneWith.join(', ') }); together.style.display = ''; } else together.style.display = 'none';
      } else {
        btn.textContent = copyText('action-did');
        btn.setAttribute('aria-disabled', 'false');
        story.style.display = 'none';
        keep.style.display = 'none';
        undo.style.display = 'none';
        together.style.display = 'none';
      }
    }

    function showCard(ripple, guest, data) {
      data = data || {};
      card.innerHTML = '';
      card.appendChild(el('p', { class: 'hf-drop-label', text: copyText('action-card-label') }));
      card.appendChild(el('p', { class: 'hf-drop-statement', style: 'font-size:28px', text: copyText('action-card-headline') }));
      if (data.rippleView) card.appendChild(rippleViz(data.rippleView, { small: true }));
      else if (ripple > 0) card.appendChild(el('p', { text: copyText('ripple', { n: ripple }) }));
      // Shareable proof, anonymous unless they add their first name.
      sharePanel(card, { who: st.cardWho || data.cardWho || null, title: st.title, slug: st.slug, ref: data.refCode, name: st.me && st.me.name });
      if (guest) {
        // The win first; then a soft ask to keep it. Never a wall.
        keep.style.display = 'none';
        card.appendChild(el('h3', { class: 'hfp-keep-title', text: copyText('action-keep-title') }));
        card.appendChild(el('p', { class: 'hfp-muted', text: copyText('action-keep-text') }));
        card.appendChild(keepButtons());
        card.style.display = '';
        return;
      }
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
      var clipList = list.filter(function (s) { return s.clip; });
      if (clipList.length) {
        var grid = el('div', { class: 'hfp-clip-grid' });
        clipList.forEach(function (s) { grid.appendChild(storyCard(s, false)); });
        storiesBox.appendChild(grid);
      }
      list.filter(function (s) { return !s.clip; }).forEach(function (s) { storiesBox.appendChild(storyCard(s, false)); });
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
      busy = true;
      btn.setAttribute('aria-busy', 'true');
      // Signed out, this is saved on this device (try before sign-up).
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'POST', guest: true, headers: { 'X-HF-Ref': HFB.ref ? HFB.ref() : null } });
      busy = false;
      btn.removeAttribute('aria-busy');
      if (r.ok) {
        showCard(r.data.ripple || 0, r.data.guest, r.data);
        window.dispatchEvent(new Event('hf-done'));
        await load();
      } else if (r.status === 401) ask('done');
      else msg.textContent = msgOf(r);
    });

    undo.addEventListener('click', async function () {
      if (!id) return;
      undo.disabled = true;
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'DELETE' });
      undo.disabled = false;
      if (r.ok) {
        card.style.display = 'none';
        keep.style.display = 'none';
        await load();
        // The message tells the new total (none left: just "Undone.").
        var n = r.data && r.data.tally;
        var left = n ? copyText(n === 1 ? 'action-tally-one' : 'action-tally-many', { n: n }) : '';
        msg.textContent = copyText('action-undone', { message: left }).trim();
      }
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
    // Back from sharing an invite: the group may have grown.
    document.addEventListener('visibilitychange', function () { if (!document.hidden && id) load(); });
    await load();
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------
  // An extra account section, drawn as the same card as the Webflow ones.
  function section(title, kids, id) { return el('div', { class: 'hf-acct-card', id: id || null }, [el('h2', { class: 'hf-acct-card-title', text: title })].concat(kids)); }

  // Account sections open and close (the title is the switch). The impact card
  // stays open. Defaults put what needs doing first; a section someone opens or
  // closes stays that way on this device. The jump links open what they point to.
  var FOLD_KEY = 'hfp_acct_open';
  function foldPrefs() { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function setFold(card, open, remember) {
    if (open) card.removeAttribute('data-hf-closed'); else card.setAttribute('data-hf-closed', '');
    var b = card.querySelector('.hfp-fold');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (remember && card.id) { var p = foldPrefs(); p[card.id] = open; try { localStorage.setItem(FOLD_KEY, JSON.stringify(p)); } catch (e) {} }
  }
  function foldSections(me) {
    var root = $('hf-acct-in');
    if (!root) return;
    var openPledges = (me.pledges || []).filter(function (p) { return p.status !== 'kept'; }).length;
    var acted = {};
    (me.done || []).forEach(function (d) { acted[d.actionId] = 1; });
    var counts = {
      'acct-pledges': openPledges ? copyText('acct-fold-to-keep', { n: openPledges }) : '',
      'acct-saved': me.saved && me.saved.length ? String(me.saved.length) : '',
      'acct-actions': Object.keys(acted).length ? String(Object.keys(acted).length) : '',
      'acct-joined': me.joinedMyInvites && me.joinedMyInvites.length ? String(me.joinedMyInvites.length) : '',
      'acct-invited': me.invitesIJoined && me.invitesIJoined.length ? String(me.invitesIJoined.length) : '',
    };
    var opens = { 'acct-pledges': openPledges > 0, 'acct-saved': true, 'acct-actions': true, 'acct-joined': true, 'acct-invited': false, 'hfp-settings': false, 'acct-data': false };
    var prefs = foldPrefs();
    root.querySelectorAll('.hf-acct-card').forEach(function (card) {
      var h = card.querySelector('.hf-acct-card-title');
      if (!h || !card.id) return;
      var count = card.querySelector('.hfp-fold-count');
      if (!card.getAttribute('data-hfp-fold')) {
        card.setAttribute('data-hfp-fold', '1');
        var b = el('button', { type: 'button', class: 'hfp-fold', 'aria-expanded': 'true' });
        while (h.firstChild) b.appendChild(h.firstChild);
        count = el('span', { class: 'hfp-fold-count' });
        b.appendChild(count);
        h.appendChild(b);
        b.addEventListener('click', function () { setFold(card, card.hasAttribute('data-hf-closed'), true); });
        setFold(card, card.id in prefs ? !!prefs[card.id] : card.id in opens ? opens[card.id] : true, false);
      }
      count.textContent = counts[card.id] || '';
    });
  }
  // A jump link (or an address ending in #section) opens the section it points to.
  function openFromLink(hash) {
    var card = hash && hash.length > 1 ? document.getElementById(hash.slice(1)) : null;
    if (card && card.classList.contains('hf-acct-card')) setFold(card, true, true);
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (a) openFromLink(a.getAttribute('href'));
  });

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
    if (early) { showIn(); renderAccount(early); foldSections(early); openFromLink(location.hash); }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (si) si.addEventListener('click', function (e) { e.preventDefault(); HF.signin(); });
    var jn = $('hf-join');
    if (jn) jn.addEventListener('click', function (e) { e.preventDefault(); if (HF.signup) HF.signup(); else HF.signin(); });
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
    foldSections(r.data);
    openFromLink(location.hash);
  }

  // Profile photo (Account > Settings): kept on the member in Memberstack, shown in the header avatar.
  var PHOTO_MAX = 5 * 1024 * 1024;
  function photoRow() {
    var add = $('hfp-photo');
    var remove = $('hfp-photo-remove');
    if (!add || add.getAttribute('data-hfp')) return;
    add.setAttribute('data-hfp', '1');
    var msg = function (t) { var m = $('hfp-settings-msg'); if (m) m.textContent = t; };
    var showRemove = function (m) { if (remove) { if (m && m.profileImage) remove.setAttribute('data-hf-on', '1'); else remove.removeAttribute('data-hf-on'); } };
    window.addEventListener('hf-member', function (e) { showRemove(e.detail); });
    var picked = function (m) { if (m) window.dispatchEvent(new CustomEvent('hf-member', { detail: m })); };
    var input = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    add.parentNode.appendChild(input);
    add.addEventListener('click', function (e) { e.preventDefault(); input.click(); });
    var ms = function () { return window.$memberstackDom; };
    input.addEventListener('change', async function () {
      var f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { msg(copyText('photo-not-image')); return; }
      if (f.size > PHOTO_MAX) { msg(copyText('photo-too-big')); return; }
      msg(copyText('photo-saving'));
      try {
        await ms().updateMemberProfileImage({ profileImage: f });
        var r = await ms().getCurrentMember();
        picked(r && r.data);
        msg(copyText('photo-saved'));
      } catch (e) { msg(copyText('photo-failed')); }
    });
    if (remove) remove.addEventListener('click', async function (e) {
      e.preventDefault();
      try {
        await ms().deleteMemberProfileImage();
        var r = await ms().getCurrentMember();
        picked(r && r.data);
        msg(copyText('photo-removed'));
      } catch (er) { msg(copyText('photo-failed')); }
    });
  }

  // Home area (Account > Settings): the same list as the header picker, with "No home area" first.
  function homeAreaRow(me) {
    var sel = $('hfp-home-area');
    var loc = $('hf-loc');
    if (!sel || !loc) return;
    if (!sel.getAttribute('data-hfp')) {
      sel.setAttribute('data-hfp', '1');
      sel.innerHTML = loc.innerHTML;
      if (sel.options[0] && !sel.options[0].value) sel.options[0].text = copyText('acct-no-home-area');
      sel.addEventListener('change', async function () {
        var msg = $('hfp-settings-msg');
        var rr = await HFB.call('/api/me/settings', { method: 'PATCH', body: { homeArea: sel.value || null } });
        if (msg) msg.textContent = rr.ok ? copyText('saved') : msgOf(rr);
        if (rr.ok) setLocation(sel.value, true);
      });
    }
    sel.value = me.homeArea || '';
    // A location picked before signing in becomes the home area the first time.
    var local = '';
    try { local = localStorage.getItem('hf_loc') || ''; } catch (e) {}
    if (!me.homeArea && local && window.HFB) { sel.value = local; saveHomeArea(local); }
  }

  function renderAccount(me) {
    photoRow();
    homeAreaRow(me);
    var inn = $('hf-acct-in');
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || copyText('acct-there');
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var tally = $('hf-tally');
    // Your ripple: the picture goes right under the impact numbers.
    if (me.rippleView) {
      var oldViz = $('hfp-ripple-viz');
      var viz = rippleViz(me.rippleView);
      viz.id = 'hfp-ripple-viz';
      viz.classList.add('hf-acct-card');
      var impact = document.querySelector('#hf-acct-in .hf-acct-impact');
      if (oldViz) oldViz.replaceWith(viz);
      else if (impact) impact.insertAdjacentElement('afterend', viz);
    }
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
        holder.insertBefore(section(copyText('acct-saved-h'), [sv], 'acct-saved'), card === ah ? ah.previousElementSibling : card);
      }
      // Invites
      {
        var inv = el('div', { id: 'hfp-invites' });
        if (me.joinedMyInvites.length) {
          var j = el('ul', { class: 'hfp-list' });
          me.joinedMyInvites.forEach(function (x) { j.appendChild(el('li', { class: 'hfp-item', text: copyText('acct-joined', { name: x.name || copyText('acct-someone'), action: x.actionTitle || '', date: day(x.joinedAt) }) })); });
          inv.appendChild(section(copyText('acct-joined-h'), [j], 'acct-joined'));
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
          inv.appendChild(section(copyText('acct-invited-h'), [k], 'acct-invited'));
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

    // Video: checked here first (vertical, 15–30 seconds, at most 100 MB), then
    // uploaded in parts; a dropped part is retried, and "Try again" picks up
    // where it stopped. The backend checks the file again.
    var vid = { key: s.videoKey || null, poster: s.posterKey || null, busy: false, isNew: false, up: null };
    var vInput = el('input', { type: 'file', id: 'hfp-video-file', accept: 'video/mp4,video/quicktime,video/*', class: 'hfp-file' });
    var vMsg = status('hfp-status hfp-small');
    var vPrev = el('video', { class: 'hfp-video-preview', controls: true, playsinline: true, muted: true, preload: 'metadata', style: vid.key ? '' : 'display:none', src: vid.key ? HFB.base + '/media/' + vid.key : null, poster: vid.poster ? HFB.base + '/media/' + vid.poster : null });
    var vRetry = el('button', { type: 'button', class: 'hf-button-light', style: 'display:none', text: copyText('st-video-retry') });
    var vRemove = el('button', { type: 'button', class: 'hfp-link hfp-small', style: vid.key ? '' : 'display:none', text: copyText('st-video-remove') });
    var vConsent = el('input', { type: 'checkbox', id: 'hfp-video-consent' });
    var vKidsYes = el('input', { type: 'radio', name: 'hfp-video-kids', id: 'hfp-video-kids-yes', value: 'yes', checked: s.hasChildren === 1 });
    var vKidsNo = el('input', { type: 'radio', name: 'hfp-video-kids', id: 'hfp-video-kids-no', value: 'no', checked: s.hasChildren === 0 });
    var vAsk = el('div', { class: 'hfp-video-ask', style: vid.key ? '' : 'display:none' }, [
      el('div', { class: 'hfp-check' }, [vConsent, el('label', { for: 'hfp-video-consent', text: copyText('st-video-consent') })]),
      el('fieldset', { class: 'hfp-field', style: 'border:0;padding:0;margin:12px 0 0' }, [
        el('legend', { class: 'hf-form-label', text: copyText('st-video-children') }),
        el('div', { class: 'hfp-check' }, [vKidsYes, el('label', { for: 'hfp-video-kids-yes', text: copyText('st-yes') })]),
        el('div', { class: 'hfp-check' }, [vKidsNo, el('label', { for: 'hfp-video-kids-no', text: copyText('st-no') })]),
      ]),
    ]);
    var vBox = el('div', { class: 'hfp-field hfp-video-box' }, [
      el('label', { for: 'hfp-video-file', class: 'hf-form-label', text: copyText('st-video-label') }),
      el('p', { class: 'hf-form-help hfp-small', text: copyText('st-video-hint') }),
      vInput, vMsg, vPrev, el('div', { class: 'hfp-row' }, [vRetry, vRemove]), vAsk,
    ]);
    var vAnchor = (video && video.closest('.hf-field-group, .hfp-field, div')) || area;
    if (vAnchor) vAnchor.insertAdjacentElement('afterend', vBox); else form.insertBefore(vBox, form.firstChild);
    function vSay(t, bad) { vMsg.textContent = t; if (bad) vMsg.setAttribute('data-kind', 'error'); else vMsg.removeAttribute('data-kind'); }
    function meta(file) {
      return new Promise(function (resolve) {
        var t = el('video', { preload: 'metadata', muted: true, playsinline: true });
        var url = URL.createObjectURL(file), finished = false;
        function end(v) { if (finished) return; finished = true; resolve(v); }
        t.onloadedmetadata = function () { end({ el: t, url: url, seconds: t.duration, w: t.videoWidth, h: t.videoHeight }); };
        t.onerror = function () { end({ el: null, url: url, seconds: NaN, w: 0, h: 0 }); };
        setTimeout(function () { end({ el: null, url: url, seconds: NaN, w: 0, h: 0 }); }, 10000);
        t.src = url;
      });
    }
    function posterOf(m) {
      return new Promise(function (resolve) {
        if (!m.el || !m.w) return resolve(null);
        var done2 = false;
        m.el.onseeked = function () {
          if (done2) return; done2 = true;
          try {
            var c = document.createElement('canvas'), k = Math.min(1, 720 / m.w);
            c.width = Math.round(m.w * k); c.height = Math.round(m.h * k);
            c.getContext('2d').drawImage(m.el, 0, 0, c.width, c.height);
            c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.82);
          } catch (e) { resolve(null); }
        };
        setTimeout(function () { if (!done2) { done2 = true; resolve(null); } }, 8000);
        m.el.currentTime = Math.min(1, (m.seconds || 2) / 2);
      });
    }
    async function sendParts() {
      var up = vid.up, tok = await HFB.token();
      for (var n = 1; n <= up.parts; n++) {
        if (up.done[n]) continue;
        var start = (n - 1) * up.partSize, chunk = up.file.slice(start, Math.min(start + up.partSize, up.file.size)), ok = false;
        for (var tries = 0; tries < 4 && !ok; tries++) {
          if (tries) await new Promise(function (r2) { setTimeout(r2, 1000 * tries * tries); });
          try {
            var res = await fetch(HFB.base + '/api/stories/video/part?u=' + encodeURIComponent(up.uploadId) + '&n=' + n, { method: 'PUT', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/octet-stream' }, body: chunk });
            if (res.ok) { up.done[n] = (await res.json()).etag; ok = true; }
            else if (res.status < 500 && res.status !== 429) { var d0 = null; try { d0 = await res.json(); } catch (e) {} throw new Error((d0 && d0.message) || copyText('err-video-upload-gone')); }
          } catch (e) { if (e && e.message && !/fetch|network|load/i.test(e.message)) throw e; }
        }
        if (!ok) return false;
        vSay(copyText('st-video-uploading', { n: Math.round((n / up.parts) * 100) }));
      }
      return true;
    }
    async function finishUpload() {
      vid.busy = true; vRetry.style.display = 'none';
      try {
        if (!(await sendParts())) { vSay(copyText('st-video-stopped'), true); vRetry.style.display = ''; return; }
        var parts = Object.keys(vid.up.done).map(function (k) { return { partNumber: Number(k), etag: vid.up.done[k] }; });
        var c = await HFB.call('/api/stories/video/complete', { method: 'POST', body: { uploadId: vid.up.uploadId, parts: parts } });
        if (!c.ok) { vSay(msgOf(c), true); vid.up = null; vInput.value = ''; vPrev.style.display = 'none'; vAsk.style.display = 'none'; return; }
        vid.key = c.data.videoKey; vid.isNew = true; vid.up = null;
        vSay(copyText('st-video-added'));
        vRemove.style.display = '';
      } catch (e) {
        vSay((e && e.message) || copyText('st-video-stopped'), true); vRetry.style.display = '';
      } finally { vid.busy = false; }
    }
    vRetry.addEventListener('click', function () { if (vid.up) finishUpload(); });
    vRemove.addEventListener('click', function () {
      vid.key = null; vid.poster = null; vid.isNew = true; vid.up = null;
      vPrev.removeAttribute('src'); vPrev.style.display = 'none'; vRemove.style.display = 'none'; vAsk.style.display = 'none'; vInput.value = '';
      vSay(copyText('st-video-removed'));
    });
    vInput.addEventListener('change', async function () {
      var file = vInput.files && vInput.files[0];
      if (!file) return;
      vRetry.style.display = 'none';
      var type = /\.mov$/i.test(file.name) || file.type === 'video/quicktime' ? 'video/quicktime' : file.type === 'video/mp4' || /\.mp4$/i.test(file.name) ? 'video/mp4' : '';
      if (!type) return vSay(copyText('err-video-type'), true);
      if (file.size > 100 * 1024 * 1024) return vSay(copyText('err-video-too-large'), true);
      vSay(copyText('st-video-checking'));
      var m = await meta(file);
      // Checked here before anything is uploaded (the backend checks again).
      if (m.seconds && isFinite(m.seconds)) {
        if (m.seconds < 14.5) return vSay(copyText('err-video-too-short'), true);
        if (m.seconds > 30.99) return vSay(copyText('err-video-too-long'), true);
      }
      if (m.w && m.h && m.h <= m.w) return vSay(copyText('err-video-not-vertical'), true);
      vPrev.src = m.url; vPrev.removeAttribute('poster'); vPrev.style.display = '';
      vAsk.style.display = ''; vConsent.checked = false; vKidsYes.checked = vKidsNo.checked = false;
      vid.key = null; vid.poster = null;
      var still = await posterOf(m);
      if (still) {
        try {
          var tok = await HFB.token();
          var pr = await fetch(HFB.base + '/api/stories/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg' }, body: still });
          if (pr.ok) vid.poster = (await pr.json()).photoKey;
        } catch (e) {}
      }
      var st0 = await HFB.call('/api/stories/video/start', { method: 'POST', body: { size: file.size, type: type } });
      if (!st0.ok) return vSay(msgOf(st0), true);
      vid.up = { file: file, uploadId: st0.data.uploadId, partSize: st0.data.partSize, parts: st0.data.parts, done: {} };
      vSay(copyText('st-video-uploading', { n: 0 }));
      finishUpload();
    });

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
      if (vid.busy || vid.up) { msg.textContent = copyText('st-video-wait'); msg.setAttribute('data-kind', 'error'); return; }
      if (vid.key && vid.isNew && !vConsent.checked) { msg.textContent = copyText('err-video-consent'); msg.setAttribute('data-kind', 'error'); vConsent.focus(); return; }
      if (vid.key && !vKidsYes.checked && !vKidsNo.checked) { msg.textContent = copyText('err-video-children'); msg.setAttribute('data-kind', 'error'); vKidsYes.focus(); return; }
      if (!words.trim() && !photoKey && !link.trim() && !vid.key) { msg.textContent = copyText('st-empty'); msg.setAttribute('data-kind', 'error'); text && text.focus(); return; }
      if (submit) { submit.setAttribute('data-hfp-busy', '1'); submit.disabled = true; }
      var body = {
        actionId: slug,
        text: words,
        photoKey: photoKey,
        photoDescription: desc ? desc.value : '',
        videoUrl: link,
        showName: showName ? showName.checked : true,
        consent: true,
        childrenInVideo: vid.key ? vKidsYes.checked : undefined,
        withMemberIds: withBoxes.filter(function (b) { return b.checked; }).map(function (b) { return Number(b.value); }),
      };
      if (vid.isNew) { body.videoKey = vid.key; body.posterKey = vid.poster; body.videoConsent = vConsent.checked; }
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
      var groupEl = $('hfp-invite-group');
      if (!groupEl) { groupEl = el('p', { id: 'hfp-invite-group', class: 'hfp-group' }); descEl.insertAdjacentElement('afterend', groupEl); }
      groupEl.textContent = v.group ? groupLine(v.group) : '';
      groupEl.style.display = v.group ? '' : 'none';
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
      async function join(firstName) {
        var jr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'POST', guest: true, body: firstName ? { firstName: firstName } : {} });
        if (jr.ok || (jr.data && jr.data.error === 'own_invite')) { var f = $('hfp-join-name'); if (f) { f.style.display = 'none'; try { f.remove(); } catch (x) {} } render(); return true; }
        noteEl.textContent = msgOf(jr);
        return false;
      }
      inBtn.onclick = async function (e) {
        e.preventDefault();
        if (signedIn()) return join();
        // No account needed: just a first name, so the group can see who joined.
        if ($('hfp-join-name')) { $('hfp-join-first').focus(); return; }
        var form = el('form', { id: 'hfp-join-name', class: 'hfp-card' });
        var input = el('input', { class: 'hf-form-input w-input', id: 'hfp-join-first', autocomplete: 'given-name', maxlength: '40', required: true });
        form.appendChild(el('label', { for: 'hfp-join-first', class: 'hf-form-label', text: copyText('join-name-label') }));
        form.appendChild(input);
        form.appendChild(el('button', { type: 'submit', class: 'hf-button', text: copyText('inv-join') }));
        form.appendChild(el('p', { class: 'hfp-muted hfp-small', text: copyText('join-name-help') }));
        form.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          if (!input.value.trim()) return input.focus();
          await join(input.value);
        });
        inBtn.parentNode.insertAdjacentElement('afterend', form);
        input.focus();
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
    var rv = await HFB.call('/api/stories?videos=1', { auth: false });
    var clips = rv.ok ? rv.data.stories : [];
    var r = await HFB.call('/api/stories?page=1&videos=0', { auth: false });
    if (!r.ok || (!r.data.stories.length && !clips.length)) return;
    var box = el('div', { id: 'hfp-stories' });
    if (clips.length) {
      var grid = el('div', { class: 'hfp-clip-grid' });
      clips.forEach(function (s) { grid.appendChild(storyCard(s, true)); });
      box.appendChild(el('section', { 'aria-labelledby': 'hfp-clips-h' }, [el('h2', { id: 'hfp-clips-h', text: copyText('stories-videos-h') }), grid]));
    }
    var more = el('button', { type: 'button', class: 'hf-button-light', text: copyText('stories-more') });
    var page = 1;
    function add(list) { list.forEach(function (s) { box.appendChild(storyCard(s, true)); }); more.style.display = list.length === 20 ? '' : 'none'; }
    add(r.data.stories);
    more.addEventListener('click', async function () {
      page++;
      var rr = await HFB.call('/api/stories?videos=0&page=' + page, { auth: false });
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
  // ---------------------------------------------------------------------------
  // Header. Built in Webflow: parts marked data-hf-auth="out" (Sign in, Join free, the phone's account
  // icon) or "in" (avatar, the phone's location pin) show by sign-in state, through html.hf-in (set by
  // the site head before the first paint; corrected here once Memberstack has loaded). The avatar
  // shows the member's Memberstack profile photo, or the first letter of their first name (or email).
  // ---------------------------------------------------------------------------
  function memberSaved() { try { return JSON.parse(localStorage.getItem('_ms-mem') || 'null'); } catch (e) { return null; } }
  function avatarFill(m) {
    if (!m) return;
    var first = (m.customFields && m.customFields['first-name']) || '';
    var email = (m.auth && m.auth.email) || m.email || '';
    var initial = String(first || email).trim().charAt(0).toUpperCase();
    document.querySelectorAll('.hf-nav-avatar, [data-hf-avatar]').forEach(function (a) {
      var s = a.querySelector('[data-hf-fill="avatar-initial"]');
      if (s) s.textContent = initial;
      if (m.profileImage) {
        a.style.backgroundImage = 'url("' + String(m.profileImage).replace(/["\\]/g, '') + '")';
        a.setAttribute('data-hf-photo', '1');
      } else {
        a.style.backgroundImage = '';
        a.removeAttribute('data-hf-photo');
      }
    });
  }
  window.addEventListener('hf-member', function (e) { avatarFill(e.detail); });

  function headerAccount() {
    var root = document.documentElement;
    if (root.getAttribute('data-hfp-header')) return;
    root.setAttribute('data-hfp-header', '1');
    if (root.classList.contains('hf-in')) avatarFill(memberSaved());
    document.querySelectorAll('.hf-nav-signin').forEach(function (si) {
      si.addEventListener('click', function (e) {
        if (!window.HFP || !window.HFP.auth || signedIn()) return;
        e.preventDefault();
        window.HFP.auth('signin');
      });
    });
    document.querySelectorAll('.hf-nav-cta').forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (!window.HFP || !window.HFP.auth || signedIn()) return;
        e.preventDefault();
        window.HFP.auth('signup');
      });
    });
    // The phone's location pin: an invisible copy of the location picker over the icon.
    var loc = $('hf-loc');
    document.querySelectorAll('.hf-loc-mini').forEach(function (mini) {
      if (!loc) return;
      mini.innerHTML = loc.innerHTML;
      mini.value = loc.value;
      mini.addEventListener('change', function () {
        loc.value = mini.value;
        loc.dispatchEvent(new Event('change'));
      });
      loc.addEventListener('change', function () { mini.value = loc.value; });
    });
    // Once sign-in has loaded: the real state, and the member's latest name and photo.
    wait(function () { return !!window.$memberstackDom || !document.querySelector('script[data-memberstack-app]'); }, 8000).then(async function () {
      if (!signedIn()) { root.classList.remove('hf-in'); return; }
      root.classList.add('hf-in');
      var ms = window.$memberstackDom;
      if (!ms || !ms.getCurrentMember) return;
      try { var r = await ms.getCurrentMember(); if (r && r.data) window.dispatchEvent(new CustomEvent('hf-member', { detail: r.data })); } catch (e) {}
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

  /**
   * The location picker remembers its choice on this device, and a signed-in member's choice is
   * also their "Home area" on their account (so a new device picks it up). Changing it in
   * My account > Settings changes the picker too.
   */
  var locFromAccount = false;
  var locSaveTimer = null;
  function saveHomeArea(v) {
    clearTimeout(locSaveTimer);
    locSaveTimer = setTimeout(function () {
      if (window.HFB && signedIn()) HFB.call('/api/me/settings', { method: 'PATCH', body: { homeArea: v || null } });
    }, 500);
  }
  function setLocation(v, fromAccount) {
    var s = $('hf-loc');
    if (!s) return;
    locFromAccount = !!fromAccount;
    s.value = v || '';
    s.dispatchEvent(new Event('change'));
    locFromAccount = false;
  }
  function rememberLocation() {
    var s = $('hf-loc');
    if (!s || s.getAttribute('data-hfp')) return;
    s.setAttribute('data-hfp', '1');
    var saved = null;
    try { saved = localStorage.getItem('hf_loc'); s.value = saved || ''; } catch (e) {}
    s.addEventListener('change', function () {
      try { localStorage.setItem('hf_loc', s.value); } catch (e) {}
      window.dispatchEvent(new Event('hf-loc'));
      fitSelect(s);
      showLocation(s);
      if (!locFromAccount) saveHomeArea(s.value);
    });
    // A device with no location yet takes the member's home area.
    if (saved === null) {
      wait(function () { return window.HF && window.HFB && (window.$memberstackDom || !document.querySelector('script[data-memberstack-app]')); }, 8000).then(async function () {
        if (!signedIn()) return;
        var r = await HFB.call('/api/me/home-area');
        if (r.ok && r.data.homeArea && [].some.call(s.options, function (o) { return o.value === r.data.homeArea; })) setLocation(r.data.homeArea, true);
      });
    }
    fitSelect(s);
    // Desktop: a Webflow dropdown in the site's style; each option (data-hf-loc) sets the picker above.
    document.querySelectorAll('[data-hf-loc]').forEach(function (o) {
      o.addEventListener('click', function (e) {
        e.preventDefault();
        var v = o.getAttribute('data-hf-loc');
        s.value = v === 'all' ? '' : v;
        s.dispatchEvent(new Event('change'));
        var dd = o.closest('.w-dropdown');
        if (dd && window.jQuery) window.jQuery(dd).triggerHandler('w-close.w-dropdown');
      });
    });
    showLocation(s);
  }
  function showLocation(s) {
    var o = s.options[s.selectedIndex];
    document.querySelectorAll('[data-hf-fill="loc-label"]').forEach(function (l) { if (o) l.textContent = o.text; });
    document.querySelectorAll('[data-hf-loc]').forEach(function (x) {
      var v = x.getAttribute('data-hf-loc');
      x.setAttribute('aria-selected', String((v === 'all' ? '' : v) === s.value));
    });
  }

  // The picker hugs the chosen location so its arrow sits right after the text. Browsers with CSS
  // field-sizing (set in Webflow) do it themselves; for the others this measures the chosen text.
  function fitSelect(s) {
    try {
      if (window.CSS && CSS.supports && CSS.supports('field-sizing', 'content')) return;
      var o = s.options[s.selectedIndex];
      if (!o) return;
      var cs = getComputedStyle(s);
      var c = fitSelect.c || (fitSelect.c = document.createElement('canvas'));
      var ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      var w = ctx.measureText(o.text).width + parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0) + 4;
      s.style.width = Math.ceil(w) + 'px';
    } catch (e) {}
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

  // ---------------------------------------------------------------------------
  // Weekly dare: the home page block (#hf-dare) and the line on the dare's own
  // action page (#hf-dare-tag), both built in Webflow and hidden until filled.
  // The count refreshes every 45 seconds while the page is in view, and when
  // the visitor comes back to it or marks "I did this".
  // ---------------------------------------------------------------------------
  async function weeklyDare() {
    var home = $('hf-dare');
    var tag = $('hf-dare-tag');
    if (!home && !tag) return;
    await wait(function () { return window.HFB; }, 10000);
    // Set in place (not removed when empty), so later refreshes can fill it again.
    function put(root, key, t) { var e = slot(root, key); if (e) e.textContent = t; }
    async function refresh() {
      var r = await HFB.call('/api/dare');
      if (!r.ok || !r.data) return;
      var d = r.data.dare;
      var line = d ? (d.count ? copyText('dare-count', { n: d.count.toLocaleString() }) : copyText('dare-first')) : '';
      if (home) {
        if (!d) home.removeAttribute('data-hf-on');
        else {
          put(home, 'dare-title', d.title);
          put(home, 'dare-short', d.shortAnswer || '');
          put(home, 'dare-count', line);
          var link = $('hf-dare-link');
          if (link) link.setAttribute('href', '/action/' + d.slug);
          turnOn(home);
        }
      }
      if (tag) {
        if (d && d.slug === slugFromPath()) { put(tag, 'dare-count', line); turnOn(tag); }
        else tag.removeAttribute('data-hf-on');
      }
    }
    await refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, 45000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('hf-done', refresh);
  }

  function start() {
    // Pages that had their own embed code switch over once that code is
    // replaced in Webflow by the marker <div data-hf-pages hidden></div>.
    var marked = !!document.querySelector('[data-hf-pages]');
    var parts = [emptyLists, shorterAlsoFits, rememberLocation, headerAccount, impactNumbers, claimPage, invitePage, storiesPage, mostDone, weeklyDare];
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
