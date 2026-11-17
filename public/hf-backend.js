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
  var LOCAL_KEY = 'hfb_local_intent';

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
    await waitFor(function () { return !!window.HF; }, 10000);
    // Back from Shopify sign-in: exchange the code for a token first.
    if (/[?&]code=/.test(location.search) && window.HF && window.HF.finish) {
      try { await window.HF.finish(); } catch (e) {}
    }
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

  // "Notify me when this drop goes live". On a drop (home page, /drops/<slug>)
  // the form sits under the countdown. On /shop and on the lead product's page
  // it sits above the products, using the drop shown on the home page.
  function readHomeDrop() {
    return fetch('/', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) {
        if (!html || typeof DOMParser === 'undefined') return null;
        var d = new DOMParser().parseFromString(html, 'text/html');
        var g = function (id) { var e = d.getElementById(id); return e ? e.textContent.trim() : ''; };
        return { status: g('hf-drop-status'), lead: g('hf-drop-lead'), date: g('hf-drop-date') };
      })
      .catch(function () { return null; });
  }

  async function dropPlacement() {
    var status = document.getElementById('hf-drop-status');
    var count = document.getElementById('hf-drop-count');
    if (status && count) {
      if (status.textContent.trim().toLowerCase() !== 'upcoming') return null;
      var m = location.pathname.match(/^\/drops\/([a-z0-9-]+)/);
      return { anchor: count, where: 'afterend', drop: m ? m[1] : null, label: copy('notify-drop') };
    }
    var p = location.pathname.match(/^\/products\/([^\/]+)/);
    var anchor = location.pathname === '/shop' ? document.getElementById('hf-shop') : p ? document.getElementById('hf-product') : null;
    if (!anchor) return null;
    var home = await readHomeDrop();
    if (!home || home.status.toLowerCase() !== 'upcoming') return null;
    if (p && p[1] !== home.lead) return null;
    return {
      anchor: anchor,
      where: 'beforebegin',
      drop: null,
      label: copy(p ? 'notify-product' : 'notify-next', { date: home.date }),
    };
  }

  async function dropNotify() {
    if (document.getElementById('hfb-notify')) return false;
    var place = await dropPlacement();
    if (!place || document.getElementById('hfb-notify')) return false;
    var drop = place.drop;
    var signedIn = !!token();
    var form = document.createElement('form');
    form.id = 'hfb-notify';
    form.noValidate = true;
    form.style.margin = '12px 0';
    var label = document.createElement('label');
    label.htmlFor = 'hfb-notify-email';
    label.textContent = signedIn ? place.label.replace(copy('notify-email-phrase'), copy('notify-email-phrase-member')) : place.label;
    label.style.display = 'block';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px';
    var input = document.createElement('input');
    input.id = 'hfb-notify-email';
    input.type = 'email';
    input.autocomplete = 'email';
    input.required = true;
    input.placeholder = copy('notify-placeholder');
    input.className = 'w-input';
    input.style.cssText = 'max-width:260px;margin:0';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'hf-button-light';
    btn.textContent = copy('notify-button');
    var msg = document.createElement('p');
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    msg.style.margin = '6px 0 0';
    if (!signedIn) row.appendChild(input);
    row.appendChild(btn);
    form.appendChild(label);
    form.appendChild(row);
    form.appendChild(msg);
    place.anchor.insertAdjacentElement(place.where, form);
    var busy = false;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy) return;
      if (!signedIn && !input.value.trim()) { msg.textContent = copy('notify-missing-email'); input.focus(); return; }
      busy = true;
      btn.setAttribute('aria-busy', 'true');
      var r = await call('/api/drops/notify', { method: 'POST', body: { drop: drop, email: signedIn ? undefined : input.value }, auth: signedIn, turnstile: !signedIn });
      busy = false;
      btn.removeAttribute('aria-busy');
      if (r.ok) {
        msg.textContent = copy(r.data && r.data.alreadySignedUp ? 'notify-already' : 'notify-done');
        input.disabled = true;
        btn.disabled = true;
      } else {
        msg.textContent = (r.data && r.data.message) || copy('error-generic');
      }
    });
    return true;
  }
  waitFor(function () { return !!window.HF && !!window.HFW; }, 10000).then(function () { return dropNotify(); }).catch(function () {});

  window.HFB = { base: BASE, call: call, sync: sync, button: button, say: say, requireSignIn: requireSignIn, resume: resume, keepDraft: keepDraft, newKey: newKey, dropNotify: dropNotify, copy: copy, token: freshToken, turnstileToken: turnstileToken, waitFor: waitFor };

  // Page features (action page, account, stories, invites, drops) live in one
  // script served by the backend, so they ship with the backend and are tested.
  // The interface text first, then the page features, in that order.
  var parent = document.head || document.body;
  if (parent && !window.HFW) {
    var words = document.createElement('script');
    words.src = BASE + '/hf-wording.js';
    words.async = false;
    parent.appendChild(words);
  }
  var pages = document.createElement('script');
  pages.src = BASE + '/hf-pages.js';
  pages.async = false;
  if (parent && !(window.HFB_NO_PAGES)) parent.appendChild(pages);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume);
  else resume();
})();
