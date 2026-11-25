/* Truvian landing: the live ledger, the cycling memo and the stats strip.
   Everything starts as static, verified content in the HTML; this file only
   replaces it with live data when the API answers, and only animates when
   the visitor allows motion. Nothing breaks with JS off. */
(function () {
  'use strict';
  if (typeof fetch !== 'function' || !document.querySelector) return;

  var MOTION = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function json(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  function money(x) { return '$' + Number(x).toFixed(2); }
  function short(s) { s = String(s || ''); return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s; }
  function cap(s) { s = String(s || ''); return s.charAt(0) + s.slice(1).toLowerCase(); }

  var DESK = { 'token-preflight': 'Preflight', 'listing-review': 'Listing', 'holdings-proof': 'Holdings', 'settlement-assurance': 'Settlement' };
  var DESK_LONG = { 'token-preflight': 'Token preflight', 'listing-review': 'Listing review', 'holdings-proof': 'Holdings proof', 'settlement-assurance': 'Settlement assurance' };
  var STAMP = { HOLD: 'ok', LIST: 'ok', VERIFIED: 'ok', RELEASE: 'ok', REVIEW: 'review', REJECT: 'reject' };

  /* ---------------- stats strip: GET /api/stats ---------------- */
  function stats() {
    json('/api/stats').then(function (s) {
      if (!s || typeof s !== 'object') return;
      if (typeof s.preflightsRun === 'number') $('st-decisions').textContent = s.preflightsRun.toLocaleString('en-US');
      if (typeof s.telegraphRequests === 'number') $('st-requests').textContent = s.telegraphRequests.toLocaleString('en-US');
      if (typeof s.paidUsd === 'number') {
        var dd = $('st-paid');
        dd.textContent = money(s.paidUsd) + ' ';
        dd.appendChild(el('small', null, 'test USDC'));
      }
      var left = s.you && typeof s.you.checksLeftToday === 'number' ? s.you.checksLeftToday : null;
      if (left !== null) {
        var note = $('stats-note');
        note.textContent = 'Live from ';
        var a = el('a', null, '/api/stats'); a.href = '/api/stats'; note.appendChild(a);
        note.appendChild(document.createTextNode(' · ' + left + ' free runs left for you today · nearly all decisions so far are our own test runs.'));
      }
    }).catch(function () { /* keep the static figures */ });
  }

  /* ---------------- the ledger tape: GET /api/memos ----------------
     The rows are real memos. With motion allowed the list is rendered twice
     and scrolled upward forever (CSS transform, translateY 0 -> -50%), so the
     loop is seamless; hover or keyboard focus pauses it. A memo that was not
     on the tape before slides in at the top and gets its stamp pressed. */
  var ledger = $('ledger');
  var track = $('tape-track');
  var known = {};
  var memoList = [];

  function rowFor(m, fresh, dupe) {
    var li = el('li', 'tape-row' + (fresh ? ' fresh' : ''));
    li.setAttribute('role', 'row');
    if (dupe) li.setAttribute('aria-hidden', 'true');
    var s = String(m.createdAt || '');
    var cells = [
      ['c-t', s.length >= 16 ? s.slice(5, 10) + ' ' + s.slice(11, 16) : s],
      ['c-d', DESK[m.kind] || m.kind],
      ['c-s', m.subject || m.symbol || (m.kind === 'holdings-proof' ? 'wallet ' : '') + short(m.token)],
      ['c-c', m.chain],
      ['c-p num', typeof m.costUsd === 'number' ? money(m.costUsd) : '-'],
    ];
    cells.forEach(function (c) { var sp = el('span', c[0], c[1]); sp.setAttribute('role', 'cell'); li.appendChild(sp); });
    var mc = el('span', 'c-m'); mc.setAttribute('role', 'cell');
    var a = el('a', null, m.id); a.href = '/preflight?m=' + encodeURIComponent(m.id);
    if (dupe) a.tabIndex = -1;
    mc.appendChild(a); li.appendChild(mc);
    var v = el('span', 'c-v'); v.setAttribute('role', 'cell');
    v.appendChild(el('span', 'stamp ' + (STAMP[m.decision] || 'review'), cap(m.decision)));
    li.appendChild(v);
    return li;
  }

  function renderTape(memos, firstLoad) {
    track.textContent = '';
    memos.forEach(function (m) { track.appendChild(rowFor(m, !firstLoad && !known[m.id], false)); });
    if (MOTION && memos.length >= 4) {
      memos.forEach(function (m) { track.appendChild(rowFor(m, false, true)); });
      ledger.style.setProperty('--rows', String(Math.min(5, memos.length - 1)));
      ledger.style.setProperty('--tape-dur', (memos.length * 3.6) + 's');
      ledger.classList.add('looping');
    }
    memos.forEach(function (m) { known[m.id] = true; });
  }

  function tape(firstLoad) {
    json('/api/memos?limit=8').then(function (d) {
      var memos = (d && d.memos) || [];
      if (!memos.length) return;
      $('ledger-state').textContent = 'live · /api/memos';
      var changed = memos.map(function (m) { return m.id; }).join() !== memoList.map(function (m) { return m.id; }).join();
      memoList = memos;
      if (changed) renderTape(memos, firstLoad);
      if (firstLoad) startMemoCycle();
    }).catch(function () {
      // the API is unreachable: loop the static, verified rows instead
      if (firstLoad && MOTION && track.children.length >= 4) {
        Array.prototype.slice.call(track.children).forEach(function (li) {
          var c = li.cloneNode(true); c.setAttribute('aria-hidden', 'true');
          Array.prototype.forEach.call(c.querySelectorAll('a'), function (a) { a.tabIndex = -1; });
          track.appendChild(c);
        });
        ledger.style.setProperty('--tape-dur', (track.children.length / 2 * 3.6) + 's');
        ledger.classList.add('looping');
      }
    });
  }

  /* ---------------- the featured memo cycles through real memos ----------------
     Every 7 s the paper memo fades to the next recent decision (fetched from
     /api/memo/<id>, the signed record itself) and its verdict is stamped again.
     Pauses on hover/focus and while the tab is hidden. */
  var memoEl = $('memo');
  var body = $('memo-body');
  var stampEl = $('memo-stamp');
  var cache = {};
  var idx = 0;
  var timer = null;
  var paused = false;

  function severityWord(s) { return s === 'block' ? 'blocks' : s === 'review' ? 'review' : s === 'pass' ? 'pass' : 'noted'; }
  function minerFor(memo, f) {
    var p = (memo.purchases || []).filter(function (x) { return (f.evidence || []).indexOf(x.key) >= 0; })[0];
    if (!p) return f.source === 'chain' ? 'read on chain' : f.source;
    var name = String(p.minerName || '').split(/[—–\-·(]/)[0].trim();
    return [p.minerId, name, p.reused ? 'reused' : money(p.costUsd || 0)].filter(Boolean).join(' · ');
  }
  function subjectRow(memo) {
    var i = memo.input || {};
    if (memo.kind === 'settlement-assurance') return ['Counterparty', i.issuer || '-'];
    if (memo.kind === 'listing-review') return ['Issuer', (i.issuer || '-') + (memo.chainReads && memo.chainReads.symbol ? ' · ' + memo.chainReads.symbol : '')];
    if (memo.kind === 'holdings-proof') return ['Custody wallet', short(i.wallet || i.token)];
    return ['Token', (memo.chainReads && memo.chainReads.symbol) || short(i.token)];
  }

  function renderMemo(rec) {
    var m = rec.memo;
    body.textContent = '';
    var top = el('header', 'memo-top');
    top.appendChild(el('span', 'doc-k', 'Truvian Shield · decision memo'));
    var no = el('span', 'doc-k', 'No. '); no.appendChild(el('b', null, rec.id)); top.appendChild(no);
    body.appendChild(top);
    var h = el('h2', 'memo-title', DESK_LONG[m.kind] || m.kind);
    var when = String(m.createdAt || '');
    h.appendChild(el('span', null, (m.input && m.input.chain) + ' · ' + when.slice(0, 10) + ', ' + when.slice(11, 16) + ' UTC'));
    body.appendChild(h);
    var dl = el('dl', 'memo-fields');
    function add(k, src, v, hit) {
      var d = el('div'); var dt = el('dt', null, k);
      if (src) dt.appendChild(el('span', 'src', src));
      d.appendChild(dt); d.appendChild(el('dd', hit ? 'hit' : null, v)); dl.appendChild(d);
    }
    var subj = subjectRow(m); add(subj[0], null, subj[1]);
    var order = { block: 0, review: 1, pass: 2, info: 3 };
    (m.findings || []).slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; }).slice(0, 4).forEach(function (f) {
      var t = String(f.title || ''); if (t.length > 42) t = t.slice(0, 40) + '…';
      add(t, minerFor(m, f), severityWord(f.severity), f.severity === 'block' || f.severity === 'review');
    });
    add('Rule', null, String(m.decisionRule || '').replace(/^every check answered and none/, 'nothing'));
    body.appendChild(dl);
    var foot = el('footer', 'memo-sign');
    var line = el('div', 'sig-line'); line.appendChild(el('span', 'doc-k', 'Signed EIP-191')); line.appendChild(el('span', 'mono', short(rec.signer || '')));
    foot.appendChild(line);
    var cost = m.cost && typeof m.cost.telegraphUsd === 'number' ? money(m.cost.telegraphUsd) + ' test USDC' : '';
    foot.appendChild(el('div', 'sig-meta mono', ['sha256 ' + String(rec.sha256 || '').slice(0, 8) + '…' + String(rec.sha256 || '').slice(-6), cost, (m.purchases || []).length + ' answers'].filter(Boolean).join(' · ')));
    body.appendChild(foot);
    memoEl.setAttribute('aria-label', 'Signed memo ' + rec.id + ': ' + (DESK_LONG[m.kind] || m.kind) + ', ' + m.decision);
    stampEl.className = 'stamp xl memo-stamp ' + (STAMP[m.decision] || 'review');
    stampEl.textContent = cap(m.decision);
    var link = $('memo-link'); link.href = '/preflight?m=' + encodeURIComponent(rec.id);
  }

  function dots() {
    var c = $('memo-cycle');
    c.hidden = false; c.textContent = '';
    memoList.forEach(function (m, i) { c.appendChild(el('i', i === idx ? 'on' : null)); });
  }

  function show(i) {
    var m = memoList[i];
    if (!m) return;
    var got = cache[m.id] ? Promise.resolve(cache[m.id]) : json('/api/memo/' + encodeURIComponent(m.id)).then(function (r) { cache[m.id] = r; return r; });
    got.then(function (rec) {
      if (!rec || !rec.memo) return;
      memoEl.classList.add('swapping');
      setTimeout(function () {
        renderMemo(rec);
        idx = i; dots();
        memoEl.classList.remove('swapping');
        stampEl.classList.remove('repress');
        void stampEl.offsetWidth; // restart the press
        stampEl.classList.add('repress');
      }, 450);
    }).catch(function () { idx = i; /* unreadable: keep the memo on show, move on next tick */ });
  }

  function tick() {
    if (paused || document.hidden || !memoList.length) return;
    show((idx + 1) % memoList.length);
  }

  function startMemoCycle() {
    if (!MOTION || !memoEl || memoList.length < 2) return;
    // start on the memo already printed in the HTML, if it is in the feed
    var at = memoList.map(function (m) { return m.id; }).indexOf('Py5ehwTL');
    idx = at >= 0 ? at : -1;
    if (idx < 0) { idx = 0; show(0); } else dots();
    memoEl.addEventListener('mouseenter', function () { paused = true; });
    memoEl.addEventListener('mouseleave', function () { paused = false; });
    var fig = memoEl.parentNode;
    fig.addEventListener('focusin', function () { paused = true; });
    fig.addEventListener('focusout', function () { paused = false; });
    if (!timer) timer = setInterval(tick, 7000);
  }

  stats();
  tape(true);
  setInterval(stats, 30000);
  setInterval(function () { tape(false); }, 45000);
})();
