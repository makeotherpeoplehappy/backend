/*
 * Happiness Foundation backend helper for the Webflow site, loaded by the
 * site's loader script. Sign-in is Memberstack's (its script is in the site
 * head; window.$memberstackDom); window.HF below wraps it for the site.
 *   <script src="/join/hf-backend.js" data-turnstile-sitekey="..." defer></script>
 *
 * window.HFB gives the site:
 *   HFB.call(path, opts)        one backend call, with sign-in token and one-time key
 *   HFB.button(el, run)         one click makes one record (double clicks ignored, retries reuse the key)
 *   HFB.requireSignIn(intent)   remember a signed-out click, then go to sign-in
 *   HFB.resume()                after sign-in, finish the remembered click once
 *   HFB.keepDraft(form)         keep typed text if sign-in expires mid-form
 *   HFB.guest()                 true when this device has marks made before signing in
 *
 * Try before sign-up: signed out, "I did this" is saved against a random guest
 * key kept on this device (localStorage and a cookie). After sign-in the first
 * call moves those marks to the account, then the key is forgotten.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var BASE = (script && script.src ? new URL(script.src).pathname : '/join/hf-backend.js').replace(/\/hf-backend\.js$/, '');
  var SITEKEY = script && script.getAttribute('data-turnstile-sitekey');
  var INTENT_KEY = 'hfb_intent';
  var LOCAL_KEY = 'hfb_local_intent';

  // Sign-in with Memberstack. window.HF keeps the shape the site's scripts use:
  // token() is the member's Memberstack token (checked by the backend),
  // signin() and signup() open our own sign-in window (HFP.auth in hf-pages.js),
  // signout() signs out and goes home.
  function ms() { return window.$memberstackDom || null; }
  function openAuth(mode) {
    if (window.HFP && window.HFP.auth) return window.HFP.auth(mode);
    var m = ms();
    if (m) m.openModal(mode === 'signup' ? 'SIGNUP' : 'LOGIN').then(function (r) { try { m.hideModal(); } catch (e) {} if (r && (r.type === 'LOGIN' || r.type === 'SIGNUP')) location.reload(); });
  }
  window.HF = {
    token: function () {
      var m = ms();
      var t = m && m.getMemberCookie ? m.getMemberCookie() : null;
      return t ? { a: t } : null;
    },
    signin: function () { openAuth('signin'); },
    /** Create-an-account window; signed up, the page reloads. */
    signup: function () { openAuth('signup'); },
    finish: async function () { return false; },
    load: async function () {
      var m = ms();
      if (!m) return null;
      var r = await m.getCurrentMember();
      return r && r.data ? { id: r.data.id } : null;
    },
    signout: async function () {
      var m = ms();
      // The account page keeps a copy of the member's data on this device; it goes with the sign-in.
      try { localStorage.removeItem('hfp_me'); } catch (e) {}
      try { if (m) await m.logout(); } catch (e) {}
      location.href = '/';
    },
    sync: function () { return window.HFB && window.HFB.sync ? window.HFB.sync() : Promise.resolve(null); },
  };
  /** True once Memberstack has loaded (or when the page has no Memberstack). */
  function signInReady() { return !!ms() || !document.querySelector('script[data-memberstack-app]'); }

  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // --- Guest key (try before sign-up) ---------------------------------------
  var GUEST = 'hf_guest';
  var GUEST_DAYS = 30;
  var GUEST_RE = /^[A-Za-z0-9-]{20,64}$/;
  function cookieGuest() {
    var m = null;
    try { m = String(document.cookie || '').match(/(?:^|;\s*)hf_guest=([^;]+)/); } catch (e) {}
    return m && GUEST_RE.test(m[1]) ? m[1] : null;
  }
  function keepGuest(k) {
    store(GUEST, k);
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    try { document.cookie = GUEST + '=' + (k || '') + '; Path=/; SameSite=Lax' + secure + '; Max-Age=' + (k ? GUEST_DAYS * 86400 : 0); } catch (e) {}
  }
  /** This device's guest key; with `create`, makes one. */
  function guestKey(create) {
    var k = read(GUEST);
    if (!k || !GUEST_RE.test(k)) k = cookieGuest();
    if (!k && create) k = newKey();
    if (k) keepGuest(k); // refreshes the cookie's 30 days
    return k;
  }
  var claiming = null;
  /** Signed in with a guest key on this device: move its marks to the account, once. */
  function claimGuest(t) {
    var k = guestKey(false);
    if (!k) return Promise.resolve(null);
    if (!claiming) {
      claiming = (async function () {
        try {
          var res = await fetch(BASE + '/api/me/claim-guest', { method: 'POST', headers: { Accept: 'application/json', Authorization: 'Bearer ' + t, 'X-HF-Guest': k, 'Idempotency-Key': 'claim-' + k } });
          // Kept for another try only when the server could not be reached or was down.
          if (res.status < 500) keepGuest(null);
          return res.ok ? res.json() : null;
        } catch (e) {
          return null;
        } finally {
          claiming = null;
        }
      })();
    }
    return claiming;
  }

  function newKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function token() {
    var t = window.HF && window.HF.token && window.HF.token();
    return t && t.a ? t.a : null;
  }

  // Memberstack keeps its own session; the token is read fresh each call.
  async function freshToken() {
    await waitFor(signInReady, 10000);
    return token();
  }

  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function check() {
        if (test()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(check, 50);
      })();
    });
  }

  async function turnstileToken() {
    await waitFor(function () { return !!window.turnstile; }, 5000);
    return new Promise(function (resolve) {
      if (!SITEKEY || !window.turnstile) return resolve(null);
      var box = document.createElement('div');
      // Invisible widgets still need a box that is part of the page.
      box.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
      document.body.appendChild(box);
      window.turnstile.render(box, {
        sitekey: SITEKEY,
        execution: 'execute',
        callback: function (t) { resolve(t); setTimeout(function () { box.remove(); }, 0); },
        'error-callback': function () { resolve(null); box.remove(); },
      });
      window.turnstile.execute(box);
    });
  }

  /**
   * One backend call. Writes get a one-time key; pass the same `key` when
   * retrying so the server records it once. Resolves to { ok, status, data }.
   */
  async function call(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = { Accept: 'application/json' };
    var t = opts.auth === false ? null : await freshToken();
    if (t) {
      headers.Authorization = 'Bearer ' + t;
      if (guestKey(false)) await claimGuest(t);
    } else if (opts.auth !== false) {
      var g = guestKey(!!opts.guest);
      if (g) headers['X-HF-Guest'] = g;
    }
    if (method !== 'GET') headers['Idempotency-Key'] = opts.key || newKey();
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.headers) Object.keys(opts.headers).forEach(function (h) { if (opts.headers[h]) headers[h] = opts.headers[h]; });
    if (opts.turnstile) {
      var tt = await turnstileToken();
      if (tt) headers['CF-Turnstile-Response'] = tt;
    }
    for (var attempt = 0; attempt < 4; attempt++) {
      var res;
      try {
        res = await fetch(BASE + path, { method: method, headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      } catch (e) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      var data = null;
      try { data = await res.json(); } catch (e) {}
      // The first click is still being saved, or a service is briefly down: try again.
      if ((res.status === 409 && data && data.error === 'in_progress') || res.status === 503) { await sleep(800 * (attempt + 1)); continue; }
      return { ok: res.ok, status: res.status, data: data };
    }
    return { ok: false, status: 0, data: { error: 'network', message: copy('error-offline') } };
  }

  /**
   * Interface text from src/wording/en.json, served as /join/hf-wording.js
   * (window.HFW, loaded below). {name}-style parts are filled in from vars.
   */
  function copy(key, vars) {
    var t = (window.HFW && window.HFW[key]) || '';
    if (vars) Object.keys(vars).forEach(function (k) { t = t.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k])); });
    return t;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Shows a message as text next to the control (not only as colour). */
  function say(el, text, kind) {
    if (!el) return;
    var id = el.getAttribute('aria-describedby');
    var msg = id && document.getElementById(id);
    if (!msg) {
      msg = document.createElement('p');
      msg.id = 'hfb-msg-' + newKey().slice(0, 8);
      msg.setAttribute('role', 'status');
      msg.setAttribute('aria-live', 'polite');
      el.insertAdjacentElement('afterend', msg);
      el.setAttribute('aria-describedby', msg.id);
    }
    msg.textContent = text || '';
    msg.setAttribute('data-kind', kind || 'info');
  }

  /**
   * Wires a button so one click makes one record. `run(key)` must call
   * HFB.call with that key. Double clicks while saving are ignored.
   */
  function button(el, run) {
    var busy = false;
    el.addEventListener('click', async function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      el.setAttribute('aria-busy', 'true');
      el.setAttribute('aria-disabled', 'true');
      var key = newKey();
      try {
        var r = await run(key);
        if (r && !r.ok && r.data && r.data.message) say(el, r.data.message, 'error');
      } finally {
        busy = false;
        el.removeAttribute('aria-busy');
        el.removeAttribute('aria-disabled');
      }
    });
  }

  /**
   * Remembers a signed-out action and sends the visitor to sign in.
   * intent: { kind: 'done'|'like'|'join'|'suggestion'|'story', actionId?, inviteCode?, data? }
   */
  async function requireSignIn(intent) {
    intent.returnTo = intent.returnTo || location.pathname + location.search;
    var r = await call('/api/intents', { method: 'POST', body: intent, auth: false, turnstile: true });
    if (r.ok && r.data && r.data.id) {
      store(INTENT_KEY, r.data.id);
      store(LOCAL_KEY, null);
    } else {
      // The server could not save it (for example the bot check failed):
      // keep it in this browser and finish it after sign-in instead.
      store(LOCAL_KEY, JSON.stringify({ kind: intent.kind, actionId: intent.actionId, inviteCode: intent.inviteCode, returnTo: intent.returnTo, key: newKey() }));
    }
    if (window.HF && window.HF.signin) window.HF.signin();
    return r;
  }

  // Finishes a click kept in this browser. Signed in, no bot check is needed.
  async function resumeLocal() {
    var saved;
    try { saved = JSON.parse(read(LOCAL_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return null;
    if (saved.kind === 'join' && saved.inviteCode) {
      var j = await call('/api/invites/' + encodeURIComponent(saved.inviteCode) + '/join', { method: 'POST', key: saved.key });
      if (j.status !== 401) store(LOCAL_KEY, null);
      document.dispatchEvent(new CustomEvent('hfb:resumed', { detail: { kind: 'join', inviteCode: saved.inviteCode, result: j.data } }));
      if (saved.returnTo && saved.returnTo !== location.pathname + location.search) location.href = saved.returnTo;
      return j;
    }
    if (saved.kind === 'return' || !saved.actionId) {
      store(LOCAL_KEY, null);
      if (saved.returnTo && saved.returnTo !== location.pathname + location.search) location.href = saved.returnTo;
      return { ok: true, status: 200, data: { kind: 'return' } };
    }
    var path = '/api/actions/' + encodeURIComponent(saved.actionId);
    var r = saved.kind === 'like'
      ? await call(path + '/like', { method: 'PUT', body: { liked: true }, key: saved.key })
      : saved.kind === 'done' ? await call(path + '/done', { method: 'POST', key: saved.key }) : { ok: true };
    if (r.status !== 401) store(LOCAL_KEY, null);
    if (r.ok) {
      document.dispatchEvent(new CustomEvent('hfb:resumed', { detail: { kind: saved.kind, actionId: saved.actionId, returnTo: saved.returnTo, result: r.data } }));
      if (saved.returnTo && saved.returnTo !== location.pathname + location.search) location.href = saved.returnTo;
    }
    return r;
  }

  /** After sign-in: finishes the remembered action once and returns to it. */
  async function resume() {
    var id = read(INTENT_KEY);
    if (!id && !read(LOCAL_KEY)) return null;
    await waitFor(signInReady, 10000);
    if (!token()) return null;
    if (!id) return resumeLocal();
    var r = await call('/api/intents/' + encodeURIComponent(id) + '/complete', { method: 'POST', key: 'intent-' + id });
    if (r.status !== 401) store(INTENT_KEY, null);
    if (r.ok && r.data) {
      document.dispatchEvent(new CustomEvent('hfb:resumed', { detail: r.data }));
      var back = r.data.returnTo;
      if (back && back !== location.pathname + location.search) location.href = back;
    }
    return r;
  }

  /** Keeps a form's typed text in this browser until it is sent. */
  function keepDraft(form) {
    var key = 'hfb_draft:' + location.pathname + ':' + (form.id || form.getAttribute('name') || 'form');
    try {
      var saved = JSON.parse(read(key) || 'null');
      if (saved) Object.keys(saved).forEach(function (n) {
        var f = form.elements[n];
        if (f && !f.value) f.value = saved[n];
      });
    } catch (e) {}
    form.addEventListener('input', function () {
      var data = {};
      Array.prototype.forEach.call(form.elements, function (f) {
        if (f.name && (f.tagName === 'TEXTAREA' || f.type === 'text')) data[f.name] = f.value;
      });
      store(key, JSON.stringify(data));
    });
    return { clear: function () { store(key, null); } };
  }

  /**
   * The site's shared HF.sync now reads done actions from the backend and no
   * longer writes them to the Shopify customer record.
   */
  async function sync() {
    var c = window.HF && window.HF.load ? await window.HF.load() : null;
    if (!c) return null;
    var r = await call('/api/me');
    var done = r.ok && r.data && r.data.done ? r.data.done : [];
    c.actions = done
      .filter(function (d) { return d.slug; })
      .map(function (d) { return { idea: d.slug, date: d.doneAt, id: d.actionId, title: d.title }; })
      .reverse();
    c.tally = r.ok && r.data ? r.data.tally : c.actions.length;
    // Actions the member saved ("Save" on an action page), newest first.
    c.saved = r.ok && r.data && r.data.saved ? r.data.saved.filter(function (d) { return d.slug; }) : [];
    return c;
  }
  waitFor(function () { return !!window.HF; }, 10000).then(function (ok) {
    if (ok) window.HF.sync = sync;
  });

  window.HFB = { base: BASE, call: call, sync: sync, button: button, say: say, requireSignIn: requireSignIn, resume: resume, keepDraft: keepDraft, newKey: newKey, copy: copy, token: freshToken, turnstileToken: turnstileToken, waitFor: waitFor, guest: function () { return !!guestKey(false); } };

  // Page features (action page, account, stories, invites) live in one
  // script served by the backend, so they ship with the backend and are tested.
  // The interface text first, then the page features, in that order.
  // Each deploy stamps a version here (astro.config.mjs), so a browser never runs an
  // old copy of the page script or text next to a newer page. Unstamped in tests.
  var VERSION = '__HF_VERSION__';
  var V = VERSION.indexOf('__') === 0 ? '' : '?v=' + VERSION;
  var parent = document.head || document.body;
  if (parent && !window.HFW) {
    var words = document.createElement('script');
    words.src = BASE + '/hf-wording.js' + V;
    words.async = false;
    parent.appendChild(words);
  }
  var pages = document.createElement('script');
  pages.src = BASE + '/hf-pages.js' + V;
  pages.async = false;
  if (parent && !(window.HFB_NO_PAGES)) parent.appendChild(pages);

  // A shared link (?r=<code>): whoever shared it is linked to what this visitor
  // does here for 30 days (the ripple). The newest link wins.
  var REF = 'hf_ref';
  try {
    var r0 = new URLSearchParams(location.search).get('r');
    if (r0 && /^[A-Za-z0-9]{8}$/.test(r0)) store(REF, JSON.stringify({ c: r0, t: Date.now() }));
  } catch (e) {}
  function refCode() {
    try {
      var v = JSON.parse(read(REF) || 'null');
      if (v && v.c && Date.now() - v.t < GUEST_DAYS * 86400000) return v.c;
    } catch (e) {}
    return null;
  }
  window.HFB.ref = refCode;

  // Signed in with marks from before on this device: move them now.
  function claimOnLoad() { waitFor(signInReady, 10000).then(function () { var t = token(); if (t && guestKey(false)) claimGuest(t); }); }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', resume); document.addEventListener('DOMContentLoaded', claimOnLoad); }
  else { resume(); claimOnLoad(); }
})();
