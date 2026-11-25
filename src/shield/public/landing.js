/* Truvian landing: the live ledger and the stats strip.
   Both start as static, verified content in the HTML; these only replace it
   with live numbers when the API answers. Nothing breaks with JS off. */
(function () {
  'use strict';
  if (typeof fetch !== 'function') return;

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

  /* ---- stats strip: GET /api/stats ---- */
  function money(x) { return '$' + x.toFixed(2); }
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

  /* ---- the ledger tape: GET /api/memos ---- */
  var DESK = { 'token-preflight': 'Preflight', 'listing-review': 'Listing', 'holdings-proof': 'Holdings', 'settlement-assurance': 'Settlement' };
  var STAMP = { HOLD: 'ok', LIST: 'ok', VERIFIED: 'ok', RELEASE: 'ok', REVIEW: 'review', REJECT: 'reject' };
  function short(s) { s = String(s || ''); return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s; }
  function utc(iso) { var s = String(iso || ''); return s.length >= 16 ? s.slice(5, 10) + ' ' + s.slice(11, 16) : s; }
  function cap(s) { s = String(s || ''); return s.charAt(0) + s.slice(1).toLowerCase(); }

  function row(m, i) {
    var tr = el('tr', 'in');
    tr.style.animationDelay = (i * 70) + 'ms';
    tr.appendChild(el('td', null, utc(m.createdAt)));
    tr.appendChild(el('td', null, DESK[m.kind] || m.kind));
    tr.appendChild(el('td', null, m.symbol || (m.kind === 'holdings-proof' ? 'wallet ' : '') + short(m.token)));
    tr.appendChild(el('td', null, m.chain));
    tr.appendChild(el('td', 'num', typeof m.costUsd === 'number' ? money(m.costUsd) : '-'));
    var td = el('td'); var a = el('a', null, m.id); a.href = '/preflight?m=' + encodeURIComponent(m.id); td.appendChild(a); tr.appendChild(td);
    var v = el('td', 'v'); v.appendChild(el('span', 'stamp ' + (STAMP[m.decision] || 'review'), cap(m.decision))); tr.appendChild(v);
    return tr;
  }
  var lastTop = null;
  function tape() {
    json('/api/memos?limit=6').then(function (d) {
      var memos = (d && d.memos) || [];
      if (!memos.length) return;
      $('ledger-state').textContent = 'live · /api/memos';
      if (memos[0].id === lastTop) return;
      lastTop = memos[0].id;
      var body = $('tape-body');
      body.textContent = '';
      memos.forEach(function (m, i) { body.appendChild(row(m, i)); });
    }).catch(function () { /* keep the static rows */ });
  }

  stats();
  tape();
  setInterval(stats, 30000);
  setInterval(tape, 45000);
})();
