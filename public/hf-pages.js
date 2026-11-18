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
  // Native parts. Everything visible is built in Webflow; this script only
  // fills it in and shows or hides it:
  //   [data-hf-show="x"]  hidden until turned on (data-hf-on)
  //   [data-hf-fill="x"]  receives text
  //   [data-hf-act="x"]   a button or link this script handles
  //   [data-hf-slot="x"]  a holder for drawn or loaded content (a picture, a video)
  //   [data-hf-template]  a hidden design the script copies for each item (stories)
  // ---------------------------------------------------------------------------
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
      ring.dots.forEach(function (title, j) {
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
      var c = drawCard({ line: line, title: proof.title });
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
        say(msg, copyText(r.data.tally === 1 ? 'action-tally-one' : 'action-tally-many', { n: r.data.tally }));
        showWin(r.data);
        window.dispatchEvent(new Event('hf-done'));
        await load();
      } else if (r.status === 401) ask('done');
      else say(msg, msgOf(r), true);
    });

    P.on('undo', async function (b) {
      if (!id) return;
      setBusy(b, true);
      var r = await HFB.call('/api/actions/' + id + '/done', { method: 'DELETE' });
      setBusy(b, false);
      if (!r.ok) return say(msg, msgOf(r), true);
      won = false;
      P.show('win', false);
      await load();
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

  function renderAccount(me) {
    photoRow();
    homeAreaRow(me);
    var inn = $('hf-acct-in');
    if ($('hf-name')) $('hf-name').textContent = me.name || me.firstName || copyText('acct-there');
    if ($('hf-tally')) $('hf-tally').textContent = String(me.tally);
    var P = partsOf(inn);
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
    var firstDone = [];
    var times = {};
    (me.done || []).forEach(function (d) {
      if (!times[d.actionId]) firstDone.push(d);
      times[d.actionId] = (times[d.actionId] || 0) + 1;
    });
    fillList('done', firstDone, function (li, d) {
      var live = d.slug && d.actionStatus === 'published';
      setLink(partIn(li, 'title'), live ? '/action/' + d.slug : null, d.title);
      var meta = partIn(li, 'meta');
      if (meta) meta.textContent = day(d.doneAt) + (times[d.actionId] > 1 ? ' · ' + copyText('acct-times', { n: times[d.actionId] }) : '');
      var s = storyFor[d.actionId];
      var chip = partIn(li, 'story');
      if (live && chip) {
        chip.setAttribute('href', '/share-your-story?action=' + encodeURIComponent(d.slug));
        var label = partIn(chip, 'story-label');
        if (label) label.textContent = copyText(s ? 'story-edit' : 'story-share');
      } else drop(chip);
      var state = partIn(li, 'story-state');
      if (s && state) state.textContent = copyText(s.status === 'approved' ? 'acct-story-approved' : s.status === 'rejected' ? 'acct-story-rejected' : 'acct-story-review');
      else drop(state);
    });

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
    // Right before the video link field (with its label and help), so the two video options sit together.
    var vLabel = video && form.querySelector('label[for="' + video.id + '"]');
    var vGroup = video && video.parentNode !== form ? video.parentNode : null;
    if (vGroup && vGroup !== form && vGroup.tagName !== 'FORM' && vGroup.contains(vLabel || video)) vGroup.insertAdjacentElement('beforebegin', vBox);
    else if (vLabel) vLabel.insertAdjacentElement('beforebegin', vBox);
    else if (video) video.insertAdjacentElement('afterend', vBox);
    else form.insertBefore(vBox, form.firstChild);
    // One video per story: an upload or a link. Whichever is in use greys out the other.
    var linkNote = el('p', { class: 'hf-form-help hfp-small', style: 'display:none', text: copyText('st-video-link-off') });
    var fileNote = el('p', { class: 'hf-form-help hfp-small', style: 'display:none', text: copyText('st-video-file-off') });
    if (video) video.insertAdjacentElement('afterend', linkNote);
    vInput.insertAdjacentElement('afterend', fileNote);
    function oneVideo() {
      var hasFile = !!(vid.key || vid.up || vid.busy);
      var hasLink = !!(video && video.value.trim());
      if (video) { video.disabled = hasFile; linkNote.style.display = hasFile ? '' : 'none'; }
      vInput.disabled = hasLink && !hasFile;
      fileNote.style.display = hasLink && !hasFile ? '' : 'none';
    }
    if (video) video.addEventListener('input', oneVideo);
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
        if (!c.ok) { vSay(msgOf(c), true); vid.up = null; vInput.value = ''; vPrev.style.display = 'none'; vAsk.style.display = 'none'; oneVideo(); return; }
        vid.key = c.data.videoKey; vid.isNew = true; vid.up = null;
        vSay(copyText('st-video-added'));
        vRemove.style.display = '';
        oneVideo();
      } catch (e) {
        vSay((e && e.message) || copyText('st-video-stopped'), true); vRetry.style.display = '';
      } finally { vid.busy = false; }
    }
    vRetry.addEventListener('click', function () { if (vid.up) finishUpload(); });
    vRemove.addEventListener('click', function () {
      vid.key = null; vid.poster = null; vid.isNew = true; vid.up = null;
      vPrev.removeAttribute('src'); vPrev.style.display = 'none'; vRemove.style.display = 'none'; vAsk.style.display = 'none'; vInput.value = '';
      vSay(copyText('st-video-removed'));
      oneVideo();
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
      oneVideo();
      finishUpload();
    });
    oneVideo();

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
      if (vid.key && link.trim()) { msg.textContent = copyText('err-one-video'); msg.setAttribute('data-kind', 'error'); return; }
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
        inBtn.onclick = function (e) { e.preventDefault(); };
        P.fill('joined', copyText('inv-joined', { name: who }) + ' ');
        P.show('joined', true);
        P.show('see', true);
        return;
      }
      inBtn.textContent = copyText('inv-join');
      inBtn.removeAttribute('aria-disabled');
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
    var parts = [emptyLists, shorterAlsoFits, rememberLocation, headerAccount, impactNumbers, claimPage, invitePage, weeklyDare, cmsClips];
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
