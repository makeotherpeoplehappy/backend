/*
 * /lab: live KPIs for Happiness Foundation. Loaded by the Webflow page /lab.
 * Shows nothing until an allow-listed account is signed in; the numbers come
 * from GET /join/api/lab/kpis and refresh every minute.
 */
(function () {
  'use strict';
  // Same look as the rest of the site: its Webflow Variables (colours, fonts, card corners),
  // soft blue cards, a deep-blue headline card, pill buttons. Sized for phones first.
  var CSS = [
    '#hf-lab{font-variant-numeric:tabular-nums;color:var(--colour--ink,#111418)}',
    '#hf-lab h1{margin:0 0 8px}',
    '#hf-lab h2{font-family:var(--font--display),Arial,sans-serif;font-size:clamp(24px,3vw,32px);font-weight:800;line-height:1.15;letter-spacing:-.01em;margin:48px 0 14px;text-wrap:balance}',
    '#hf-lab .sub{color:var(--colour--grey,#3D434C);margin:0 0 20px;font-size:16px;line-height:1.5}',
    '#hf-lab .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}',
    '@media (max-width:479px){#hf-lab .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}#hf-lab .tile{padding:16px}#hf-lab .tile .v{font-size:32px}}',
    '#hf-lab .tile,#hf-lab .panel{background:var(--colour--sky,#EEF4FA);border:0;border-radius:var(--size--radius-card,24px);padding:20px}',
    '#hf-lab .tile.hero{background:var(--colour--deep-blue,#2E5E8E);color:#fff}#hf-lab .tile.hero .l,#hf-lab .tile.hero .s{color:var(--colour--text-on-dark,#D7DEE7)}',
    '#hf-lab .tile .v{font-family:var(--font--display),Arial,sans-serif;font-size:40px;font-weight:800;line-height:1.05;letter-spacing:-.02em}',
    '#hf-lab .tile .l{font-size:16px;font-weight:600;margin-top:8px}#hf-lab .tile .s{font-size:14px;color:var(--colour--grey,#3D434C);margin-top:6px}',
    '#hf-lab .panel{overflow-x:auto}',
    '#hf-lab table{border-collapse:collapse;width:100%;font-size:16px}#hf-lab td,#hf-lab th{text-align:left;padding:12px 8px;border-bottom:1px solid var(--colour--pale-blue,#CFE0F2)}',
    '#hf-lab tr:last-child td{border-bottom:0}#hf-lab th{font-weight:600;color:var(--colour--grey,#3D434C);font-size:14px}#hf-lab td.n{text-align:right}',
    '#hf-lab .two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}@media (max-width:767px){#hf-lab .two{grid-template-columns:minmax(0,1fr)}}',
    '#hf-lab .two h2{margin-top:40px}',
    '#hf-lab .warn{font-weight:600;background:var(--colour--pale-blue,#CFE0F2);border:0;border-radius:var(--size--radius-field,14px);padding:14px 18px}',
    '#hf-lab button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;font:inherit;font-weight:700;font-size:17px;line-height:1.2;padding:0 22px;border-radius:999px;border:2px solid var(--colour--deep-blue,#2E5E8E);background:var(--colour--deep-blue,#2E5E8E);color:#fff;cursor:pointer}',
    '#hf-lab button:hover{background:var(--colour--deep-blue-hover,#1F4468);border-color:var(--colour--deep-blue-hover,#1F4468)}#hf-lab button.light{background:#fff;color:var(--colour--deep-blue,#2E5E8E);border-color:var(--colour--pale-blue,#CFE0F2)}#hf-lab button.light:hover{background:var(--colour--deep-blue,#2E5E8E);border-color:var(--colour--deep-blue,#2E5E8E);color:#fff}',
    '#hf-lab button[disabled]{opacity:.45;cursor:default}',
    '#hf-lab input{font:inherit;font-size:17px;min-height:48px;padding:0 16px;border:2px solid var(--colour--field-border,#C9D6E5);border-radius:var(--size--radius-field,14px);background:#fff;color:var(--colour--ink,#111418)}#hf-lab input:focus{border-color:var(--colour--deep-blue,#2E5E8E);outline:none}',
    '#hf-lab svg{width:100%;height:auto;display:block}#hf-lab svg text{fill:var(--colour--grey,#3D434C);font-size:11px}#hf-lab svg rect{fill:var(--colour--brand-blue,#6699CC)}',
    '#hf-lab .review{margin:0 0 16px}#hf-lab .review .row{display:flex;flex-wrap:wrap;gap:12px;margin-top:14px}',
    '#hf-lab .review-text{white-space:pre-wrap;font-size:18px;line-height:1.5;margin:8px 0}#hf-lab .review-photo{display:block;max-width:min(100%,420px);border-radius:16px;margin:8px 0}'
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
      svg += '<rect x="' + (pad + i * bw + 1) + '" y="' + (H - h) + '" width="' + Math.max(1, bw - 2) + '" height="' + h + '" rx="2"><title>' + x.day + ': ' + x.v + '</title></rect>';
    });
    svg += '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + H + '" y2="' + H + '" stroke="#CFE0F2"/>';
    svg += '<text x="' + pad + '" y="' + (H + 16) + '">' + days[0].day.slice(5) + '</text><text x="' + (W - pad) + '" y="' + (H + 16) + '" text-anchor="end">today</text>';
    svg += '<text x="' + pad + '" y="12">' + max + ' max</text></svg>';
    var p = el('div', { class: 'panel' });
    p.innerHTML = svg;
    return p;
  }

  function render(root, k) {
    root.innerHTML = '';
    var i = k.impact, e = k.engagement, h = k.health;
    root.appendChild(el('h1', { text: 'Happiness Lab' }));
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
      tile(i.activeMembers, 'Active members', 'Made someone happy in 4 of the last 5 weeks', true),
      tile(e.activeMembers7d, 'Did an action this week', fmt(e.activeMembers30d) + ' in 30 days'),
      tile(e.likes, 'Likes'),
      tile(e.suggestions, 'Suggestions', fmt(e.suggestionsWaiting) + ' waiting for review'),
      tile(e.stories, 'Stories', fmt(e.storiesWaiting) + ' waiting for review')
    ]));
    root.appendChild(el('h2', { text: 'Actions done per day' }));
    root.appendChild(chart(k.daily || []));
    var two = el('div', { class: 'two' }, [
      el('div', {}, [el('h2', { text: 'Top actions, 30 days' }), table(['Action', 'People', 'Times'], (k.topActions || []).map(function (a) { return [a.title, a.people, a.times]; }))]),
      el('div', {}, [el('h2', { text: 'Most liked' }), table(['Action', 'Likes'], (k.mostLiked || []).map(function (a) { return [a.title, a.likes]; }))])
    ]);
    root.appendChild(two);
    root.appendChild(partnersPanel(k.me));
    root.appendChild(accessPanel(k.me));
    // Technical checks: one quiet line when all is well; the details open on a tap, and show
    // straight away when something needs attention.
    var trouble = h.queueFailed > 0 || h.queuePending > 0;
    var details = el('details', trouble ? { open: '' } : {}, [
      el('summary', { class: 'sub', style: 'cursor:pointer;margin:48px 0 12px', text: trouble ? 'System: needs attention' : 'System: all running normally' }),
      table(['Check', 'Value'], [
        ['Writes waiting to retry', h.queuePending],
        ['Writes that failed', h.queueFailed],
        ['Actions mirrored', h.actionsMirrored]
      ].concat((h.jobs || []).map(function (j) { return ['Last ' + j.job, new Date(j.last_run_at).toLocaleString()]; })))
    ]);
    if ((h.failedWrites || []).length) {
      details.appendChild(el('h2', { text: 'Writes that failed' }));
      details.appendChild(table(['When', 'Where', 'What', 'Tries', 'Error'], h.failedWrites.map(function (f) {
        return [new Date(f.at).toLocaleString(), f.target, f.what, f.attempts, f.error];
      })));
    }
    root.appendChild(details);
    (h.dareWarnings || []).forEach(function (w) { root.insertBefore(el('p', { class: 'warn', text: w }), root.children[2]); });
    if (h.queueFailed) root.insertBefore(el('p', { class: 'warn', text: h.queueFailed + ' write(s) failed permanently. Details under System, below.' }), root.children[2]);
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
          var ask = type !== 'story' ? 'Reject this suggestion? No email is sent.' : item.videoKey ? 'Reject this video story? It will not be shown, and the member gets a friendly email saying so.' : 'Reject this story? It will not be shown, and no email is sent.';
          if (decision === 'rejected' && !window.confirm(ask)) return;
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
        if (s.videoKey) {
          if (s.hasChildren) kids.push(el('p', { class: 'warn', text: 'The member says there are children in this video. Check it with extra care.' }));
          var v = el('video', { src: window.HFB.base + '/media/' + s.videoKey, controls: '', playsinline: '', preload: 'metadata', class: 'review-photo' });
          if (s.posterKey) v.setAttribute('poster', window.HFB.base + '/media/' + s.posterKey);
          kids.push(v);
          if (s.videoCodec && /^(hvc1|hev1)$/.test(s.videoCodec)) kids.push(el('p', { class: 'sub', text: 'Recorded as HEVC (iPhone high efficiency): plays on iPhones, Macs and most newer Android phones; some older browsers show the still instead.' }));
        }
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

  // Partner shops: their pledges, and (owners) adding a partner (brand name in, key and code out) or switching one off.
  function partnersPanel(me) {
    var owner = !!(me && me.owner);
    var wrap = el('div', {}, [el('h2', { text: 'Partners' })]);
    var panel = el('div', { class: 'panel' });
    var list = el('div');
    var msg = el('p', { role: 'status', 'aria-live': 'polite' });
    msg.style.cssText = 'margin:8px 0 0;font-size:14px';
    var kit = el('div');
    panel.appendChild(el('p', { text: 'Shops connected through the Pledge API. Every purchase comes with a Make Someone Happy pledge; the buyer keeps it through the link the shop shows. Partners send no customer data and see their results as numbers (a monthly report). Partner 1 is our own shop.' }));
    panel.appendChild(list);
    if (owner) {
      var form = el('form', { novalidate: '' });
      var input = el('input', { type: 'text', placeholder: 'Brand name', autocomplete: 'off' });
      input.style.cssText = 'min-width:0;flex:1 1 200px';
      var email = el('input', { type: 'email', placeholder: 'Report email (optional)', autocomplete: 'off' });
      email.style.cssText = 'min-width:0;flex:1 1 220px';
      var add = el('button', { type: 'submit', text: 'Set up partner' });
      var row = el('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0';
      row.appendChild(input); row.appendChild(email); row.appendChild(add);
      form.appendChild(row);
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!input.value.trim()) { msg.textContent = 'Please give the brand name.'; return; }
        add.disabled = true;
        var r = await window.HFB.call('/api/lab/partners', { method: 'POST', body: { name: input.value, reportEmail: email.value } });
        add.disabled = false;
        if (!r.ok) { msg.textContent = (r.data && r.data.message) || 'That did not work.'; return; }
        draw(r.data);
        showKit(input.value.trim(), r.data.slug, r.data.key);
        input.value = ''; email.value = '';
        msg.textContent = '';
      });
      panel.appendChild(form);
    }
    panel.appendChild(msg);
    panel.appendChild(kit);
    wrap.appendChild(panel);

    // What to send the partner: their ID, their key (shown once) and code to paste.
    function showKit(name, slug, key, renewed) {
      var api = window.HFB.base + '/api/partners';
      var code =
        '// ' + name + ': Make Someone Happy pledge (Happiness Foundation Pledge API)\n' +
        '// Partner ID: ' + slug + '\n' +
        '// Keep this key secret, on your server only.\n' +
        'const HF_KEY = "' + key + '";\n\n' +
        '// 1. When an order is paid: ask for its pledge. Send no customer data.\n' +
        '//    Idempotency-Key: any value unique to this purchase (e.g. a random UUID you save with it), so a retry gets the same pledge.\n' +
        'const res = await fetch("' + api + '/pledges", {\n' +
        '  method: "POST",\n' +
        '  headers: { Authorization: "Bearer " + HF_KEY, "Content-Type": "application/json", "Idempotency-Key": purchaseUuid },\n' +
        '  body: "{}",\n' +
        '});\n' +
        'const { pledge, claimUrl } = await res.json();\n' +
        '// Show claimUrl to the buyer on the thank-you page and in the order email ("Keep your pledge").\n' +
        '// Save pledge with the order, only if you want to cancel it later.\n\n' +
        '// 2. If the order is cancelled or refunded in full:\n' +
        'await fetch("' + api + '/pledges/cancel", {\n' +
        '  method: "POST",\n' +
        '  headers: { Authorization: "Bearer " + HF_KEY, "Content-Type": "application/json" },\n' +
        '  body: JSON.stringify({ pledge }),\n' +
        '});\n\n' +
        '// 3. Your numbers, any time (month as YYYY-MM): pledges given, kept, turned into an action.\n' +
        'await fetch("' + api + '/report?month=2026-11", { headers: { Authorization: "Bearer " + HF_KEY } });\n';
      kit.innerHTML = '';
      var box = el('div', { class: 'warn' });
      box.style.cssText = 'margin:14px 0 0;padding:18px';
      box.appendChild(el('p', { text: renewed
        ? 'New code for ' + name + ' (Partner ID: ' + slug + '). Their old key has stopped working, so send them this code now: the key in it is shown only once.'
        : name + ' is set up. Partner ID: ' + slug + '. Send them the code below now: the key in it is shown only once.' }));
      var pre = el('pre');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.5;background:#fff;padding:14px;border-radius:14px;max-height:420px;overflow:auto';
      pre.textContent = code;
      var copy = el('button', { type: 'button', text: 'Copy code' });
      copy.onclick = function () {
        (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(function () { copy.textContent = 'Copied'; }, function () { copy.textContent = 'Select the code and copy it'; });
      };
      box.appendChild(pre);
      box.appendChild(copy);
      kit.appendChild(box);
    }

    function draw(data) {
      list.innerHTML = '';
      var t = el('table');
      t.appendChild(el('tr', {}, [el('th', { text: 'Partner' }), el('th', { text: 'Pledges', class: 'n' }), el('th', { text: 'Claimed', class: 'n' }), el('th', { text: 'Kept', class: 'n' }), el('th', { text: 'Report to' }), el('th', { text: '', class: 'n' })]));
      (data.partners || []).forEach(function (p) {
        var cell = el('td', { class: 'n' });
        var rep = el('td', { text: p.id === 1 ? '' : (p.reportEmail || 'nobody yet') });
        if (owner && p.id !== 1) {
          var b = el('button', { type: 'button', text: p.active ? 'Switch off' : 'Switch on' });
          b.className = 'light'; b.style.cssText = 'padding:4px 14px;font-size:15px';
          b.onclick = async function () {
            b.disabled = true;
            var r = await window.HFB.call('/api/lab/partners', { method: 'PATCH', body: { id: p.id, active: !p.active } });
            if (r.ok) draw(r.data); else { b.disabled = false; msg.textContent = (r.data && r.data.message) || 'That did not work.'; }
          };
          cell.appendChild(b);
          var e = el('button', { type: 'button', text: 'Change' });
          e.className = 'light'; e.style.cssText = 'margin-left:6px;padding:2px 10px;font-size:14px';
          e.onclick = async function () {
            var v = window.prompt('Monthly report email for ' + p.name + ' (empty for none):', p.reportEmail || '');
            if (v === null) return;
            var r = await window.HFB.call('/api/lab/partners', { method: 'PATCH', body: { id: p.id, reportEmail: v } });
            if (r.ok) draw(r.data); else msg.textContent = (r.data && r.data.message) || 'That did not work.';
          };
          rep.appendChild(e);
          // Keys are stored scrambled, so a lost code cannot be shown again: this makes a new one.
          var k = el('button', { type: 'button', text: 'New code' });
          k.className = 'light'; k.style.cssText = 'margin-left:6px;padding:4px 14px;font-size:15px';
          k.onclick = async function () {
            if (!window.confirm('Make new code for ' + p.name + '? Their current key stops working straight away, so their shop must switch to the new code.')) return;
            k.disabled = true;
            var r = await window.HFB.call('/api/lab/partners', { method: 'PATCH', body: { id: p.id, newKey: true } });
            k.disabled = false;
            if (!r.ok) { msg.textContent = (r.data && r.data.message) || 'That did not work.'; return; }
            draw(r.data);
            showKit(p.name, r.data.slug, r.data.key, true);
            kit.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
          cell.insertBefore(k, cell.firstChild);
        } else if (!p.active) cell.textContent = 'Off';
        t.appendChild(el('tr', {}, [el('td', { text: p.name + ' (' + p.slug + ')' }), el('td', { class: 'n', text: String(p.pledges) }), el('td', { class: 'n', text: String(p.claimed) }), el('td', { class: 'n', text: String(p.kept) }), rep, cell]));
      });
      list.appendChild(t);
    }
    window.HFB.call('/api/lab/partners').then(function (r) { if (r.ok) draw(r.data); });
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
    input.style.cssText = 'min-width:0;flex:1 1 220px';
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
        b.className = 'light'; b.style.cssText = 'padding:4px 14px;font-size:15px';
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
    root.appendChild(el('h1', { text: 'Happiness Lab' }));
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
