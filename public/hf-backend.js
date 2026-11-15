/*
 * Happiness Foundation backend helper for the Webflow site.
 * Load after the HF sign-in helper:
 *   <script src="/join/hf-backend.js" data-turnstile-sitekey="..." defer></script>
 *
 * window.HFB gives the site:
 *   HFB.call(path, opts)        one backend call, with sign-in token and one-time key
 *   HFB.button(el, run)         one click makes one record (double clicks ignored, retries reuse the key)
 *   HFB.requireSignIn(intent)   remember a signed-out click, then go to sign-in
 *   HFB.resume()                after sign-in, finish the remembered click once
 *   HFB.keepDraft(form)         keep typed text if sign-in expires mid-form
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var BASE = (script && script.src ? new URL(script.src).pathname : '/join/hf-backend.js').replace(/\/hf-backend\.js$/, '');
  var SITEKEY = script && script.getAttribute('data-turnstile-sitekey');
  var INTENT_KEY = 'hfb_intent';

  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function newKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function token() {
    var t = window.HF && window.HF.token && window.HF.token();
    return t && t.a ? t.a : null;
  }

  // Refreshes an expiring Shopify token through HF.api, which renews it.
  async function freshToken() {
    var t = window.HF && window.HF.token && window.HF.token();
    if (t && t.exp && t.exp <= Date.now() + 60000 && window.HF.api) {
      try { await window.HF.api('{customer{id}}'); } catch (e) {}
    }
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
      box.style.display = 'none';
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
    if (t) headers.Authorization = 'Bearer ' + t;
    if (method !== 'GET') headers['Idempotency-Key'] = opts.key || newKey();
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
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
      // 409: the first click is still being saved; 503: a service is briefly down.
      if (res.status === 409 || res.status === 503) { await sleep(800 * (attempt + 1)); continue; }
      var data = null;
      try { data = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, data: data };
    }
    return { ok: false, status: 0, data: { error: 'network', message: 'We could not reach the server. Please check your connection and try again.' } };
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
    if (r.ok && r.data && r.data.id) store(INTENT_KEY, r.data.id);
    if (window.HF && window.HF.signin) window.HF.signin();
    return r;
  }

  /** After sign-in: finishes the remembered action once and returns to it. */
  async function resume() {
    var id = read(INTENT_KEY);
    if (!id) return null;
    await waitFor(function () { return !!window.HF; }, 10000);
    // Back from Shopify sign-in: exchange the code for a token first.
    if (/[?&]code=/.test(location.search) && window.HF && window.HF.finish) {
      try { await window.HF.finish(); } catch (e) {}
    }
    if (!token()) return null;
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
    return c;
  }
  waitFor(function () { return !!window.HF; }, 10000).then(function (ok) {
    if (ok) window.HF.sync = sync;
  });

  window.HFB = { base: BASE, call: call, sync: sync, button: button, say: say, requireSignIn: requireSignIn, resume: resume, keepDraft: keepDraft, newKey: newKey };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume);
  else resume();
})();
