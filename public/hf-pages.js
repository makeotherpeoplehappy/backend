/*
 * Make Other People Happy: page features, loaded by /join/hf-backend.js on every
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
  function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function signedIn() { return !!(window.HF && HF.token && HF.token()); }
  function wait(test, ms) {
    return new Promise(function (r) { var t0 = Date.now(); (function c() { if (test()) return r(true); if (Date.now() - t0 > ms) return r(false); setTimeout(c, 50); })(); });
  }
  function slugFromPath() { return location.pathname.split('/').filter(Boolean).pop() || ''; }
  function msgOf(r, fallback) { return (r && r.data && r.data.message) || fallback || copyText('error-something'); }

  // A few styles for the parts this script adds; everything else uses the site's classes.
  // No styles live in this script: every look is a Webflow class (states such as
  // is-disabled, is-error and is-open are Webflow combo classes), and the few
  // rules Webflow cannot express are in site.css.

  // ---------------------------------------------------------------------------
  // Native parts. Everything visible is built in Webflow; this script only
  // fills it in and shows or hides it:
  //   [data-hf-show="x"]  hidden until turned on (data-hf-on)
  //   [data-hf-fill="x"]  receives text
  //   [data-hf-act="x"]   a button or link this script handles
  //   [data-hf-slot="x"]  a holder for drawn or loaded content (a picture, a video)
  //   [data-hf-template]  a hidden design the script copies for each item (stories)
  // ---------------------------------------------------------------------------
  /** Typed text is not kept once you leave a page (earlier drafts on this page are removed too). */
  function forgetDrafts() {
    try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('hfb_draft:' + location.pathname) === 0) localStorage.removeItem(k); }); } catch (e) {}
  }
  /** Empties a form when you leave the page, so going back shows it fresh (Safari refills forms on Back). */
  function clearOnLeave(form) {
    form.reset();
    if (document.readyState !== 'complete') window.addEventListener('load', function () { form.reset(); });
    window.addEventListener('pagehide', function () { form.reset(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) form.reset(); });
  }
  function partsOf(root) {
    var P = {
      root: root,
      all: function (sel) { return [].slice.call(root.querySelectorAll(sel)); },
      one: function (sel) { return root.querySelector(sel); },
      show: function (key, on) { P.all('[data-hf-show="' + key + '"]').forEach(function (e) { if (on) e.setAttribute('data-hf-on', '1'); else e.removeAttribute('data-hf-on'); }); },
      fill: function (key, t) { P.all('[data-hf-fill="' + key + '"]').forEach(function (e) { e.textContent = t == null ? '' : t; }); },
      acts: function (name) { return P.all('[data-hf-act="' + name + '"]'); },
      on: function (name, fn) { P.acts(name).forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); fn(b, e); }); }); },
      slot: function (name) { return P.one('[data-hf-slot="' + name + '"]'); },
    };
    return P;
  }
  /** A Webflow form sent by this script (to the backend), never to Webflow's own form handling. */
  function nativeForm(form, onSubmit) {
    if (!form || form.getAttribute('data-hfp')) return;
    form.setAttribute('data-hfp', '1');
    freeSubmit(form);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      onSubmit(e);
    }, true);
  }
  function setBusy(b, busy) {
    if (!b) return;
    if (busy) { b.setAttribute('aria-busy', 'true'); b.classList.add('is-disabled'); } else { b.removeAttribute('aria-busy'); b.classList.remove('is-disabled'); }
  }
  function say(el2, text, bad) {
    if (!el2) return;
    el2.textContent = text || '';
    el2.classList.toggle('is-error', !!bad);
  }

  // ---------------------------------------------------------------------------
  // Sharing: the phone's own share sheet, or copy the link on a computer.
  // ---------------------------------------------------------------------------
  async function share(data, note) {
    if (navigator.share) {
      try { await navigator.share(data); return true; } catch (e) { if (e && e.name === 'AbortError') return false; }
    }
    try {
      await navigator.clipboard.writeText(data.url);
      if (note) say(note, copyText('share-copied'));
    } catch (e) {
      if (note) say(note, data.url);
    }
    return true;
  }

  function drop(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }

  // ---------------------------------------------------------------------------
  // Stories: each card is a copy of the Story card template built in Webflow.
  // ---------------------------------------------------------------------------
  var clipWatch = null;
  /**
   * An uploaded vertical video in a Webflow-built clip box ([data-hf-part="clip"]):
   * plays muted, looped and inline while on screen; tap for sound. A browser
   * that can't play the file keeps the still and shows a short note.
   */
  function setupClip(box, src, poster, label) {
    if (!box || box.getAttribute('data-hfp')) return;
    box.setAttribute('data-hfp', '1');
    var sound = box.querySelector('[data-hf-part="sound"]');
    var sorry = box.querySelector('[data-hf-part="sorry"]');
    var still = box.querySelector('[data-hf-part="poster"]');
    if (!poster && still && still.getAttribute('src')) poster = still.getAttribute('src');
    var v = document.createElement('video');
    v.className = 'hf-clip-video';
    v.src = src;
    if (poster) v.poster = poster;
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none';
    ['muted', 'loop', 'playsinline'].forEach(function (a) { v.setAttribute(a, ''); });
    v.setAttribute('aria-label', label || '');
    box.insertBefore(v, box.firstChild);
    if (still) drop(still);
    function toggle(e) {
      if (e) e.preventDefault();
      var on = v.muted;
      document.querySelectorAll('.hf-clip-video').forEach(function (o) {
        if (o === v || o.muted || !o.parentNode) return;
        o.muted = true;
        var b = o.parentNode.querySelector('[data-hf-part="sound"]');
        if (b) b.textContent = copyText('clip-sound-on');
      });
      v.muted = !on;
      if (sound) sound.textContent = copyText(on ? 'clip-sound-off' : 'clip-sound-on');
      if (v.paused) v.play().catch(function () {});
    }
    if (sound) sound.addEventListener('click', toggle);
    v.addEventListener('click', toggle);
    v.addEventListener('error', function () { if (sorry) sorry.removeAttribute('hidden'); if (sound) sound.setAttribute('hidden', ''); });
    if (window.IntersectionObserver) {
      clipWatch = clipWatch || new IntersectionObserver(function (es) {
        es.forEach(function (e) { var x = e.target; if (e.isIntersecting && e.intersectionRatio >= 0.6) x.play().catch(function () {}); else x.pause(); });
      }, { threshold: [0, 0.6] });
      clipWatch.observe(v);
    }
  }
  /** Stories rendered by Webflow from the CMS (/stories, a story's own page): their uploaded videos. */
  function cmsClips() {
    document.querySelectorAll('[data-hf-part="clip"][data-src]').forEach(function (box) {
      var src = box.getAttribute('data-src');
      if (src) setupClip(box, src, null, '');
    });
  }
  /** "Report this story", on any story (CMS cards carry their slug in data-story). */
  document.addEventListener('click', async function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-hf-act="report"]') : null;
    if (!b) return;
    e.preventDefault();
    var m = /(\d+)$/.exec(b.getAttribute('data-story') || b.getAttribute('data-story-id') || '');
    if (!m || !window.HFB) return;
    var note = b.parentNode && b.parentNode.querySelector('[data-hf-part="report-note"]');
    var reason = window.prompt(copyText('report-ask'));
    if (reason === null) return;
    setBusy(b, true);
    var r = await HFB.call('/api/stories/' + m[1] + '/report', { method: 'POST', body: { reason: reason }, turnstile: true, auth: false });
    say(note, r.ok ? copyText('report-thanks') : msgOf(r), !r.ok);
    setBusy(b, false);
  });
  function storyCard(s, withAction) {
    var tpl = document.querySelector('[data-hf-template="story"]');
    if (!tpl) return null;
    var c = tpl.cloneNode(true);
    c.removeAttribute('data-hf-template');
    function part(n) { return c.querySelector('[data-hf-part="' + n + '"]'); }
    var name = s.name || copyText('member-anon');
    if (s.clip) { setupClip(part('clip'), HFB.base + '/media/' + s.clip.key, s.clip.poster ? HFB.base + '/media/' + s.clip.poster : null, copyText('clip-label', { title: (s.action && s.action.title) || '' })); c.classList.add('is-clip'); } else drop(part('clip'));
    var embed = part('embed');
    if (s.video && embed) {
      if (s.video.vertical) embed.classList.add('is-vertical');
      var f = document.createElement('iframe');
      f.className = 'hf-video-iframe';
      f.src = s.video.embed;
      f.title = copyText('story-video-title', { name: name });
      f.loading = 'lazy';
      f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
      f.setAttribute('allowfullscreen', '');
      embed.appendChild(f);
    } else drop(embed);
    var photo = part('photo');
    if (s.photo && photo) {
      var img = document.createElement('img');
      img.className = 'hf-story-upload';
      img.src = HFB.base + '/media/' + s.photo.key;
      img.alt = s.photo.description || copyText('story-photo-alt');
      img.loading = 'lazy';
      photo.appendChild(img);
    } else drop(photo);
    if (s.text) part('text').textContent = s.text; else drop(part('text'));
    part('meta').textContent = s.with && s.with.length
      ? copyText('story-by-with', { name: name, with: s.with.join(', '), date: day(s.createdAt) })
      : copyText('story-by', { name: name, date: day(s.createdAt) });
    var act = part('action');
    var link = part('action-link');
    if (withAction && s.action && s.action.title && act) {
      if (s.action.slug) { link.textContent = copyText('story-action-link', { title: s.action.title }); link.setAttribute('href', '/action/' + s.action.slug); }
      else { act.textContent = copyText('story-action', { title: s.action.title }); act.className = 'hf-story-meta'; }
    } else drop(act);
    var rep = c.querySelector('[data-hf-act="report"]');
    if (rep) rep.setAttribute('data-story-id', String(s.id));
    return c;
  }
  /** Fills a stories area: uploaded videos in their grid, then the rest. */
  function fillStories(clips, list, stories, withAction) {
    if (clips) clips.innerHTML = '';
    if (list) list.innerHTML = '';
    stories.forEach(function (s) {
      var card = storyCard(s, withAction);
      if (!card) return;
      if (s.clip && clips) clips.appendChild(card); else if (list) list.appendChild(card);
    });
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
    bg: '--colour--ink', ink: '--colour--white', soft: '--colour--logo-blue-on-dark', accent: '--colour--logo-blue',
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
  function roundRect(x, l, t, w, h, r) {
    x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); x.fill();
  }
  // The logo file, served from the backend so the card can be saved as an image.
  var logoImg = null;
  function loadLogo() {
    if (logoImg) return logoImg;
    logoImg = new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = ((window.HFB && HFB.base) || '/join') + '/hf-logo.png';
    });
    return logoImg;
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
    // The logo: the supplied stacked logo file, unchanged, on a white label (never redrawn or recoloured).
    if (o.logo && o.logo.naturalWidth) {
      var ratio = o.logo.naturalWidth / o.logo.naturalHeight, lh0 = ratio < 2 ? 200 : 64, lw0 = Math.round(ratio * lh0), padIn = 28;
      x.fillStyle = '#ffffff';
      roundRect(x, CARD.pad, CARD.pad, lw0 + padIn * 2, lh0 + padIn * 2, 28);
      x.drawImage(o.logo, CARD.pad + padIn, CARD.pad + padIn, lw0, lh0);
    } else {
      x.fillStyle = ink; x.font = '600 40px ' + body; x.textBaseline = 'middle'; x.fillText(copyText('site-name'), CARD.pad, CARD.pad + 60);
    }
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

  // ---------------------------------------------------------------------------
  // Your ripple: you in the middle, a ring per generation, a dot per action
  // done (titles only, never names). Tap or focus a dot to see the action.
  // The headline, caption and notes around it are built in Webflow; only the
  // picture is drawn here.
  // ---------------------------------------------------------------------------
  function rippleSvg(view, onPick) {
    var SVGNS = 'http://www.w3.org/2000/svg';
    function s(tag, attrs) { var e = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
    var rings = (view && view.rings) || [];
    var reached = (view && view.reached) || 0;
    var size = 360, c = size / 2;
    // Only as big as the rings drawn, so a first ripple isn't lost in empty space.
    var reach = 36 + Math.max(rings.length, 1) * 28 + 12;
    var svg = s('svg', { viewBox: (c - reach) + ' ' + (c - reach) + ' ' + reach * 2 + ' ' + reach * 2, width: Math.round(reach * 2.2), role: 'img', 'aria-label': copyText(reached === 1 ? 'ripple-reached-one' : 'ripple-reached-many', { n: reached }) });
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';
    var shown = Math.max(rings.length, 1);
    for (var k = 1; k <= shown; k++) svg.appendChild(s('circle', { cx: c, cy: c, r: 36 + k * 28, fill: 'none', stroke: 'var(--colour--pale-blue, #cfe0f2)', 'stroke-width': 1.5 }));
    rings.forEach(function (ring, i) {
      var r = 36 + (i + 1) * 28, n = ring.dots.length, turn = i * 0.37;
      ring.dots.forEach(function (d, j) {
        // A dot is { title, who } (older views: just the title).
        var title = typeof d === 'string' ? d : d.title;
        var who = typeof d === 'string' ? null : d.who;
        var whoKey = 'who-' + who;
        if (who && copyText(whoKey)) title = copyText('ripple-who', { action: title, who: copyText(whoKey) });
        var a = turn + (j / Math.max(n, 1)) * Math.PI * 2;
        var dot = s('circle', { cx: (c + r * Math.cos(a)).toFixed(1), cy: (c + r * Math.sin(a)).toFixed(1), r: i === 0 ? 7 : 5.5, fill: i === 0 ? 'var(--colour--deep-blue, #2e5e8e)' : i % 2 ? 'var(--colour--brand-blue, #69c)' : 'var(--colour--light-blue, #9ec0e3)', tabindex: '0', role: 'button', 'aria-label': title, style: 'cursor:pointer;outline-offset:2px' });
        var t = s('title'); t.textContent = title; dot.appendChild(t);
        dot.addEventListener('click', function () { onPick(title); });
        dot.addEventListener('focus', function () { onPick(title); });
        svg.appendChild(dot);
      });
    });
    svg.appendChild(s('circle', { cx: c, cy: c, r: 26, fill: 'var(--colour--deep-blue, #2e5e8e)' }));
    var you = s('text', { x: c, y: c + 5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 700 });
    you.textContent = copyText('ripple-you');
    svg.appendChild(you);
    return svg;
  }
  /** Fills a Webflow-built ripple area (headline, picture slot, caption, notes). */
  function drawRipple(P, view) {
    var rings = (view && view.rings) || [];
    var reached = (view && view.reached) || 0;
    P.fill('ripple-h', copyText(reached === 1 ? 'ripple-reached-one' : 'ripple-reached-many', { n: reached.toLocaleString() }));
    // The chain (built in Webflow): the total, then your actions, friends who joined, their actions,
    // and your latest few actions with who they were for.
    P.fill('ripple-reached', reached.toLocaleString());
    P.fill('ripple-people', copyText(reached === 1 ? 'ripple-people-one' : 'ripple-people-many'));
    var mine = rings[0] ? rings[0].dots.slice(0, 3) : [];
    P.show('ripple-latest', mine.length > 0);
    fillList('ripple-latest', mine, function (li, d) {
      var t = partIn(li, 'title');
      if (t) t.textContent = typeof d === 'string' ? d : d.title;
      var m = partIn(li, 'meta');
      if (!m) return;
      var whoKey = 'who-' + (d && d.who);
      var bits = [];
      if (d && d.who && copyText(whoKey)) bits.push(copyText('ripple-for', { who: copyText(whoKey) }));
      if (d && d.at) bits.push(day(d.at));
      // Its own line under the title: "For a friend · Nov 19, 2026".
      var line = bits.join(' · ');
      m.textContent = line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
      if (!line) drop(m);
    });
    // The three real numbers (built in Webflow): your actions, friends who joined, their actions.
    P.fill('ripple-actions', String((view && view.actions) || 0));
    P.fill('ripple-friends', String((view && view.friends) || 0));
    P.fill('ripple-their', String((view && view.theirActions) || 0));
    P.fill('ripple-caption', rings.length ? copyText('ripple-tap') : '');
    var slot = P.slot('ripple');
    if (slot) {
      slot.innerHTML = '';
      slot.appendChild(rippleSvg(view, function (t) { P.fill('ripple-caption', t); }));
    }
    var more = rings.map(function (r, i) { return r.marks > r.dots.length ? copyText('ripple-more', { n: (r.marks - r.dots.length).toLocaleString(), ring: i + 1 }) : ''; }).filter(Boolean);
    P.fill('ripple-more', more.join(' · '));
    P.show('ripple-more', more.length > 0);
    P.show('ripple-hint', rings.length <= 1);
  }

  // ---------------------------------------------------------------------------
  // Action page. The buttons, messages, invite forms, win card, share card,
  // ripple and stories area are all built in the Action template in Webflow.
  // Which main button shows (Do this with me or I did this) is set natively from
  // the action's two automatic switches.
  // ---------------------------------------------------------------------------
  async function actionPage() {
    var row = document.querySelector('[data-hf-row="action"]');
    if (!row || row.getAttribute('data-hfp')) return;
    row.setAttribute('data-hfp', '1');
    var P = partsOf(row.closest('section') || document.body);
    var D = partsOf(document.body);
    var slug = slugFromPath();
    var msg = $('hf-did-msg');
    var shareNote = P.one('[data-hf-fill="share-note"]');
    var noteBox = P.one('[data-hf-field="note"]');
    var composeForm = P.one('[data-hf-form="compose"]');
    var nameForm = P.one('[data-hf-form="ask-name"]');
    var nameBox = P.one('[data-hf-field="first-name"]');
    var stories = D.one('[data-hf-show="stories"]');

    await wait(function () { return window.HFB && window.HF; }, 10000);
    var st = {};
    var id = null;
    var won = false;

    function render() {
      var me = st.me || null;
      P.fill('count', st.count ? copyText('action-count', { n: st.count.toLocaleString() }) : '');
      P.show('count', !!st.count);
      D.fill('suggested', st.suggestedBy ? copyText('action-suggested', { name: st.suggestedBy }) : '');
      D.show('suggested', !!st.suggestedBy);
      var g = me && me.group;
      P.fill('group', g ? groupLine(g) : '');
      P.show('group', !!g);
      P.show('save', true);
      P.acts('save').forEach(function (b) {
        b.textContent = copyText(me && me.liked ? 'action-saved' : 'action-save');
        b.setAttribute('aria-pressed', me && me.liked ? 'true' : 'false');
      });
      var done = !!(me && me.done);
      P.acts('done').forEach(function (b) { b.textContent = copyText(done ? 'action-did-again' : 'action-did'); });
      P.acts('story').forEach(function (b) {
        b.textContent = copyText(me && me.story ? 'story-edit' : 'story-share');
        b.setAttribute('href', '/share-your-story?action=' + encodeURIComponent(slug));
      });
      P.show('story', done && !me.guest);
      P.show('undo', done && me.canUndo);
      P.fill('together', done && me.doneWith && me.doneWith.length ? copyText('action-together', { names: me.doneWith.join(', ') }) : '');
      P.show('together', !!(done && me.doneWith && me.doneWith.length));
      if (done && !won) say(msg, copyText(me.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: me.tally }));
      // Kept on this device until an account keeps it (once the win card has gone).
      P.show('keep-line', done && me.guest && !won);
    }

    async function load() {
      var r = await HFB.call('/api/actions/' + encodeURIComponent(slug) + '/state');
      if (!r.ok) return;
      st = r.data;
      id = st.actionId;
      render();
      var list = st.stories || [];
      if (stories) {
        var S = partsOf(stories);
        fillStories(S.slot('clips'), S.slot('stories'), list, false);
        D.show('stories', list.length > 0);
      }
    }

    // --- The win: ripple, share card, pass it on or keep it -------------------
    var proof = null;
    function showWin(data) {
      won = true;
      var guest = !!data.guest;
      if (data.rippleView) drawRipple(P, data.rippleView);
      P.show('ripple', !!data.rippleView);
      proof = { who: st.cardWho || data.cardWho || null, title: st.title, slug: st.slug, ref: data.refCode, name: st.me && st.me.name };
      paintProof();
      // The card and the story, offered together: one for social, one for the Stories page.
      P.acts('win-story').forEach(function (a) { a.setAttribute('href', '/share-your-story?action=' + encodeURIComponent(st.slug)); });
      P.show('win-story', true);
      P.show('pass', !guest);
      P.show('keep', guest);
      P.show('keep-line', false);
      P.show('win', true);
    }

    // Shareable proof: drawn in the browser; shared with the phone's share sheet or downloaded.
    var proofBlob = null;
    var proofName = P.one('[data-hf-field="proof-name"]');
    var canFiles = false;
    try { canFiles = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })); } catch (e) {}
    async function paintProof() {
      if (!proof) return null;
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
      var line = cardLine(proof.who, proofName && proofName.checked ? proof.name : null);
      var c = drawCard({ line: line, title: proof.title, logo: await loadLogo() });
      P.show('proof-name', !!proof.name);
      P.show('card-share', canFiles);
      P.show('card-hint', !canFiles);
      if (!c) { P.show('proof', false); return line; }
      var slot = P.slot('proof');
      var img = slot && slot.querySelector('img');
      if (slot && !img) { img = document.createElement('img'); img.className = 'hf-fill-media'; slot.appendChild(img); }
      if (img) { img.alt = line; img.src = c.toDataURL('image/png'); }
      proofBlob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
      P.show('proof', true);
      return line;
    }
    if (proofName) proofName.addEventListener('change', paintProof);
    function proofUrl() { return location.origin + '/action/' + proof.slug + (proof.ref ? '?r=' + proof.ref : ''); }
    P.on('card-share', async function () {
      var line = await paintProof();
      var file = proofBlob && window.File ? new File([proofBlob], 'happiness-' + proof.slug + '.png', { type: 'image/png' }) : null;
      var data = { files: file ? [file] : [], text: copyText('card-share-text', { line: line, url: proofUrl() }), url: proofUrl() };
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share(data); } catch (e) {} }
    });
    P.on('card-download', async function (b) {
      await paintProof();
      if (!proofBlob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(proofBlob);
      a.download = 'happiness-' + proof.slug + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });

    // --- Invites: a short note, then the share sheet ---------------------------
    var inviteKind = 'with_me';
    function openCompose(kind) {
      inviteKind = kind;
      if (noteBox) {
        noteBox.setAttribute('maxlength', '280');
        noteBox.setAttribute('placeholder', copyText(kind === 'with_me' ? 'note-example-with' : 'note-example-pass'));
        P.fill('note-left', copyText('note-left', { n: 280 - noteBox.value.length }));
      }
      var go = composeForm && composeForm.querySelector('[type=submit]');
      if (go) go.value = copyText(kind === 'with_me' ? 'note-share-invite' : 'note-share');
      P.show('compose', true);
      if (noteBox) noteBox.focus();
    }
    if (noteBox) noteBox.addEventListener('input', function () { P.fill('note-left', copyText('note-left', { n: 280 - noteBox.value.length })); });
    P.on('compose-cancel', function () { P.show('compose', false); });
    async function sendInvite() {
      var r = await HFB.call('/api/invites', { method: 'POST', body: { actionId: id, kind: inviteKind, note: noteBox ? noteBox.value : '' } });
      if (r.status === 409 && r.data && r.data.error === 'need_first_name') {
        P.show('ask-name', true);
        if (nameBox) nameBox.focus();
        return false;
      }
      if (!r.ok) { say(shareNote, msgOf(r), true); return false; }
      P.show('compose', false);
      await share({ title: document.title, text: r.data.text, url: r.data.url }, shareNote);
      return true;
    }
    nativeForm(composeForm, async function () {
      var go = composeForm.querySelector('[type=submit]');
      setBusy(go, true);
      await sendInvite();
      setBusy(go, false);
    });
    nativeForm(nameForm, async function () {
      var go = nameForm.querySelector('[type=submit]');
      setBusy(go, true);
      var r = await HFB.call('/api/me/settings', { method: 'PATCH', body: { firstName: nameBox ? nameBox.value : '' } });
      setBusy(go, false);
      if (!r.ok) { say(shareNote, msgOf(r), true); return; }
      P.show('ask-name', false);
      sendInvite();
    });

    // Signed out: Save goes to sign-in, and is finished after sign-in, back here.
    function ask(kind) {
      say(msg, copyText(kind === 'like' ? 'action-signin-save' : 'action-signin-done'));
      HFB.requireSignIn({ kind: kind, actionId: id });
    }

    function doneLabel() { return copyText(st.me && st.me.done ? 'action-did-again' : 'action-did'); }
    var busy = false;
    P.on('done', async function (b) {
      if (busy || !id) return;
      busy = true;
      setBusy(b, true);
      // Signed out, this is saved on this device (try before sign-up).
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'POST', guest: true, headers: { 'X-HF-Ref': HFB.ref ? HFB.ref() : null } });
      busy = false;
      setBusy(b, false);
      if (r.ok) {
        buzz();
        say(msg, copyText(r.data.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: r.data.tally }));
        showWin(r.data);
        D.show('people-ask', true);
        rememberActive(r.data.active);
        window.dispatchEvent(new Event('hf-done'));
        await load();
        doneMoment(b, doneLabel);
      } else if (r.status === 401) ask('done');
      else say(msg, msgOf(r), true);
    });

    // "How many people did you make happy?" (built in Webflow, shown after I did this). Optional:
    // without an answer the mark counts 1. Counted low: 2–5 is 2, more is 6.
    D.on('people', async function (b) {
      if (!id) return;
      setBusy(b, true);
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'PATCH', guest: true, body: { people: b.getAttribute('data-hf-people') } });
      setBusy(b, false);
      if (!r.ok) return say(msg, msgOf(r), true);
      D.show('people-ask', false);
      say(msg, copyText('people-thanks') + ' ' + copyText(r.data.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: r.data.tally }));
    });

    P.on('undo', async function (b) {
      if (!id) return;
      setBusy(b, true);
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'DELETE' });
      setBusy(b, false);
      if (!r.ok) return say(msg, msgOf(r), true);
      rememberActive(r.data.active);
      won = false;
      P.show('win', false);
      D.show('people-ask', false);
      await load();
      P.acts('done').forEach(function (d) { endMoment(d, doneLabel); });
      // The message tells the new total (none left: just "Undone.").
      var n = r.data && r.data.tally;
      var left = n ? copyText(n === 1 ? 'action-tally-one' : 'action-tally-many', { n: n }) : '';
      say(msg, copyText('action-undone', { message: left }).trim());
    });

    var lbusy = false;
    P.on('save', async function (b) {
      if (lbusy || !id) return;
      if (!signedIn()) return ask('like');
      lbusy = true;
      var want = !(st.me && st.me.liked);
      var r = await HFB.call('/api/actions/' + id + '/like', { method: 'PUT', body: { liked: want } });
      lbusy = false;
      if (r.ok) { st.me = Object.assign({}, st.me, { liked: want }); render(); }
      else if (r.status === 401) ask('like');
      else say(msg, msgOf(r), true);
    });

    P.on('with-me', function () {
      if (!id) return;
      if (!signedIn()) return HFB.requireSignIn({ kind: 'return', actionId: id });
      openCompose('with_me');
    });
    P.on('pass', function () {
      if (!signedIn()) return HFB.requireSignIn({ kind: 'return', actionId: id });
      openCompose('pass_it_on');
    });
    D.on('signup', function () { if (HF.signup) HF.signup(); else HF.signin(); });
    D.on('signin', function () { HF.signin(); });

    document.addEventListener('hfb:resumed', function () { load(); });
    // Back from sharing an invite: the group may have grown.
    document.addEventListener('visibilitychange', function () { if (!document.hidden && id) load(); });
    await load();
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------
  // Lists are built in Webflow: each list (data-hf-slot) holds a hidden
  // design (data-hf-template) that is copied once per item and filled in.
  function fromTemplate(list, name) {
    var t = list.querySelector('[data-hf-template="' + name + '"]');
    if (!t) return null;
    var c = t.cloneNode(true);
    c.removeAttribute('data-hf-template');
    c.removeAttribute('data-hf-show');
    return c;
  }
  function partIn(root, n) { return root.querySelector('[data-hf-part="' + n + '"]'); }
  // name is the list (data-hf-slot); its item design is data-hf-template=design (default: the same name).
  function fillList(name, items, draw, design) {
    var list = document.querySelector('[data-hf-slot="' + name + '"]');
    if (!list) return;
    [].slice.call(list.children).forEach(function (c) { if (!c.hasAttribute('data-hf-template')) list.removeChild(c); });
    items.forEach(function (x) { var li = fromTemplate(list, design || name); if (li) { draw(li, x); list.appendChild(li); } });
    var empty = list.parentNode && list.parentNode.querySelector('[data-hf-part="empty"]');
    if (empty) empty.style.display = items.length ? 'none' : '';
  }
  function setLink(a, href, text) {
    if (!a) return;
    if (href) a.setAttribute('href', href); else a.removeAttribute('href');
    if (text != null) a.textContent = text;
  }

  // Account sections open and close: the title in each card is a Webflow link
  // (data-hf-act="fold"). The impact card stays open. Defaults put what needs
  // doing first; a section someone opens or closes stays that way on this device.
  // The jump links open what they point to.
  var FOLD_KEY = 'hfp_acct_open';
  function foldPrefs() { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function setFold(card, open, remember) {
    if (open) card.removeAttribute('data-hf-closed'); else card.setAttribute('data-hf-closed', '');
    var b = card.querySelector('[data-hf-act="fold"]');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (remember && card.id) { var p = foldPrefs(); p[card.id] = open; try { localStorage.setItem(FOLD_KEY, JSON.stringify(p)); } catch (e) {} }
  }
  function foldSections(me) {
    var root = $('hf-acct-in');
    if (!root) return;
    var openPledges = (me.pledges || []).filter(function (p) { return p.status !== 'kept'; }).length;
    var counts = {
      'acct-pledges': openPledges ? copyText('acct-fold-to-keep', { n: openPledges }) : '',
      'acct-saved': me.saved && me.saved.length ? String(me.saved.length) : '',
      'acct-joined': me.joinedMyInvites && me.joinedMyInvites.length ? String(me.joinedMyInvites.length) : '',
      'acct-invited': me.invitesIJoined && me.invitesIJoined.length ? String(me.invitesIJoined.length) : '',
    };
    var opens = { 'acct-pledges': openPledges > 0, 'acct-saved': true, 'acct-joined': true, 'acct-invited': false, 'hfp-settings': false, 'acct-data': false };
    var prefs = foldPrefs();
    root.querySelectorAll('.hf-acct-card').forEach(function (card) {
      var b = card.querySelector('[data-hf-act="fold"]');
      if (!b || !card.id) return;
      if (!card.hasAttribute('data-hfp-fold')) {
        card.setAttribute('data-hfp-fold', '1');
        var toggle = function (e) { e.preventDefault(); e.stopPropagation(); setFold(card, card.hasAttribute('data-hf-closed'), true); };
        b.addEventListener('click', toggle);
        b.addEventListener('keydown', function (e) { if (e.key === ' ') toggle(e); });
        setFold(card, card.id in prefs ? !!prefs[card.id] : card.id in opens ? opens[card.id] : true, false);
      }
      var count = b.querySelector('[data-hf-fill="fold-count"]');
      if (count) count.textContent = counts[card.id] || '';
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

  function weekLabel(d) { try { return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (e) { return d; } }
  function activeLine(A) {
    if (A.active && A.toGo === 0) return copyText('active-yes', { n: A.weeksDone });
    if (A.active) return copyText('active-keep');
    if (A.weeksDone === 0) return copyText('active-start');
    if (A.toGo === 1) return copyText('active-to-go-one', { n: A.weeksDone });
    return copyText('active-to-go-many', { n: A.weeksDone, left: A.toGo });
  }
  // The account dashboard (built in Webflow): the tally's next milestone, one action to do
  // next (a Webflow Actions list; this shows the first one not yet done or skipped) and the
  // feed of what happened, with filter chips.
  var MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000];
  var SKIP_KEY = 'hfp_next_skip';
  function skipped() { try { return JSON.parse(localStorage.getItem(SKIP_KEY) || '[]') || []; } catch (e) { return []; } }
  function dashboard(me, storyFor) {
    var inn = $('hf-acct-in');
    if (!inn) return;
    var P = partsOf(inn);
    var n = me.tally || 0;
    var goal = MILESTONES.filter(function (m) { return m > n; })[0] || 0;
    var prev = MILESTONES.filter(function (m) { return m <= n; }).pop() || 0;
    var bar = partIn(inn, 'tally-bar');
    if (bar) bar.style.width = goal ? Math.round(((n - prev) / (goal - prev)) * 100) + '%' : '100%';
    P.fill('tally-next', !goal ? copyText('dash-next-done') : goal - n === 1 ? copyText('dash-next-one', { goal: goal }) : copyText('dash-next-many', { left: goal - n, goal: goal }));

    // Next up: the first card not done, saved or skipped.
    var seen = {};
    (me.done || []).forEach(function (d) { if (d.slug) seen[d.slug] = 1; });
    skipped().forEach(function (s) { seen[s] = 1; });
    var cards = [].slice.call(inn.querySelectorAll('[data-hf-show="next"]'));
    function pickNext() {
      var pick = cards.filter(function (c) { return !seen[c.getAttribute('data-hf-slug')]; })[0] || null;
      cards.forEach(function (c) { if (c === pick) c.setAttribute('data-hf-on', '1'); else c.removeAttribute('data-hf-on'); });
      if (pick) {
        var why = pick.querySelector('[data-hf-fill="next-why"]');
        if (why) why.textContent = copyText('dash-next-label');
      }
    }
    pickNext();
    cards.forEach(function (c) {
      var skip = c.querySelector('[data-hf-act="next-skip"]');
      if (!skip || skip.getAttribute('data-hfp')) return;
      skip.setAttribute('data-hfp', '1');
      skip.addEventListener('click', function (e) {
        e.preventDefault();
        var slug = c.getAttribute('data-hf-slug');
        var list = skipped().filter(function (s) { return s !== slug; }).concat([slug]).slice(-50);
        try { localStorage.setItem(SKIP_KEY, JSON.stringify(list)); } catch (err) {}
        seen[slug] = 1;
        if (!cards.some(function (x) { return !seen[x.getAttribute('data-hf-slug')]; })) {
          // Every card skipped: start again, keeping only what is done.
          try { localStorage.removeItem(SKIP_KEY); } catch (err) {}
          seen = {};
          (me.done || []).forEach(function (d) { if (d.slug) seen[d.slug] = 1; });
          seen[slug] = 1;
        }
        pickNext();
      });
    });

    // The feed: newest first, at most 30.
    var items = [];
    (me.done || []).forEach(function (d) {
      var live = d.slug && d.actionStatus === 'published';
      // Your own action (not on the site yet): its story is shared by its own reference.
      var ref = live ? d.slug : /^own-\d+$/.test(d.actionId || '') ? d.actionId : '';
      var s = storyFor[d.actionId];
      items.push({ cat: 'mine', at: d.doneAt, by: 'me', title: copyText('feed-did', { action: d.title }),
        meta: day(d.doneAt) + (s ? ' · ' + copyText(s.status === 'approved' ? 'acct-story-approved' : s.status === 'rejected' ? 'acct-story-rejected' : 'acct-story-review') : ''), go: ref ? { href: '/share-your-story?action=' + encodeURIComponent(ref), text: copyText(s ? 'story-edit' : 'story-share') } : null });
    });
    (me.joinedMyInvites || []).forEach(function (x) {
      items.push({ cat: 'together', at: x.joinedAt, by: x.name || '', title: copyText('feed-joined', { name: x.name || copyText('acct-someone'), action: x.actionTitle || '' }),
        meta: day(x.joinedAt), go: x.actionSlug ? { href: '/action/' + x.actionSlug, text: copyText('feed-see-action') } : null });
    });
    (me.invitesIJoined || []).forEach(function (x) {
      items.push({ cat: 'together', at: x.joinedAt, by: 'me', title: copyText('feed-i-joined', { name: x.inviterName || copyText('acct-someone'), action: x.actionTitle || '' }),
        meta: day(x.joinedAt), go: x.actionSlug ? { href: '/action/' + x.actionSlug, text: copyText('feed-see-action') } : null });
    });
    (me.pledges || []).forEach(function (p) {
      var kept = p.status === 'kept';
      items.push({ cat: 'drops', at: kept && p.keptOn ? p.keptOn : p.orderedAt, badge: kept ? null : '◆', by: kept ? 'me' : null,
        title: kept ? copyText('feed-pledge-kept', { action: p.keptByTitle || copyText('acct-pledge-an-action') }) : copyText('feed-pledge-open'),
        meta: day(kept && p.keptOn ? p.keptOn : p.orderedAt), go: kept ? null : { href: '/#find', text: copyText('feed-pledge-keep') } });
    });
    items.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    items = items.slice(0, 30);
    fillList('feed', items, function (li, x) {
      li.setAttribute('data-cat', x.cat);
      var b = partIn(li, 'badge');
      if (b) feedAvatar(b, x);
      var t = partIn(li, 'title');
      if (t) t.textContent = x.title;
      var m = partIn(li, 'meta');
      if (m) m.textContent = x.meta;
      var go = partIn(li, 'go');
      if (x.go) setLink(go, x.go.href, x.go.text); else drop(go);
    }, 'feed-item');
    P.show('feed-end', items.length > 0);
    feedFilter(inn, inn.getAttribute('data-hf-feed') || 'all');
    inn.querySelectorAll('[data-hf-act="feed-filter"]').forEach(function (chip) {
      if (chip.getAttribute('data-hfp')) return;
      chip.setAttribute('data-hfp', '1');
      chip.addEventListener('click', function (e) { e.preventDefault(); feedFilter(inn, chip.getAttribute('data-hf-filter')); });
    });
  }
  // The feed's round badge is whoever did it: your photo or initial, or your friend's initial.
  function feedAvatar(b, x) {
    var photo = '';
    var text = x.badge || '';
    if (x.by === 'me') {
      var m = memberSaved() || {};
      var first = (m.customFields && m.customFields['first-name']) || '';
      text = String(first || (m.auth && m.auth.email) || '').trim().charAt(0).toUpperCase();
      if (m.profileImage) photo = String(m.profileImage).replace(/["\\]/g, '');
    } else if (x.by) {
      text = String(x.by).trim().charAt(0).toUpperCase();
    }
    b.textContent = photo ? '' : text;
    b.style.backgroundImage = photo ? 'url("' + photo + '")' : '';
    b.classList.toggle('is-green', x.cat === 'together' && x.by !== 'me');
    b.classList.toggle('is-ink', !x.by);
  }
  function feedFilter(inn, f) {
    inn.setAttribute('data-hf-feed', f);
    inn.querySelectorAll('[data-hf-act="feed-filter"]').forEach(function (c) {
      var on = c.getAttribute('data-hf-filter') === f;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var list = document.querySelector('[data-hf-slot="feed"]');
    if (!list) return;
    var shown = 0;
    [].slice.call(list.children).forEach(function (li) {
      if (li.hasAttribute('data-hf-template')) return;
      var on = f === 'all' || li.getAttribute('data-cat') === f;
      li.style.display = on ? '' : 'none';
      if (on) shown++;
    });
    var empty = list.parentNode && list.parentNode.querySelector('[data-hf-part="empty"]');
    if (empty) empty.style.display = shown ? 'none' : '';
  }
  function renderAccount(me) {
    photoRow();
    homeAreaRow(me);
    var inn = $('hf-acct-in');
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || copyText('acct-there');
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var P = partsOf(inn);
    // The line under the tally (in Webflow): its own words until someone they invited takes an action.
    var rippleLine = $('hfp-ripple');
    if (rippleLine) {
      if (!rippleLine.hasAttribute('data-hf-none')) rippleLine.setAttribute('data-hf-none', rippleLine.textContent);
      rippleLine.textContent = me.ripple > 0 ? copyText('ripple', { n: me.ripple }) : rippleLine.getAttribute('data-hf-none');
    }
    // Active membership card (built in Webflow): status, the last five weeks, and how it works.
    if (me.active) {
      var A = me.active;
      rememberActive(A);
      P.show('active-card', true);
      P.show('active-badge', A.active);
      P.fill('active-status', activeLine(A));
      fillList('active-weeks', A.weeks, function (li, w, i) {
        var dot = partIn(li, 'dot');
        var last = A.weeks.indexOf(w) === A.weeks.length - 1;
        if (dot) { dot.classList.toggle('is-done', w.done); dot.classList.toggle('is-now', last && !w.done); }
        var label = partIn(li, 'label');
        if (label) label.textContent = last ? copyText('active-this-week') : weekLabel(w.start);
        li.setAttribute('aria-label', (last ? copyText('active-this-week') : weekLabel(w.start)) + ': ' + copyText(w.done ? 'active-week-done' : 'active-week-open'));
      }, 'week');
    }
    // Your ripple: its card is built in Webflow, right under the impact numbers.
    P.show('ripple', !!me.rippleView);
    if (me.rippleView) drawRipple(partsOf($('acct-ripple') || inn), me.rippleView);
    // People who can open the Lab dashboard get a link to it (the card is in Webflow).
    if ($('hf-acct-lab') && me.lab) $('hf-acct-lab').setAttribute('data-hf-on', '1');

    fillList('pledges', me.pledges || [], function (li, p) {
      var kept = p.status === 'kept';
      var pill = partIn(li, 'state');
      if (pill) { pill.textContent = copyText(kept ? 'acct-pledge-done' : 'acct-pledge-open'); pill.classList.toggle('is-open', !kept); }
      var date = partIn(li, 'date');
      if (date) date.textContent = copyText('acct-pledged', { date: day(p.orderedAt) });
      var line = partIn(li, 'kept');
      if (kept && line) {
        line.textContent = '';
        var by = p.keptBySlug ? el('a', { href: '/action/' + p.keptBySlug, text: p.keptByTitle }) : p.keptByTitle || copyText('acct-pledge-an-action');
        copyNodes('acct-pledge-kept', { action: by, date: day(p.keptOn) }).forEach(function (n) { line.appendChild(n); });
      } else drop(line);
      if (kept) drop(partIn(li, 'keep'));
    }, 'pledge');

    var storyFor = {};
    (me.stories || []).forEach(function (s) { storyFor[s.actionId] = s; });

    dashboard(me, storyFor);

    P.show('saved', !!(me.saved && me.saved.length));
    fillList('saved', me.saved || [], function (li, d) { setLink(partIn(li, 'title'), '/action/' + d.slug, d.title); });

    P.show('joined', !!(me.joinedMyInvites && me.joinedMyInvites.length));
    fillList('joined', me.joinedMyInvites || [], function (li, x) {
      var t = partIn(li, 'text');
      if (t) t.textContent = copyText('acct-joined', { name: x.name || copyText('acct-someone'), action: x.actionTitle || '', date: day(x.joinedAt) });
    });

    P.show('invited', !!(me.invitesIJoined && me.invitesIJoined.length));
    fillList('invited', me.invitesIJoined || [], function (li, x) {
      setLink(partIn(li, 'title'), x.actionSlug ? '/action/' + x.actionSlug : null, x.actionTitle || '');
      var by = partIn(li, 'by');
      if (by) by.textContent = copyText('acct-invited', { name: x.inviterName || copyText('acct-someone') });
      var leave = li.querySelector('[data-hf-act="leave"]');
      if (leave) leave.addEventListener('click', async function (e) {
        e.preventDefault();
        setBusy(leave, true);
        var rr = await HFB.call('/api/invites/' + encodeURIComponent(x.code) + '/join', { method: 'DELETE' });
        setBusy(leave, false);
        if (!rr.ok) return;
        var list = li.parentNode;
        drop(li);
        if (list && !list.querySelector(':scope > :not([data-hf-template])')) P.show('invited', false);
      });
    });

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
        var a = el('a', { href: URL.createObjectURL(blob), download: 'make-other-people-happy-my-data.json' });
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
    // The form, the "you'll be asked to sign in" line, the message line and the
    // thank-you are built in Webflow; this sends the idea to the backend.
    var f = $('wf-form-Suggest-an-action');
    if (!f || f.getAttribute('data-hfp')) return;
    f.setAttribute('data-hfp', '1');
    var wrap = f.closest('.w-form') || f.parentNode;
    var done = wrap.querySelector('.w-form-done');
    var fail = wrap.querySelector('.w-form-fail');
    var ta = f.querySelector('textarea');
    // "Where does this work best?" (in Webflow, starting on Anywhere): its places
    // are the ones in the site's location picker, so there's one list to keep.
    var where = f.querySelector('[data-hf-field="where"]');
    var loc = $('hf-loc');
    if (where && loc) {
      [].forEach.call(loc.options, function (o) {
        if (!o.value || where.querySelector('option[value="' + o.value + '"]')) return;
        var n = document.createElement('option');
        n.value = o.value;
        n.textContent = o.textContent;
        where.appendChild(n);
      });
    }
    var P = partsOf(wrap);
    var msg = P.one('[data-hf-fill="sug-msg"]');
    freeSubmit(f);
    forgetDrafts();
    clearOnLeave(f);
    function finished() {
      f.reset();
      f.style.display = 'none';
      if (fail) fail.style.display = 'none';
      if (done) { done.style.display = 'block'; done.setAttribute('role', 'status'); }
    }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    P.show('signin-note', !signedIn());
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (fail) fail.style.display = 'none';
      say(msg, '');
      var text = (ta && ta.value || '').trim();
      if (text.length < 3) { say(msg, copyText('sug-empty'), true); if (ta) ta.focus(); return; }
      var place = where ? where.value : '';
      var data = place ? { text: text, location: place } : { text: text };
      if (!signedIn()) return HFB.requireSignIn({ kind: 'suggestion', data: data });
      var submit = f.querySelector('[type=submit]');
      if (submit) { submit.setAttribute('data-hfp-busy', '1'); submit.disabled = true; }
      var r = await HFB.call('/api/suggestions', { method: 'POST', body: data });
      if (submit) { submit.removeAttribute('data-hfp-busy'); submit.disabled = false; }
      if (r.ok) finished();
      else if (r.status === 401) HFB.requireSignIn({ kind: 'suggestion', data: data });
      else { say(msg, msgOf(r), true); if (fail) fail.style.display = 'block'; }
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
    // Everything on this page is built in Webflow: the form and its fields, the photo
    // preview, the video upload block (label, picker, preview, Try again, Remove, the
    // consent tick and the children question), "Who did it with you?", Delete, the
    // messages and the thank-you with its link back. This checks the member, fills it
    // in, shows the parts that apply and sends the story to the backend.
    var form = $('hf-story-form');
    var note = $('hf-story-note');
    if (!form || form.getAttribute('data-hfp')) return;
    form.setAttribute('data-hfp', '1');
    freeSubmit(form);
    var wrap = form.closest('.w-form') || form.parentNode;
    var shown = form.closest('[data-hf-show]') || wrap;
    var done = wrap.querySelector('.w-form-done');
    var fail = wrap.querySelector('.w-form-fail');
    var P = partsOf(document.body);
    var F = function (name) { return form.querySelector('[data-hf-field="' + name + '"]'); };
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }
    var slug = new URLSearchParams(location.search).get('action') || '';
    var back = location.pathname + location.search;
    // A message above the form with one button under it (both in Webflow).
    function sayLink(text, label, href, fn) {
      say(note, text);
      var a = P.one('[data-hf-link="note"]');
      if (a) {
        a.textContent = label;
        a.setAttribute('href', href);
        a.onclick = fn ? function (e) { e.preventDefault(); fn(); } : null;
      }
      P.show('note-link', true);
    }
    if (!slug) return sayLink(copyText('st-no-action'), copyText('st-account'), '/account');
    if (!signedIn()) return sayLink(copyText('st-signin'), copyText('st-signin-button'), '/account', function () { HFB.requireSignIn({ kind: 'return', returnTo: back }); });
    var r = await HFB.call('/api/stories/mine?action=' + encodeURIComponent(slug));
    if (!r.ok) return sayLink(msgOf(r), copyText('st-account'), '/account');
    var mine = r.data;
    if (!mine.done) return sayLink(copyText('st-not-done'), copyText('st-go-action'), '/action/' + slug);
    var title = mine.title || slug.replace(/-/g, ' ');
    if (!mine.own) {
      try {
        var h = await fetch('/action/' + slug).then(function (x) { return x.ok ? x.text() : ''; });
        var t = new DOMParser().parseFromString(h, 'text/html').querySelector('h1');
        if (t && t.textContent.trim()) title = t.textContent.trim();
      } catch (e) {}
    }
    var s = mine.story || {};
    var msg = P.one('[data-hf-fill="story-msg"]');
    if ($('hf-story-title')) $('hf-story-title').textContent = title;
    if ($('hf-story-status') && mine.story) $('hf-story-status').textContent = copyText(mine.story.status === 'approved' ? 'st-on-site' : 'st-in-review');
    var backLink = P.one('[data-hf-link="back"]');
    if (backLink) backLink.setAttribute('href', mine.own ? '/account' : '/action/' + slug);
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
    var preview = P.one('[data-hf-part="photo-preview"]');
    var photoMsg = P.one('[data-hf-fill="photo-msg"]');
    function showPhoto(src) {
      if (preview) { if (src) preview.setAttribute('src', src); else preview.removeAttribute('src'); }
      P.show('photo', !!src);
    }
    showPhoto(photoKey ? HFB.base + '/media/' + photoKey : null);
    if (photo) photo.addEventListener('change', async function () {
      var file = photo.files && photo.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { say(photoMsg, copyText('st-too-big'), true); return; }
      say(photoMsg, copyText('st-preparing'));
      var blob;
      try { blob = await resizeToJpeg(file); } catch (e) {
        say(photoMsg, copyText('st-unreadable'), true);
        return;
      }
      var tok = await HFB.token();
      var res = await fetch(HFB.base + '/api/stories/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg' }, body: blob });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) { say(photoMsg, (data && data.message) || copyText('st-upload-failed'), true); return; }
      photoKey = data.photoKey;
      showPhoto(URL.createObjectURL(blob));
      say(photoMsg, copyText('st-photo-added'));
    });
    P.on('remove-photo', function () { photoKey = null; showPhoto(null); if (photo) photo.value = ''; say(photoMsg, copyText('st-photo-removed')); });

    // Video: checked here first (vertical, 15–30 seconds, at most 100 MB), then
    // uploaded in parts; a dropped part is retried, and "Try again" picks up
    // where it stopped. The backend checks the file again.
    var vid = { key: s.videoKey || null, poster: s.posterKey || null, busy: false, isNew: false, up: null };
    var vInput = F('video-file');
    var vMsg = P.one('[data-hf-fill="video-msg"]');
    var vPrev = P.one('[data-hf-part="video-preview"]');
    var vConsent = F('video-consent');
    var vKidsYes = F('kids-yes');
    var vKidsNo = F('kids-no');
    if (vKidsYes) vKidsYes.checked = s.hasChildren === 1;
    if (vKidsNo) vKidsNo.checked = s.hasChildren === 0;
    function showVideo(src, poster) {
      if (vPrev) {
        if (src) vPrev.setAttribute('src', src); else vPrev.removeAttribute('src');
        if (poster) vPrev.setAttribute('poster', poster); else vPrev.removeAttribute('poster');
      }
      P.show('video', !!src);
      P.show('video-ask', !!src);
    }
    showVideo(vid.key ? HFB.base + '/media/' + vid.key : null, vid.poster ? HFB.base + '/media/' + vid.poster : null);
    // One video per story: an upload or a link. Whichever is in use greys out the other.
    function oneVideo() {
      var hasFile = !!(vid.key || vid.up || vid.busy);
      var hasLink = !!(video && video.value.trim());
      if (video) video.disabled = hasFile;
      P.show('link-off', hasFile);
      if (vInput) vInput.disabled = hasLink && !hasFile;
      P.show('file-off', hasLink && !hasFile);
    }
    if (video) video.addEventListener('input', oneVideo);
    function vSay(t2, bad) { say(vMsg, t2, bad); }
    function meta(file) {
      return new Promise(function (resolve) {
        var t2 = document.createElement('video');
        t2.preload = 'metadata'; t2.muted = true; t2.playsInline = true;
        var url = URL.createObjectURL(file), finished = false;
        function end(v) { if (finished) return; finished = true; resolve(v); }
        t2.onloadedmetadata = function () { end({ el: t2, url: url, seconds: t2.duration, w: t2.videoWidth, h: t2.videoHeight }); };
        t2.onerror = function () { end({ el: null, url: url, seconds: NaN, w: 0, h: 0 }); };
        setTimeout(function () { end({ el: null, url: url, seconds: NaN, w: 0, h: 0 }); }, 10000);
        t2.src = url;
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
      vid.busy = true; P.show('video-retry', false);
      try {
        if (!(await sendParts())) { vSay(copyText('st-video-stopped'), true); P.show('video-retry', true); return; }
        var parts = Object.keys(vid.up.done).map(function (k) { return { partNumber: Number(k), etag: vid.up.done[k] }; });
        var c = await HFB.call('/api/stories/video/complete', { method: 'POST', body: { uploadId: vid.up.uploadId, parts: parts } });
        if (!c.ok) { vSay(msgOf(c), true); vid.up = null; if (vInput) vInput.value = ''; showVideo(null); oneVideo(); return; }
        vid.key = c.data.videoKey; vid.isNew = true; vid.up = null;
        vSay(copyText('st-video-added'));
        oneVideo();
      } catch (e) {
        vSay((e && e.message) || copyText('st-video-stopped'), true); P.show('video-retry', true);
      } finally { vid.busy = false; }
    }
    P.on('video-retry', function () { if (vid.up) finishUpload(); });
    P.on('video-remove', function () {
      vid.key = null; vid.poster = null; vid.isNew = true; vid.up = null;
      showVideo(null); if (vInput) vInput.value = '';
      vSay(copyText('st-video-removed'));
      oneVideo();
    });
    if (vInput) vInput.addEventListener('change', async function () {
      var file = vInput.files && vInput.files[0];
      if (!file) return;
      P.show('video-retry', false);
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
      showVideo(m.url, null);
      if (vConsent) vConsent.checked = false;
      if (vKidsYes) vKidsYes.checked = false;
      if (vKidsNo) vKidsNo.checked = false;
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
      oneVideo();
      finishUpload();
    });
    oneVideo();

    // People the member did the action with (from their account).
    var withBoxes = [];
    var withs = mine.withCandidates || [];
    fillList('with', withs, function (row, c) {
      var cb = partIn(row, 'box');
      var nm = partIn(row, 'name');
      if (nm) nm.textContent = c.name;
      if (cb) { cb.value = String(c.id); cb.checked = (s.withMemberIds || []).indexOf(c.id) >= 0; withBoxes.push(cb); }
    });
    P.show('with', withs.length > 0);

    P.show('delete', !!mine.story);
    if (mine.story) P.on('delete', async function () {
      if (!window.confirm(copyText('st-delete-confirm'))) return;
      var rr = await HFB.call('/api/stories/' + mine.story.id, { method: 'DELETE' });
      if (rr.ok) { shown.removeAttribute('data-hf-on'); form.style.display = 'none'; P.show('deleted', true); }
      else say(msg, msgOf(rr), true);
    });
    var draftKey = 'hfb_story:' + slug;
    if (text) {
      try { var d = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (d && !text.value) text.value = d.text || ''; } catch (e) {}
      text.addEventListener('input', function () { try { localStorage.setItem(draftKey, JSON.stringify({ text: text.value })); } catch (e) {} });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      say(msg, '');
      if (fail) fail.style.display = 'none';
      if (!consent || !consent.checked) { say(msg, copyText('st-need-consent'), true); if (consent) consent.focus(); return; }
      var words = text ? text.value : '';
      var link = video ? video.value : '';
      var kidsYes = !!(vKidsYes && vKidsYes.checked), kidsNo = !!(vKidsNo && vKidsNo.checked);
      if (vid.busy || vid.up) { say(msg, copyText('st-video-wait'), true); return; }
      if (vid.key && vid.isNew && !(vConsent && vConsent.checked)) { say(msg, copyText('err-video-consent'), true); if (vConsent) vConsent.focus(); return; }
      if (vid.key && !kidsYes && !kidsNo) { say(msg, copyText('err-video-children'), true); if (vKidsYes) vKidsYes.focus(); return; }
      if (vid.key && link.trim()) { say(msg, copyText('err-one-video'), true); return; }
      if (!words.trim() && !photoKey && !link.trim() && !vid.key) { say(msg, copyText('st-empty'), true); if (text) text.focus(); return; }
      if (submit) { submit.setAttribute('data-hfp-busy', '1'); submit.disabled = true; }
      var body = {
        actionId: slug,
        text: words,
        photoKey: photoKey,
        photoDescription: desc ? desc.value : '',
        videoUrl: link,
        showName: showName ? showName.checked : true,
        consent: true,
        childrenInVideo: vid.key ? kidsYes : undefined,
        withMemberIds: withBoxes.filter(function (b) { return b.checked; }).map(function (b) { return Number(b.value); }),
      };
      if (vid.isNew) { body.videoKey = vid.key; body.posterKey = vid.poster; body.videoConsent = !!(vConsent && vConsent.checked); }
      var rr = await HFB.call('/api/stories', { method: 'POST', body: body });
      if (submit) { submit.removeAttribute('data-hfp-busy'); submit.disabled = false; }
      if (rr.ok) {
        try { localStorage.removeItem(draftKey); } catch (e2) {}
        form.style.display = 'none';
        if (done) { done.style.display = 'block'; done.setAttribute('role', 'status'); }
      } else if (rr.status === 401) {
        HFB.requireSignIn({ kind: 'return', returnTo: back });
      } else { say(msg, msgOf(rr), true); if (fail) fail.style.display = 'block'; }
    }, true);
    say(note, '');
    shown.setAttribute('data-hf-on', '1');
  }

  // ---------------------------------------------------------------------------
  // Do this with me (invite page)
  // ---------------------------------------------------------------------------
  // The page is built in Webflow: the inviter's note, the group line, the first-name
  // form, the "you're in" line with Leave, "See the action" and the list of other
  // actions (for an invite whose action is gone). This fills them and shows the right ones.
  async function invitePage() {
    var titleEl = $('hf-join-title');
    if (!titleEl || titleEl.getAttribute('data-hfp')) return;
    var code = new URLSearchParams(location.search).get('i');
    if (!code) return; // older links (?action=...) keep the page's own behaviour
    titleEl.setAttribute('data-hfp', '1');
    var actionEl = $('hf-join-action');
    var descEl = $('hf-join-desc');
    var inBtn = $('hf-join-in');
    var noteEl = $('hf-join-note');
    if (noteEl) { noteEl.setAttribute('role', 'status'); noteEl.setAttribute('aria-live', 'polite'); }
    var P = partsOf(titleEl.parentNode);
    var form = P.one('[data-hf-form="ask-name"]');
    var nameIn = form && form.querySelector('[data-hf-field="first-name"]');
    var see = P.one('[data-hf-link="see"]');
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (HF.finish) { try { await HF.finish(); } catch (e) {} }

    async function join(firstName) {
      var jr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'POST', guest: true, body: firstName ? { firstName: firstName } : {} });
      if (jr.ok || (jr.data && jr.data.error === 'own_invite')) { P.show('ask-name', false); await render(); return; }
      if (jr.data && jr.data.error === 'need_join_name') { P.show('ask-name', true); if (nameIn) nameIn.focus(); return; }
      say(noteEl, msgOf(jr), true);
    }
    nativeForm(form, async function () {
      var name = nameIn ? nameIn.value.trim() : '';
      if (!name) { if (nameIn) nameIn.focus(); return; }
      var go = form.querySelector('[type=submit]');
      setBusy(go, true);
      await join(name);
      setBusy(go, false);
    });
    P.on('leave', async function (b) {
      setBusy(b, true);
      var lr = await HFB.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'DELETE' });
      setBusy(b, false);
      if (lr.ok) render();
    });

    async function render() {
      ['note', 'group', 'see', 'joined', 'ask-name', 'alternatives'].forEach(function (k) { P.show(k, false); });
      say(noteEl, '');
      inBtn.style.display = '';
      var r = await HFB.call('/api/invites/' + encodeURIComponent(code));
      if (!r.ok) { titleEl.textContent = copyText('inv-invalid-h'); actionEl.textContent = copyText('inv-invalid'); descEl.textContent = ''; inBtn.textContent = copyText('inv-find'); inBtn.href = '/actions'; inBtn.onclick = null; return; }
      var v = r.data;
      var who = v.inviterName || copyText('inv-someone');
      if (!v.action.live) {
        titleEl.textContent = copyText('inv-gone-h');
        actionEl.textContent = v.action.title ? copyText('inv-gone', { title: v.action.title }) : '';
        descEl.textContent = copyText('inv-others');
        inBtn.style.display = 'none';
        fillList('alternatives', v.alternatives || [], function (li, a) { setLink(partIn(li, 'title'), '/action/' + a.slug, a.title); }, 'alternative');
        P.show('alternatives', !!(v.alternatives && v.alternatives.length));
        return;
      }
      actionEl.textContent = v.action.title;
      descEl.textContent = v.action.shortAnswer;
      P.fill('group', v.group ? groupLine(v.group) : '');
      P.show('group', !!v.group);
      if (see) see.setAttribute('href', '/action/' + v.action.slug);
      if (v.me && v.me.isMine) {
        titleEl.textContent = copyText('inv-mine-h');
        inBtn.textContent = copyText('inv-share');
        inBtn.removeAttribute('aria-disabled');
        inBtn.classList.remove('is-disabled');
        inBtn.onclick = function (e) {
          e.preventDefault();
          share({ title: document.title, text: copyText(v.kind === 'with_me' ? 'inv-share-with' : 'inv-share-pass', { name: who, title: v.action.title }), url: location.origin + HFB.base + '/' + code }, noteEl);
        };
        return;
      }
      titleEl.textContent = copyText(v.kind === 'with_me' ? 'inv-with-h' : 'inv-pass-h', { name: who });
      P.fill('note', v.note ? copyText('inv-note', { note: v.note, name: who }) : '');
      P.show('note', !!v.note);
      if (v.me && v.me.joined) {
        inBtn.textContent = copyText('inv-in');
        inBtn.setAttribute('aria-disabled', 'true');
        inBtn.classList.add('is-disabled');
        inBtn.onclick = function (e) { e.preventDefault(); };
        P.fill('joined', copyText('inv-joined', { name: who }) + ' ');
        P.show('joined', true);
        P.show('see', true);
        return;
      }
      inBtn.textContent = copyText('inv-join');
      inBtn.removeAttribute('aria-disabled');
      inBtn.classList.remove('is-disabled');
      inBtn.onclick = function (e) {
        e.preventDefault();
        if (signedIn()) return join();
        // No account needed: just a first name, so the group can see who joined.
        P.show('ask-name', true);
        if (nameIn) nameIn.focus();
      };
    }
    document.addEventListener('hfb:resumed', function () { render(); });
    await render();
  }

  // /stories and each story's page are rendered by Webflow from the CMS (newest
  // first, 20 a page); only their uploaded videos and report links need this script.

  // /actions: "Most done" is a Webflow collection list (Actions by their public done-count,
  // which the backend writes to the CMS every hour). No script needed.



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

  // Active membership: the last known status, so the header avatar can show its ring on every page.
  function rememberActive(a) {
    if (!a || typeof a.active !== 'boolean') return;
    try { localStorage.setItem('hf_active', a.active ? '1' : '0'); } catch (e) {}
    activeRing();
  }
  function activeRing() {
    var on = false;
    try { on = localStorage.getItem('hf_active') === '1'; } catch (e) {}
    on = on && document.documentElement.classList.contains('hf-in');
    document.querySelectorAll('.hf-nav-avatar').forEach(function (a) { a.classList.toggle('is-active', on); });
  }
  function headerAccount() {
    var root = document.documentElement;
    if (root.getAttribute('data-hfp-header')) return;
    root.setAttribute('data-hfp-header', '1');
    if (root.classList.contains('hf-in')) avatarFill(memberSaved());
    activeRing();
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
   * The location picker remembers its choice on this device, and a signed-in member's choice of a
   * place is also their "Home area" on their account (so a new device picks it up). Changing it in
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
      // Picking a place makes it the home area (and the Account box follows); browsing
      // "All locations" leaves the home area alone – only Account can clear it.
      if (!locFromAccount && s.value) {
        saveHomeArea(s.value);
        var home = $('hfp-home-area');
        if (home) home.value = s.value;
      }
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
  // /keep-your-pledge: the message line and both button rows are built in Webflow.
  async function claimPage() {
    var box = $('hf-claim');
    if (!box || box.getAttribute('data-hfp')) return;
    box.setAttribute('data-hfp', '1');
    var P = partsOf(box);
    var msg = P.one('[data-hf-fill="claim-msg"]');
    // The code survives signing up or in (the page reloads, possibly without it).
    var code = new URLSearchParams(location.search).get('c');
    try { if (code) localStorage.setItem('hf_claim', code); else code = localStorage.getItem('hf_claim'); } catch (e) {}
    if (!code) { say(msg, copyText('claim-invalid'), true); return; }
    await wait(function () { return window.HF && window.HFB; }, 10000);
    if (!signedIn()) {
      P.on('signup', function () { if (HF.signup) HF.signup(); else HF.signin(); });
      P.on('signin', function () { HF.signin(); });
      P.show('claim-out', true);
      return;
    }
    say(msg, copyText('claim-working'));
    var r = await HFB.call('/api/pledges/claim', { method: 'POST', body: { code: code } });
    if (!r.ok) { say(msg, msgOf(r), true); return; }
    try { localStorage.removeItem('hf_claim'); } catch (e) {}
    say(msg, r.data.claimed === 1 ? copyText('claim-done-one') : copyText('claim-done-many', { n: r.data.claimed }));
    P.show('claim-done', true);
  }

  // Sign-in window: our own look and wording, with Memberstack doing the work
  // behind it (no Memberstack window or logo). The window itself is built in
  // Webflow, in the Footer component (<dialog id="hfp-auth">): logo, title,
  // Google and email-code buttons, every field, the button, the message line
  // and the links. This shows the parts for each step and talks to Memberstack.
  // Steps: signin, signup, reset, code (new password), otp, otp-code.
  function authError(e, mode) {
    var t = String((e && (e.code || '')) + ' ' + (e && e.message || '')).toLowerCase();
    if (/already|exists|in use|taken/.test(t)) return copyText('auth-err-taken');
    if ((mode === 'reset' || mode === 'otp-code') && /token|code|expired|invalid/.test(t)) return copyText('auth-err-code');
    if (mode === 'otp' && /not found|no member|does not exist/.test(t)) return copyText('auth-otp-no-account');
    if (/weak|at least|length|characters/.test(t)) return copyText('auth-err-password');
    if (/credential|password|not found|no member|invalid/.test(t)) return mode === 'signin' ? copyText('auth-err-wrong') : copyText('auth-err-other');
    return copyText('auth-err-other');
  }
  // Which fields and links each step shows.
  var AUTH_STEPS = {
    signin: { fields: ['email', 'password'], links: ['forgot', 'signup'], providers: true, title: 'auth-signin-title', go: 'auth-signin-button' },
    signup: { fields: ['first-name', 'email', 'password-new'], links: ['signin'], providers: true, title: 'auth-signup-title', go: 'auth-signup-button' },
    reset: { fields: ['email'], links: ['back'], title: 'auth-reset-title', go: 'auth-reset-send' },
    code: { fields: ['code', 'password-new'], links: ['back'], title: 'auth-reset-title', go: 'auth-reset-button' },
    otp: { fields: ['email'], links: ['password'], go: 'auth-reset-send' },
    'otp-code': { fields: ['code'], links: ['password'] },
  };
  var authState = { mode: 'signin', otpFor: 'signin', email: '', name: '', ready: false };

  function openAuth(mode) {
    var m = window.$memberstackDom;
    var dlg = document.getElementById('hfp-auth');
    if (!m) return;
    if (!dlg) { location.href = '/account'; return; }
    var P = partsOf(dlg);
    var form = P.one('[data-hf-form="auth"]');
    var go = form.querySelector('[type=submit]');
    var msg = P.one('[data-hf-fill="auth-msg"]');
    var F = function (n) { return form.querySelector('[data-hf-field="' + n + '"]'); };

    function draw(to) {
      var st = authState;
      st.mode = to;
      var step = AUTH_STEPS[to];
      var forSignup = (to === 'otp' || to === 'otp-code') && st.otpFor === 'signup';
      var fields = step.fields.slice();
      if (to === 'otp' && forSignup) fields.unshift('first-name');
      ['first-name', 'email', 'code', 'password', 'password-new'].forEach(function (n) {
        var on = fields.indexOf(n) >= 0;
        P.show('auth-f-' + n, on);
        var i = F(n);
        if (i) { i.required = on; i.disabled = !on; if (n !== 'email' && n !== 'first-name') i.value = ''; }
      });
      if (F('email') && st.email) F('email').value = st.email;
      if (F('first-name') && st.name) F('first-name').value = st.name;
      ['forgot', 'signup', 'signin', 'password', 'back'].forEach(function (n) { P.show('auth-l-' + n, step.links.indexOf(n) >= 0); });
      P.show('auth-providers', !!step.providers);
      P.fill('auth-title', copyText(step.title || (forSignup ? 'auth-signup-title' : 'auth-signin-title')));
      if (go) { go.textContent = copyText(step.go || (forSignup ? 'auth-signup-button' : 'auth-signin-button')); go.disabled = false; }
      say(msg, '');
      var first = dlg.open && form.querySelector('input:not([disabled])');
      if (first) { first.focus({ preventScroll: true }); dlg.scrollTop = 0; }
    }

    if (!authState.ready) {
      authState.ready = true;
      P.on('auth-close', function () { dlg.close(); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
      P.on('auth-to', function (b) {
        var to = b.getAttribute('data-hf-to');
        if (to === 'password') to = authState.otpFor === 'signup' ? 'signup' : 'signin';
        draw(to);
      });
      P.on('auth-otp', function () { authState.otpFor = authState.mode === 'signup' ? 'signup' : 'signin'; draw('otp'); });
      P.on('auth-google', async function (b) {
        setBusy(b, true);
        try {
          if (authState.mode === 'signup') await m.signupWithProvider({ provider: 'google' });
          else await m.loginWithProvider({ provider: 'google' });
          location.reload();
        } catch (e) { setBusy(b, false); say(msg, authError(e, authState.mode), true); }
      });
      // A Webflow form: taken over before Webflow's own form handling sees it.
      nativeForm(form, async function () {
        var mode2 = authState.mode;
        var v = {};
        Array.prototype.forEach.call(form.querySelectorAll('input[data-hf-field]:not([disabled])'), function (i) { v[i.getAttribute('data-hf-field')] = i.value.trim(); });
        if (Object.keys(v).some(function (k) { return !v[k]; })) { say(msg, copyText('auth-err-fields'), true); return; }
        if (v['password-new'] && v['password-new'].length < 8) { say(msg, copyText('auth-err-password'), true); return; }
        go.disabled = true;
        say(msg, copyText('auth-working'));
        try {
          if (mode2 === 'signin') { await m.loginMemberEmailPassword({ email: v.email, password: v.password }); location.reload(); return; }
          if (mode2 === 'signup') { await m.signupMemberEmailPassword({ email: v.email, password: v['password-new'], customFields: { 'first-name': v['first-name'] } }); location.reload(); return; }
          if (mode2 === 'reset') { await m.sendMemberResetPasswordEmail({ email: v.email }); authState.email = v.email; draw('code'); say(msg, copyText('auth-reset-sent', { email: v.email })); return; }
          if (mode2 === 'code') { await m.resetMemberPassword({ token: v.code, newPassword: v['password-new'] }); draw('signin'); say(msg, copyText('auth-reset-done')); return; }
          if (mode2 === 'otp') {
            if (authState.otpFor === 'signup') await m.sendMemberSignupPasswordlessEmail({ email: v.email });
            else await m.sendMemberLoginPasswordlessEmail({ email: v.email });
            authState.email = v.email;
            authState.name = v['first-name'] || '';
            draw('otp-code');
            say(msg, copyText('auth-otp-sent', { email: v.email }));
            return;
          }
          if (mode2 === 'otp-code') {
            if (authState.otpFor === 'signup') await m.signupMemberPasswordless({ passwordlessToken: v.code, email: authState.email, customFields: { 'first-name': authState.name } });
            else await m.loginMemberPasswordless({ passwordlessToken: v.code, email: authState.email });
            location.reload();
            return;
          }
        } catch (e) {
          go.disabled = false;
          say(msg, authError(e, mode2), true);
        }
      });
    }
    authState.email = '';
    authState.name = '';
    draw(mode === 'signup' ? 'signup' : 'signin');
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
    // Open at the top (logo and title in view), even when the window is taller than the screen.
    var f = form.querySelector('input:not([disabled])');
    if (f) f.focus({ preventScroll: true });
    dlg.scrollTop = 0;
  }
  window.HFP.auth = openAuth;

  /** "Ends in 3 days" / "Ends in 5 hours" / "Ends in 20 minutes". */
  function endsIn(ms) {
    var min = Math.floor(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
    if (d >= 2) return copyText('dare-ends-days', { n: d });
    if (h >= 2) return copyText('dare-ends-hours', { n: h });
    if (h === 1) return copyText('dare-ends-hour');
    if (min >= 1) return copyText('dare-ends-minutes', { n: min });
    return copyText('dare-ends-soon');
  }

  // ---------------------------------------------------------------------------
  // "I did this": a short buzz on phones that can, and the button reads
  // "Done – nice one" for a moment (a Webflow combo class, is-done) before it
  // goes back to "I did this again". No confetti.
  // ---------------------------------------------------------------------------
  function buzz() { try { if (navigator.vibrate) navigator.vibrate([18, 40, 18]); } catch (e) {} }
  // "✓ Done – nice one" for a moment, then the button's label as it is by then
  // (an Undo in the meantime ends the moment early).
  function doneMoment(b, label) {
    if (!b) return;
    clearTimeout(b._hfMoment);
    b.classList.add('is-done');
    b.textContent = copyText('action-done-nice');
    b._hfMoment = setTimeout(function () { endMoment(b, label); }, 2400);
  }
  function endMoment(b, label) {
    if (!b || !b.classList.contains('is-done')) return;
    clearTimeout(b._hfMoment);
    b.classList.remove('is-done');
    b.textContent = label();
  }

  // ---------------------------------------------------------------------------
  // Live line on the home page (built in Webflow, [data-hf-show="live"]): the
  // last few times someone made another person happy, one at a time. No names:
  // only the kind of person and, when known, the place.
  // ---------------------------------------------------------------------------
  function agoText(iso2) {
    var s2 = Math.max(0, (Date.now() - Date.parse(iso2)) / 1000), m = Math.floor(s2 / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (m < 1) return copyText('live-ago-now');
    if (h < 1) return copyText('live-ago-min', { n: m });
    if (d < 1) return copyText('live-ago-hours', { n: h });
    if (d === 1) return copyText('live-ago-yesterday');
    return copyText('live-ago-days', { n: d });
  }
  function placeName(slug2) {
    if (!slug2) return '';
    var o = document.querySelector('#hf-loc option[value="' + slug2.replace(/"/g, '') + '"]');
    return o ? o.textContent.trim() : '';
  }
  function liveLine(item) {
    var place = placeName(item.place);
    var key = 'live-did-' + (item.who || 'any');
    var did = copyText(key) || copyText('live-did-any');
    var who = place ? copyText('live-someone-in', { place: place }) : copyText('live-someone');
    return copyText('live-line', { someone: who, did: did, ago: agoText(item.at) });
  }
  async function liveActivity() {
    var box = document.querySelector('[data-hf-show="live"]');
    if (!box) return;
    var text = box.querySelector('[data-hf-fill="live-line"]');
    await wait(function () { return window.HFB; }, 10000);
    var items = [], at = 0;
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    async function load2() {
      var r = await HFB.call('/api/activity', { auth: false });
      items = r.ok && r.data && r.data.items ? r.data.items : [];
      if (!items.length) { box.removeAttribute('data-hf-on'); return; }
      at = 0;
      if (text) text.textContent = liveLine(items[0]);
      box.setAttribute('data-hf-on', '1');
    }
    function next() {
      if (document.hidden || items.length < 2 || !text) return;
      at = (at + 1) % items.length;
      text.classList.add('is-fading');
      setTimeout(function () { text.textContent = liveLine(items[at]); text.classList.remove('is-fading'); }, 260);
    }
    await load2();
    if (!still) setInterval(next, 6000);
    setInterval(function () { if (!document.hidden) load2(); }, 60000);
  }

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
    // "Ends in 3 days": the dare week ends Sunday 23:59:59 UTC (the line is built in Webflow).
    var dareEnds = null;
    function tickEnds() {
      if (!home) return;
      var shows = home.querySelectorAll('[data-hf-show="dare-ends"]');
      var left = dareEnds ? dareEnds - Date.now() : -1;
      shows.forEach(function (e) { if (left > 0) e.setAttribute('data-hf-on', '1'); else e.removeAttribute('data-hf-on'); });
      if (left <= 0) return;
      var line = home.querySelector('[data-hf-fill="dare-ends"]');
      if (line) line.textContent = endsIn(left);
      // The bar shows how much of the week has gone.
      var bar = home.querySelector('[data-hf-part="dare-bar"]');
      if (bar) bar.style.width = Math.max(2, Math.min(100, 100 - (left / (7 * 24 * 3600e3)) * 100)).toFixed(1) + '%';
    }
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
          dareEnds = d.weekEnd ? Date.parse(d.weekEnd) + 1000 : null;
          tickEnds();
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
    setInterval(function () { if (!document.hidden) tickEnds(); }, 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('hf-done', refresh);
  }

  // ---------------------------------------------------------------------------
  // The shop. Shop page: each drop block in Webflow carries data-hf-drop="<slug>"
  // (bound to the Drops collection); product page: [data-hf-row="product"] with
  // data-hf-product="<handle>". Everything you read is Webflow's; this only shows
  // the right state block (drop-upcoming, drop-early, drop-live, drop-sold-out,
  // product-…), fills times, stock and sizes, and runs Notify me and Buy.
  // ---------------------------------------------------------------------------
  /** "Opens in 3 days" / "in 5 hours" / "in 20 minutes". */
  function opensIn(ms) {
    var min = Math.floor(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
    if (d >= 2) return copyText('shop-opens-days', { n: d });
    if (h >= 2) return copyText('shop-opens-hours', { n: h });
    if (h === 1) return copyText('shop-opens-hour');
    if (min >= 1) return copyText('shop-opens-minutes', { n: min });
    return copyText('shop-opens-soon');
  }
  /** "Fri 4 Dec, 17:00" in the visitor's own time zone. */
  function whenText(iso2) {
    if (!iso2) return '';
    try { return new Date(iso2).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso2; }
  }
  function leftText(left, total) {
    if (left == null) return '';
    return total ? copyText('shop-left-of', { n: left, total: total }) : copyText('shop-left', { n: left });
  }
  var PHASES = ['upcoming', 'early', 'live', 'sold_out'];
  function showPhase(P, prefix, phase, list) {
    (list || PHASES).forEach(function (ph) { P.show(prefix + '-' + ph.replace(/_/g, '-'), phase === ph); });
  }
  function notifyButtons(P, on) {
    P.acts('notify').forEach(function (b) {
      b.textContent = copyText(on ? 'shop-notified' : 'shop-notify');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  /** Notify me (or stop): signed out, it goes to sign-in and comes back here. */
  async function toggleNotify(b, slug, on, msg) {
    if (!signedIn()) { say(msg, copyText('shop-notify-signin')); return HFB.requireSignIn({ kind: 'return' }); }
    setBusy(b, true);
    var r = await HFB.call('/api/shop/notify', { method: 'POST', body: { drop: slug, on: on } });
    setBusy(b, false);
    if (!r.ok) { say(msg, msgOf(r), true); return null; }
    say(msg, on ? copyText('shop-notify-saved') : '');
    return r.data.notified;
  }

  async function shopPage() {
    var blocks = [].slice.call(document.querySelectorAll('[data-hf-drop]'));
    if (!blocks.length || blocks[0].getAttribute('data-hfp')) return;
    await wait(function () { return window.HFB; }, 10000);
    var data = null;
    function draw() {
      blocks.forEach(function (b) {
        var P = partsOf(b);
        var d = data && data.drops.filter(function (x) { return x.drop === b.getAttribute('data-hf-drop'); })[0];
        if (!d) return;
        showPhase(P, 'drop', d.phase);
        P.fill('drop-early-at', whenText(d.earlyAt));
        P.fill('drop-at', whenText(d.dropDate));
        var to = d.phase === 'upcoming' ? d.earlyAt : d.phase === 'early' ? d.dropDate : null;
        P.fill('drop-countdown', to ? opensIn(Date.parse(to) - Date.now()) : '');
        // The home hero's countdown: days, hours and minutes in their own boxes, until the drop opens to everyone.
        P.show('drop-count', !!to);
        var ms = to ? Math.max(0, Date.parse(to) - Date.now()) : 0;
        P.fill('drop-days', String(Math.floor(ms / 864e5)));
        P.fill('drop-hours', String(Math.floor(ms / 36e5) % 24).padStart(2, '0'));
        P.fill('drop-minutes', String(Math.floor(ms / 6e4) % 60).padStart(2, '0'));
        P.fill('drop-left', leftText(d.left, d.quantity));
        P.all('[data-hf-part="drop-bar"]').forEach(function (bar) {
          bar.style.width = d.left != null && d.quantity ? Math.round((100 * d.left) / d.quantity) + '%' : '100%';
        });
        // Buy goes to the lead piece's page once buying is open (Webflow keeps its handle in data-hf-lead).
        P.all('[data-hf-lead]').forEach(function (a) {
          var h = a.getAttribute('data-hf-lead');
          if (h && (d.phase === 'early' || d.phase === 'live')) a.setAttribute('href', '/product/' + encodeURIComponent(h));
        });
        notifyButtons(P, d.notified);
        P.show('drop-notify', d.phase === 'upcoming' || d.phase === 'early');
      });
    }
    async function load() {
      var r = await HFB.call('/api/drops');
      if (r.ok) { data = r.data; draw(); }
      progress();
    }
    // The early-access strip: a signed-in member's own way there.
    async function progress() {
      var lines = [].slice.call(document.querySelectorAll('[data-hf-fill="drop-progress"]'));
      if (!lines.length) return;
      var A = null;
      if (signedIn()) {
        var me = await HFB.call('/api/me');
        A = me.ok ? me.data.active : null;
      }
      lines.forEach(function (el) {
        var t = '';
        if (A) {
          if (A.active) t = copyText('drop-progress-active');
          else if (A.weeksDone === 0) t = copyText('drop-progress-start');
          else if (A.toGo === 1) t = copyText('drop-progress-to-go-one', { n: A.weeksDone });
          else t = copyText('drop-progress-to-go', { n: A.weeksDone, left: A.toGo });
        }
        el.textContent = t;
        var box = el.closest('[data-hf-show="drop-progress"]');
        if (box) { if (t) box.setAttribute('data-hf-on', '1'); else box.removeAttribute('data-hf-on'); }
      });
    }
    blocks.forEach(function (b) {
      b.setAttribute('data-hfp', '1');
      var P = partsOf(b);
      P.on('notify', async function (btn) {
        var d = data && data.drops.filter(function (x) { return x.drop === b.getAttribute('data-hf-drop'); })[0];
        if (!d) return;
        var now = await toggleNotify(btn, d.drop, !d.notified, P.one('[data-hf-fill="drop-msg"]'));
        if (now !== null && now !== undefined) { d.notified = now; draw(); }
      });
    });
    await load();
    setInterval(function () {
      if (document.hidden || !data) return;
      // A phase may have changed (early access opened, the drop opened): ask again then.
      var turn = data.drops.some(function (d) { return [d.earlyAt, d.dropDate].some(function (t) { return t && Date.parse(t) <= Date.now() && Date.parse(t) > Date.now() - 30000; }); });
      if (turn) load(); else draw();
    }, 20000);
    document.addEventListener('hfb:resumed', load);
  }

  /** The shop's "Always available" section (in Webflow) shows once it has a product in it. */
  function evergreenSection() {
    document.querySelectorAll('[data-hf-show="evergreen"]').forEach(function (sec) {
      if (sec.querySelector('.hf-shop-card:not(.w-condition-invisible)')) sec.setAttribute('data-hf-on', '1');
    });
  }

  /** The dot next to Shop in the menu (in Webflow): on while a drop is coming up or on sale. */
  // Links Webflow can't point at a CMS item (inside a nested list or a component) carry the
  // item's slug, bound in Webflow: data-hf-product-link (drop pieces) and
  // data-hf-action-link (the Action of the month component).
  var ITEM_LINKS = { 'data-hf-product-link': '/product/', 'data-hf-action-link': '/action/' };
  function productLinks() {
    Object.keys(ITEM_LINKS).forEach(function (attr) {
      document.querySelectorAll('a[' + attr + ']').forEach(function (a) {
        var slug = a.getAttribute(attr);
        if (slug) a.setAttribute('href', ITEM_LINKS[attr] + encodeURIComponent(slug));
      });
    });
  }

  // "Something to do" on /account (built in Webflow: .hf-take with one card per slide, and dots):
  // one card at a time, turning every 8 seconds. It pauses while someone points at it, focuses
  // it or has just swiped, and stays put for people who prefer less motion. Empty slides are skipped.
  var TAKE_MS = 8000;
  function takeRotator() {
    var row = document.querySelector('.hf-take');
    if (!row || row.getAttribute('data-hfp')) return;
    row.setAttribute('data-hfp', '1');
    var dotsBox = document.querySelector('[data-hf-show="take-dots"]');
    var dots = dotsBox ? [].slice.call(dotsBox.querySelectorAll('[data-hf-act="take-go"]')) : [];
    function live() {
      return [].slice.call(row.children).map(function (el, i) { return { el: el, dot: dots[i] }; })
        .filter(function (x) { return x.el.offsetHeight > 0 && x.el.querySelector('*') && [].slice.call(x.el.querySelectorAll('*')).some(function (c) { return c.offsetHeight > 0; }); });
    }
    var at = 0, paused = false, lastTouch = 0;
    function show(i, smooth) {
      var list = live();
      if (!list.length) return;
      at = (i + list.length) % list.length;
      var target = list[at].el;
      row.scrollTo({ left: target.offsetLeft - row.offsetLeft, behavior: smooth === false ? 'auto' : 'smooth' });
      mark(list);
    }
    function mark(list) {
      dots.forEach(function (d) { d.style.display = 'none'; d.removeAttribute('aria-current'); });
      list.forEach(function (x, j) { if (x.dot) { x.dot.style.display = ''; if (j === at) x.dot.setAttribute('aria-current', 'true'); } });
      if (dotsBox) { if (list.length > 1) dotsBox.setAttribute('data-hf-on', '1'); else dotsBox.removeAttribute('data-hf-on'); }
    }
    dots.forEach(function (d) {
      d.addEventListener('click', function () {
        var list = live();
        var j = list.map(function (x) { return x.dot; }).indexOf(d);
        lastTouch = Date.now();
        if (j >= 0) show(j);
      });
    });
    // Keep the dots right after a swipe.
    var settle = null;
    row.addEventListener('scroll', function () {
      clearTimeout(settle);
      settle = setTimeout(function () {
        var list = live();
        var best = 0, dist = Infinity;
        list.forEach(function (x, j) { var d = Math.abs(x.el.offsetLeft - row.offsetLeft - row.scrollLeft); if (d < dist) { dist = d; best = j; } });
        at = best; mark(list);
      }, 120);
    });
    ['pointerdown', 'touchstart', 'wheel'].forEach(function (ev) { row.addEventListener(ev, function () { lastTouch = Date.now(); }, { passive: true }); });
    row.addEventListener('mouseenter', function () { paused = true; });
    row.addEventListener('mouseleave', function () { paused = false; });
    row.addEventListener('focusin', function () { paused = true; });
    row.addEventListener('focusout', function () { paused = false; });
    show(0, false);
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calm) return;
    setInterval(function () {
      if (paused || document.hidden || Date.now() - lastTouch < TAKE_MS * 2) return;
      if (live().length > 1) show(at + 1);
    }, TAKE_MS);
  }

  // The finder on /account is a plain form that opens /actions?time=…&who=…&occasion=…
  // Here, once the finder (Webflow embed) has filled its dropdowns, those choices are applied
  // and the results shown, as if the visitor had chosen them on this page.
  async function finderFromLink() {
    var q = new URLSearchParams(location.search);
    if (!q.get('time') && !q.get('who') && !q.get('occasion')) return;
    var time = document.getElementById('hf-time');
    var who = document.getElementById('hf-who');
    if (!time || !who || time.getAttribute('data-hfp')) return;
    time.setAttribute('data-hfp', '1');
    await wait(function () { return who.options.length > 1; }, 5000);
    [['hf-time', 'time'], ['hf-who', 'who'], ['hf-occasion', 'occasion']].forEach(function (x) {
      var el = document.getElementById(x[0]);
      var v = q.get(x[1]);
      if (!el || !v || ![].some.call(el.options, function (o) { return o.value === v; })) return;
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    var show = document.getElementById('hf-show');
    if (show) show.click();
    var box = document.getElementById('find') || time;
    box.scrollIntoView({ block: 'start' });
  }

  // "Did something kind that isn't here? Log your own" (in the finder, home and /actions):
  // shown at the bottom of the results once you have searched. It opens /log-your-own,
  // with who you searched for already chosen.
  function ownLink() {
    var links = [].slice.call(document.querySelectorAll('[data-hf-show="own-link"]'));
    var show = document.getElementById('hf-show');
    if (!links.length || !show || show.getAttribute('data-hfp-own')) return;
    show.setAttribute('data-hfp-own', '1');
    show.addEventListener('click', function () {
      setTimeout(function () {
        var who = document.getElementById('hf-who');
        var w = who && who.value ? who.value.replace(/\s+/g, '-') : '';
        links.forEach(function (l) {
          var a = l.querySelector('a') || l;
          a.setAttribute('href', '/log-your-own' + (w ? '?who=' + encodeURIComponent(w) : ''));
          l.setAttribute('data-hf-on', '1');
        });
      }, 300);
    });
  }

  // The share card after logging your own: the same card as on action pages,
  // linking to the site (there is no action page yet), with your share code.
  function ownName() {
    var m = memberSaved() || {};
    return (m.customFields && m.customFields['first-name']) || null;
  }
  function ownCard(P, proof) {
    var blob = null;
    var nameBox = P.one('[data-hf-field="proof-name"]');
    var canFiles = false;
    try { canFiles = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })); } catch (e) {}
    var url = location.origin + '/' + (proof.ref ? '?r=' + proof.ref : '');
    async function paint() {
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
      var line = cardLine(proof.who, nameBox && nameBox.checked ? proof.name : null);
      var c = drawCard({ line: line, title: proof.title, logo: await loadLogo() });
      P.show('proof-name', !!proof.name);
      P.show('card-share', canFiles);
      P.show('card-hint', !canFiles);
      if (!c) { P.show('proof', false); return line; }
      var slot = P.slot('proof');
      var img = slot && slot.querySelector('img');
      if (slot && !img) { img = document.createElement('img'); img.className = 'hf-fill-media'; slot.appendChild(img); }
      if (img) { img.alt = line; img.src = c.toDataURL('image/png'); }
      blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
      P.show('proof', true);
      return line;
    }
    if (nameBox) nameBox.addEventListener('change', paint);
    P.on('card-share', async function () {
      var line = await paint();
      var file = blob && window.File ? new File([blob], 'happiness.png', { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], text: copyText('card-share-text', { line: line, url: url }), url: url }); } catch (e) {}
      }
    });
    P.on('card-download', async function () {
      await paint();
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'happiness.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    paint();
  }

  // Log your own (/log-your-own, built in Webflow: #own). Logging it counts for you
  // now (one a day) and sends it to review; while you type, close matches among the
  // site's actions are offered instead.
  async function ownAction() {
    var box = document.getElementById('own');
    if (!box || box.getAttribute('data-hfp')) return;
    box.setAttribute('data-hfp', '1');
    var P = partsOf(box);
    var form = P.one('[data-hf-part="own-form"]');
    var text = document.getElementById('own-text');
    var msg = P.one('[data-hf-fill="own-msg"]');
    if (!form || !text) return;
    form.addEventListener('submit', function (e) { e.preventDefault(); }, true);
    forgetDrafts();
    clearOnLeave(form);
    var pick = new URLSearchParams(location.search).get('who');
    function preselect() { if (pick && form.elements.who.querySelector('option[value="' + pick.replace(/"/g, '') + '"]')) form.elements.who.value = pick; }
    preselect();
    window.addEventListener('load', preselect);
    await wait(function () { return window.HF && window.HFB; }, 10000);
    P.show('signin-note', !signedIn());
    var timer = null;
    var asked = '';
    text.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(async function () {
        var q = text.value.trim();
        if (q === asked) return;
        asked = q;
        if (q.length < 4) { P.show('own-matches', false); return; }
        var r = await HFB.call('/api/actions/match?q=' + encodeURIComponent(q), { auth: false });
        if (asked !== q) return;
        var list = (r.ok && r.data && r.data.matches) || [];
        fillList('own-matches', list, function (a, m) { a.textContent = m.title; a.setAttribute('href', '/action/' + m.slug); });
        P.show('own-matches', list.length > 0);
      }, 350);
    });
    form.addEventListener('submit', async function () {
      say(msg, '');
      var t = text.value.trim();
      if (t.length < 3) { say(msg, copyText('own-empty'), true); text.focus(); return; }
      if (!signedIn()) return HFB.requireSignIn({ kind: 'return', returnTo: location.pathname + location.search });
      var b = form.querySelector('[type=submit]');
      setBusy(b, true);
      var r = await HFB.call('/api/own-actions', { method: 'POST', body: { text: t, who: form.elements.who.value, people: form.elements.people.value } });
      setBusy(b, false);
      if (r.ok) {
        var who = form.elements.who.value || null;
        form.reset();
        form.style.display = 'none';
        P.show('own-matches', false);
        P.show('own-done', true);
        P.acts('own-story').forEach(function (a) { a.setAttribute('href', '/share-your-story?action=own-' + r.data.id); });
        ownCard(P, { who: who, title: t, ref: r.data.refCode, name: ownName() });
      } else if (r.status === 401) HFB.requireSignIn({ kind: 'return', returnTo: location.pathname + location.search });
      else say(msg, msgOf(r), true);
    });
  }

  async function shopDot() {
    var dots = [].slice.call(document.querySelectorAll('[data-hf-show="shop-open"]'));
    if (!dots.length || dots[0].getAttribute('data-hfp')) return;
    dots.forEach(function (d) { d.setAttribute('data-hfp', '1'); });
    await wait(function () { return window.HFB; }, 10000);
    var r = await HFB.call('/api/drops');
    var on = !!(r.ok && r.data.drops.some(function (d) { return d.phase === 'upcoming' || d.phase === 'early' || d.phase === 'live'; }));
    dots.forEach(function (d) { if (on) d.setAttribute('data-hf-on', '1'); else d.removeAttribute('data-hf-on'); });
  }

  async function productPage() {
    var row = document.querySelector('[data-hf-row="product"]');
    if (!row || row.getAttribute('data-hfp')) return;
    row.setAttribute('data-hfp', '1');
    var handle = row.getAttribute('data-hf-product') || slugFromPath();
    var P = partsOf(row.closest('section') || document.body);
    var sizes = P.one('[data-hf-field="variant"]');
    var msg = P.one('[data-hf-fill="product-msg"]');
    await wait(function () { return window.HFB; }, 10000);
    var st = null;
    function draw() {
      showPhase(P, 'product', st.status, PHASES.concat(['not_for_sale']));
      P.show('product-buy', st.canBuy);
      P.show('product-locked', !st.canBuy && st.status === 'early');
      var why = st.reason ? 'err-buy-' + String(st.reason).split('_').join('-') : '';
      P.fill('product-locked-why', !st.canBuy && why ? copyText(why) : '');
      var d = st.drop;
      P.fill('product-early-at', d ? whenText(d.earlyAt) : '');
      P.fill('product-drop-at', d ? whenText(d.dropDate) : '');
      var to = d ? (st.status === 'upcoming' ? d.earlyAt : st.status === 'early' ? d.dropDate : null) : null;
      P.fill('product-countdown', to ? opensIn(Date.parse(to) - Date.now()) : '');
      // Before it opens: the edition size; once on sale: how many are left.
      P.fill('product-left', st.status === 'upcoming' ? (st.edition ? copyText('shop-edition', { n: st.edition }) : '') : leftText(st.left, st.edition));
      P.show('product-sizes', st.variants.length > 1);
      if (sizes && st.variants.length > 1) {
        var keep = sizes.value;
        sizes.innerHTML = '';
        var first = document.createElement('option');
        first.value = '';
        first.textContent = copyText('shop-size-pick');
        sizes.appendChild(first);
        st.variants.forEach(function (v) {
          var o = document.createElement('option');
          o.value = v.id;
          o.textContent = v.available ? v.title : copyText('shop-size-sold-out', { size: v.title });
          o.disabled = !v.available;
          sizes.appendChild(o);
        });
        if (keep) sizes.value = keep;
      }
      notifyButtons(P, st.notified);
      P.show('product-notify', !!d && (st.status === 'upcoming' || st.status === 'early') && !st.canBuy);
    }
    async function load() {
      var r = await HFB.call('/api/shop/products/' + encodeURIComponent(handle));
      if (r.ok) { st = r.data; draw(); }
    }
    P.on('buy', async function (b) {
      if (!st || !st.canBuy || b.getAttribute('aria-busy')) return;
      var v = st.variants.length === 1 ? st.variants[0].id : sizes && sizes.value;
      if (!v) { say(msg, copyText('err-invalid-variant'), true); if (sizes) sizes.focus(); return; }
      setBusy(b, true);
      say(msg, copyText('shop-buying'));
      var r = await HFB.call('/api/shop/checkout', { method: 'POST', body: { variant: v } });
      if (r.ok && r.data && r.data.checkoutUrl) { location.href = r.data.checkoutUrl; return; }
      setBusy(b, false);
      say(msg, msgOf(r), true);
      load();
    });
    P.on('notify', async function (b) {
      if (!st || !st.drop) return;
      var now = await toggleNotify(b, st.drop.slug, !st.notified, msg);
      if (now !== null && now !== undefined) { st.notified = now; draw(); }
    });
    await load();
    setInterval(function () {
      if (document.hidden || !st) return;
      var d = st.drop;
      var turn = d && [d.earlyAt, d.dropDate].some(function (t) { return t && Date.parse(t) <= Date.now() && Date.parse(t) > Date.now() - 30000; });
      if (turn) load(); else draw();
    }, 20000);
    document.addEventListener('hfb:resumed', load);
  }

  function start() {
    // Pages that had their own embed code switch over once that code is
    // replaced in Webflow by the marker <div data-hf-pages hidden></div>.
    var marked = !!document.querySelector('[data-hf-pages]');
    var parts = [emptyLists, shorterAlsoFits, rememberLocation, headerAccount, impactNumbers, claimPage, invitePage, weeklyDare, liveActivity, cmsClips, shopPage, shopDot, productLinks, takeRotator, ownLink, finderFromLink, ownAction, evergreenSection, productPage];
    if (marked) parts.push(actionPage, accountPage, suggestPage, storyPage);
    parts.forEach(function (f) {
      try { var p = f(); if (p && p.catch) p.catch(function (e) { console.error('[hf-pages]', e); }); } catch (e) { console.error('[hf-pages]', e); }
    });
  }
  // Start once the page and the interface text are there
  // (and Memberstack, which says who is signed in).
  function go() {
    wait(function () { return window.HFW && (window.$memberstackDom || !document.querySelector('script[data-memberstack-app]')); }, 10000).then(start);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
