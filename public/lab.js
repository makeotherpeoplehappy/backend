/*
 * /lab: live KPIs for Happiness Foundation. Loaded by the Webflow page /lab.
 * Shows nothing until an allow-listed account is signed in; the numbers come
 * from GET /join/api/lab/kpis and refresh every minute.
 */
(function () {
  'use strict';
  var CSS = [
    ':root{--lab-bg:#f6f8f7;--lab-card:#fff;--lab-fg:#17201c;--lab-muted:#5b6a62;--lab-line:#dbe3df;--lab-accent:#0f7a5c;--lab-soft:#e3f2ec;--lab-warn:#a15c00}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--lab-bg:#101513;--lab-card:#171e1a;--lab-fg:#e3ebe7;--lab-muted:#9aada3;--lab-line:#2a3631;--lab-accent:#4fd1a5;--lab-soft:#1a3a2f;--lab-warn:#f0b45c}}',
    'body{background:var(--lab-bg);color:var(--lab-fg)}',
    '#hf-lab{max-width:1100px;margin:0 auto;padding:32px max(16px,env(safe-area-inset-left,0px)) 64px;font-family:Inter,system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums}',
    '#hf-lab h1{font-size:30px;margin:0 0 4px}#hf-lab h2{font-size:18px;margin:32px 0 12px}',
    '#hf-lab .sub{color:var(--lab-muted);margin:0 0 20px;font-size:14px}',
    '#hf-lab .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}',
    '#hf-lab .tile{background:var(--lab-card);border:1px solid var(--lab-line);border-radius:10px;padding:14px 16px}',
    '#hf-lab .tile.hero{background:var(--lab-soft);border-color:transparent}',
    '#hf-lab .tile .v{font-size:28px;font-weight:700;line-height:1.1}#hf-lab .tile .l{font-size:13px;color:var(--lab-muted);margin-top:4px}',
    '#hf-lab .tile .s{font-size:12px;color:var(--lab-muted);margin-top:6px}',
    '#hf-lab .panel{background:var(--lab-card);border:1px solid var(--lab-line);border-radius:10px;padding:16px;overflow-x:auto}',
    '#hf-lab table{border-collapse:collapse;width:100%;font-size:14px}#hf-lab td,#hf-lab th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--lab-line)}',
    '#hf-lab th{font-weight:600;color:var(--lab-muted);font-size:12px;}#hf-lab td.n{text-align:right}',
    '#hf-lab .two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}@media (max-width:760px){#hf-lab .two{grid-template-columns:minmax(0,1fr)}}',
    '#hf-lab .warn{color:var(--lab-warn);font-weight:600}#hf-lab button{font:inherit;padding:10px 18px;border-radius:999px;border:0;background:var(--lab-fg);color:var(--lab-bg);cursor:pointer}',
    '#hf-lab svg text{fill:var(--lab-muted);font-size:11px}',
    '#hf-lab .review{margin:0 0 12px}#hf-lab .review .row{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}',
    '#hf-lab button.light{background:transparent;color:var(--lab-fg);border:1px solid var(--lab-line)}#hf-lab button[disabled]{opacity:.5;cursor:default}',
    '#hf-lab .review-text{white-space:pre-wrap;font-size:16px;margin:8px 0}#hf-lab .review-photo{display:block;max-width:min(100%,420px);border-radius:8px;margin:8px 0}'
  ].join('\n');

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function fmt(n) { return (n || 0).toLocaleString(); }
  function tile(value, label, sub, hero) {
    return el('div', { class: 'tile' + (hero ? ' hero' : '') }, [el('div', { class: 'v', text: fmt(value) }), el('div', { class: 'l', text: label }), sub ? el('div', { class: 's', text: sub }) : null]);
  }
  function table(head, rows) {
    var t = el('table');
    t.appendChild(el('tr', {}, head.map(function (h, i) { return el('th', { text: h, class: i ? 'n' : '' }); })));
    rows.forEach(function (r) { t.appendChild(el('tr', {}, r.map(function (c, i) { return el('td', { text: typeof c === 'number' ? fmt(c) : c, class: i ? 'n' : '' }); }))); });
    if (!rows.length) t.appendChild(el('tr', {}, [el('td', { text: 'Nothing yet' })]));
    return el('div', { class: 'panel' }, [t]);
  }
  function chart(daily) {
    var days = [];
    var today = new Date();
    var byDay = {};
    daily.forEach(function (d) { byDay[d.day] = d.done; });
    for (var i = 29; i >= 0; i--) { var d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10); days.push({ day: d, v: byDay[d] || 0 }); }
    var max = Math.max(1, Math.max.apply(null, days.map(function (x) { return x.v; })));
    var W = 600, H = 160, pad = 24, bw = (W - pad * 2) / days.length;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + 22) + '" width="100%" role="img" aria-label="Actions done per day, last 30 days">';
    days.forEach(function (x, i) {
      var h = Math.round((x.v / max) * H);
      svg += '<rect x="' + (pad + i * bw + 1) + '" y="' + (H - h) + '" width="' + Math.max(1, bw - 2) + '" height="' + h + '" rx="2" fill="var(--lab-accent)"><title>' + x.day + ': ' + x.v + '</title></rect>';
    });
    svg += '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + H + '" y2="' + H + '" stroke="var(--lab-line)"/>';
    svg += '<text x="' + pad + '" y="' + (H + 16) + '">' + days[0].day.slice(5) + '</text><text x="' + (W - pad) + '" y="' + (H + 16) + '" text-anchor="end">today</text>';
    svg += '<text x="' + pad + '" y="12">' + max + ' max</text></svg>';
    var p = el('div', { class: 'panel' });
    p.innerHTML = svg;
    return p;
  }

  function render(root, k) {
    root.innerHTML = '';
    var i = k.impact, e = k.engagement, h = k.health;
    root.appendChild(el('h1', { text: 'Happiness Foundation Lab' }));
    root.appendChild(el('p', { class: 'sub', text: 'Live numbers from the backend · updated ' + new Date(k.generatedAt).toLocaleString() + ' · refreshes every minute' }));
    root.appendChild(reviewPanel());
    root.appendChild(el('h2', { text: 'Impact' }));
    root.appendChild(el('div', { class: 'grid' }, [
      tile(i.peopleMadeHappy, 'People made happy', fmt(i.peopleMadeHappy30d) + ' in 30 days · ' + fmt(i.peopleMadeHappy7d) + ' in 7', true),
      tile(i.actionsEverDone, 'Different actions done'),
      tile(i.pledgesMade, 'Pledges made'),
      tile(i.pledgesKept, 'Pledges kept')
    ]));
    root.appendChild(el('h2', { text: 'Engagement' }));
    root.appendChild(el('div', { class: 'grid' }, [
      tile(e.members, 'Members', fmt(e.newMembers30d) + ' new in 30 days'),
      tile(e.activeMembers7d, 'Active this week', fmt(e.activeMembers30d) + ' in 30 days'),
      tile(e.likes, 'Likes'),
      tile(e.suggestions, 'Suggestions', fmt(e.suggestionsWaiting) + ' waiting for review'),
      tile(e.stories, 'Stories', fmt(e.storiesWaiting) + ' waiting for review'),
      tile(e.dropSignups, 'Drop sign-ups')
    ]));
    root.appendChild(el('h2', { text: 'Actions done per day' }));
    root.appendChild(chart(k.daily || []));
    var two = el('div', { class: 'two' }, [
      el('div', {}, [el('h2', { text: 'Top actions, 30 days' }), table(['Action', 'People', 'Times'], (k.topActions || []).map(function (a) { return [a.title, a.people, a.times]; }))]),
      el('div', {}, [el('h2', { text: 'Most liked' }), table(['Action', 'Likes'], (k.mostLiked || []).map(function (a) { return [a.title, a.likes]; }))])
    ]);
    root.appendChild(two);
    root.appendChild(el('div', { class: 'two' }, [
      el('div', {}, [el('h2', { text: 'Drop sign-ups' }), table(['Drop', 'Sign-ups'], (k.drops || []).map(function (d) { return [d.drop, d.signups]; }))]),
      el('div', {}, [el('h2', { text: 'System health' }), table(['Check', 'Value'], [
        ['Writes waiting to retry', h.queuePending],
        ['Writes that failed', h.queueFailed],
        ['Actions mirrored', h.actionsMirrored],
        ['Products synced', h.productsSynced]
      ].concat((h.jobs || []).map(function (j) { return ['Last ' + j.job, new Date(j.last_run_at).toLocaleString()]; })))])
    ]));
    root.appendChild(accessPanel(k.me));
    if (h.queueFailed) root.insertBefore(el('p', { class: 'warn', text: h.queueFailed + ' write(s) failed permanently. See the error emails.' }), root.children[2]);
  }

  // "To review": anyone with access approves or rejects new suggestions and
  // stories here. The decision is saved to the Webflow CMS too.
  var reviewing = false;
  function reviewPanel() {
    var wrap = el('div', { id: 'lab-review' }, [el('h2', { text: 'To review' })]);
    var body = el('div', {}, [el('p', { class: 'sub', text: 'Loading…' })]);
    wrap.appendChild(body);
    function when(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return ''; } }
    function card(type, item, kids) {
      var status = el('p', { class: 'sub', role: 'status' });
      var yes = el('button', { type: 'button', class: 'btn', text: type === 'story' ? 'Approve and publish' : 'Approve' });
      var no = el('button', { type: 'button', class: 'btn light', text: 'Reject' });
      var box = el('div', { class: 'panel review' }, kids.concat([el('div', { class: 'row' }, [yes, no]), status]));
      function decide(decision) {
        return async function () {
          if (decision === 'rejected' && !window.confirm(type === 'story' ? 'Reject this story? It will not be shown, and no email is sent.' : 'Reject this suggestion? No email is sent.')) return;
          reviewing = true; yes.disabled = no.disabled = true; status.textContent = 'Saving…';
          var r = await window.HFB.call('/api/lab/review', { method: 'POST', body: { type: type, id: item.id, decision: decision } });
          reviewing = false;
          if (r.ok) { box.innerHTML = ''; box.appendChild(el('p', { class: 'sub', text: decision === 'approved' ? (type === 'story' ? 'Approved. It is on the site and the member gets an email.' : 'Approved. A draft action has been made in the CMS for you to finish and publish.') : 'Rejected.' })); }
          else { status.textContent = (r.data && r.data.message) || 'That did not work. Try again.'; yes.disabled = no.disabled = false; }
        };
      }
      yes.onclick = decide('approved');
      no.onclick = decide('rejected');
      return box;
    }
    window.HFB.call('/api/lab/review').then(function (r) {
      body.innerHTML = '';
      if (!r.ok) { body.appendChild(el('p', { class: 'sub', text: (r.data && r.data.message) || 'Could not load.' })); return; }
      var d = r.data;
      if (!d.suggestions.length && !d.stories.length) { body.appendChild(el('p', { class: 'sub', text: 'Nothing waiting. New suggestions and stories show up here.' })); return; }
      d.stories.forEach(function (s) {
        var kids = [el('p', { class: 'sub', text: 'Story · ' + (s.name || 'A member') + (s.showName ? '' : ' (posting without a name)') + ' · ' + when(s.createdAt) + (s.version > 1 ? ' · edited' : '') })];
        if (s.actionTitle) kids.push(el('p', { text: 'About: ' + s.actionTitle }));
        if (s.photoKey) kids.push(el('img', { src: window.HFB.base + '/media/' + s.photoKey, alt: s.photoDescription || 'Story photo', class: 'review-photo' }));
        if (s.text) kids.push(el('p', { class: 'review-text', text: s.text }));
        if (s.videoUrl) { var a = el('a', { href: s.videoUrl, text: 'Watch the video', target: '_blank', rel: 'noopener' }); kids.push(el('p', {}, [a])); }
        body.appendChild(card('story', s, kids));
      });
      d.suggestions.forEach(function (s) {
        var kids = [el('p', { class: 'sub', text: 'Suggestion · ' + (s.name || 'A member') + ' · ' + when(s.createdAt) }), el('p', { class: 'review-text', text: s.text })];
        if (s.similar) kids.push(el('p', { class: 'sub', text: s.similar }));
        body.appendChild(card('suggestion', s, kids));
      });
    });
    return wrap;
  }

  // "Who can see this": anyone with access can add or remove invited people.
  function accessPanel(me) {
    var wrap = el('div', {}, [el('h2', { text: 'Who can see this' })]);
    var panel = el('div', { class: 'panel' });
    var list = el('div');
    var form = el('form', { novalidate: '' });
    var label = el('label', { for: 'lab-invite-email', text: 'Add someone by email. They get an email with the link and sign in with that address.' });
    label.style.display = 'block';
    var row = el('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0';
    var input = el('input', { id: 'lab-invite-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
    input.style.cssText = 'font:inherit;padding:9px 12px;border:1px solid var(--lab-line);border-radius:8px;background:var(--lab-card);color:var(--lab-fg);min-width:0;flex:1 1 220px';
    var add = el('button', { type: 'submit', text: 'Add' });
    var msg = el('p', { role: 'status', 'aria-live': 'polite' });
    msg.style.cssText = 'margin:8px 0 0;font-size:14px';
    row.appendChild(input); row.appendChild(add);
    form.appendChild(label); form.appendChild(row); form.appendChild(msg);
    panel.appendChild(list); panel.appendChild(form);
    wrap.appendChild(panel);

    function draw(data) {
      list.innerHTML = '';
      var t = el('table');
      t.appendChild(el('tr', {}, [el('th', { text: 'Email' }), el('th', { text: 'Access', class: 'n' }), el('th', { text: '', class: 'n' })]));
      (data.owners || []).forEach(function (o) {
        t.appendChild(el('tr', {}, [el('td', { text: o + (me && me.email === o ? ' (you)' : '') }), el('td', { class: 'n', text: 'Owner' }), el('td', { class: 'n' })]));
      });
      (data.invited || []).forEach(function (p) {
        var b = el('button', { type: 'button', text: 'Remove', 'aria-label': 'Remove ' + p.email });
        b.style.cssText = 'padding:4px 12px;font-size:13px;background:transparent;color:var(--lab-fg);border:1px solid var(--lab-line)';
        b.onclick = async function () {
          b.disabled = true;
          var r = await window.HFB.call('/api/lab/access', { method: 'DELETE', body: { email: p.email } });
          if (r.ok) { draw(r.data); msg.textContent = p.email + ' was removed.'; } else { b.disabled = false; msg.textContent = (r.data && r.data.message) || 'That did not work.'; }
        };
        t.appendChild(el('tr', {}, [el('td', { text: p.email + (me && me.email === p.email ? ' (you)' : '') }), el('td', { class: 'n', text: 'Invited by ' + p.addedBy }), el('td', { class: 'n' }, [b])]));
      });
      list.appendChild(t);
    }
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) { msg.textContent = 'Please enter an email address.'; input.focus(); return; }
      add.disabled = true;
      var r = await window.HFB.call('/api/lab/access', { method: 'POST', body: { email: v } });
      add.disabled = false;
      if (r.ok) { draw(r.data); input.value = ''; msg.textContent = r.data.added ? v + ' can now see the dashboard. An invitation email is on its way.' : v + ' already has access.'; }
      else msg.textContent = (r.data && r.data.message) || 'That did not work.';
    });
    window.HFB.call('/api/lab/access').then(function (r) { if (r.ok) draw(r.data); });
    return wrap;
  }

  function message(root, text, withButton) {
    root.innerHTML = '';
    root.appendChild(el('h1', { text: 'Happiness Foundation Lab' }));
    root.appendChild(el('p', { class: 'sub', text: text }));
    if (withButton) {
      var b = el('button', { type: 'button', text: 'Sign in' });
      b.onclick = function () {
        try { localStorage.setItem('hfb_local_intent', JSON.stringify({ kind: 'return', returnTo: '/lab' })); } catch (e) {}
        window.HF.signin();
      };
      root.appendChild(b);
    }
  }

  function wait(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function c() { if (test()) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(c, 50); })();
    });
  }

  async function start() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    var root = document.getElementById('hf-lab');
    if (!root) { root = el('main', { id: 'hf-lab' }); document.body.insertBefore(root, document.body.firstChild); }
    message(root, 'Loading…');
    await wait(function () { return window.HFB && window.HF; }, 15000);
    if (!window.HFB) return message(root, 'The site helper did not load. Reload the page.');
    if (window.HFB.resume) { try { await window.HFB.resume(); } catch (e) {} }
    if (!(window.HF.token && window.HF.token())) return message(root, 'Sign in with an account on the dashboard allow-list to see the numbers.', true);
    async function load() {
      // Do not redraw while someone is typing an invitation.
      var active = document.activeElement;
      if (active && active.id === 'lab-invite-email') return;
      if (reviewing) return;
      var r = await window.HFB.call('/api/lab/kpis');
      if (r.ok) render(root, r.data);
      else if (r.status === 401) message(root, 'Your sign-in has expired. Sign in again to see the numbers.', true);
      else message(root, (r.data && r.data.message) || 'The numbers could not be loaded. Try again in a moment.');
    }
    await load();
    setInterval(function () { if (document.visibilityState === 'visible') load(); }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
