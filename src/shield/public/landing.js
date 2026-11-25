/* Truvian Shield landing - live stats strip.
   GET /api/stats (same origin) -> {preflightsRun, telegraphRequests, paidUsd, you}. Strip stays hidden until real numbers arrive. */
(function () {
  'use strict';
  var strip = document.getElementById('stats');
  var main = document.getElementById('stats-main');
  var det = document.getElementById('stats-detail');
  if (!strip || !main || !det || typeof fetch !== 'function') return;
  function n(x) { return typeof x === 'number' && isFinite(x) ? Math.round(x).toLocaleString('en-US') : '0'; }
  function load() {
    try {
      fetch('/api/stats', { headers: { accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('stats ' + r.status); return r.json(); })
        .then(function (s) {
          if (!s || typeof s !== 'object') throw new Error('bad body');
          var head = [n(s.preflightsRun) + ' desk decisions', n(s.telegraphRequests) + ' Telegraph requests'];
          if (typeof s.paidUsd === 'number' && s.paidUsd > 0) head.push('$' + s.paidUsd.toFixed(2) + ' test USDC paid to miners');
          main.textContent = head.join(' · ');
          var parts = [];
          if (s.you && typeof s.you.checksLeftToday === 'number') parts.push(n(s.you.checksLeftToday) + ' free runs left for you today');
          det.textContent = parts.join(' · ');
          strip.hidden = false;
        })
        .catch(function () { /* stay hidden */ });
    } catch (e) { /* stay hidden */ }
  }
  load();
  setInterval(load, 30000);
})();

/* Latest decisions: the signed memos from every desk (GET /api/memos). Hidden
   until there is something real to show. */
(function () {
  'use strict';
  var section = document.getElementById('recent');
  var list = document.getElementById('recent-list');
  if (!section || !list || typeof fetch !== 'function') return;

  var KIND = { 'token-preflight': 'Token preflight', 'listing-review': 'Listing review', 'holdings-proof': 'Holdings proof', 'settlement-assurance': 'Settlement' };
  var CLASS = { HOLD: 'ok', LIST: 'ok', VERIFIED: 'ok', RELEASE: 'ok', REVIEW: 'review', REJECT: 'reject' };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function ago(iso) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return '';
    var s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function row(m) {
    var link = el('a', 'recent-row');
    link.href = '/preflight?m=' + encodeURIComponent(m.id);
    var d = String(m.decision || '');
    link.appendChild(el('span', 'recent-verdict ' + (CLASS[d] || 'review'), d));
    link.appendChild(el('span', '', (KIND[m.kind] || m.kind) + ' · ' + (m.symbol || String(m.token || '').slice(0, 10)) + ' on ' + m.chain));
    if (typeof m.costUsd === 'number') link.appendChild(el('span', '', '$' + m.costUsd.toFixed(2)));
    link.appendChild(el('span', 'recent-when', ago(m.createdAt)));
    return link;
  }
  function load() {
    fetch('/api/memos?limit=6', { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('memos ' + r.status); return r.json(); })
      .then(function (data) {
        var memos = (data && data.memos) || [];
        if (!memos.length) return;
        list.textContent = '';
        memos.forEach(function (m) { list.appendChild(row(m)); });
        section.hidden = false;
      })
      .catch(function () { /* leave the section hidden */ });
  }
  load();
  setInterval(load, 60000);
})();

/* Scroll reveal: each section's blocks (and each card inside a grid) fade and
   rise into place the first time they enter the viewport, staggered. Once a
   block has arrived its helper classes are removed so nothing lingers. */
(function () {
  'use strict';
  if (!('IntersectionObserver' in window) || !document.body.classList) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var GRIDS = '.hero-grid, .desks, .proofs, .steps, .tracks, .agents-grid, .limits';
  var items = [];
  Array.prototype.forEach.call(document.querySelectorAll('main section > .wrap'), function (wrap) {
    var i = 0;
    Array.prototype.forEach.call(wrap.children, function (el) {
      var kids = el.matches && el.matches(GRIDS) ? el.children : [el];
      Array.prototype.forEach.call(kids, function (k) {
        if (k.hidden) return;
        k.classList.add('rv');
        k.style.setProperty('--rv-d', Math.min(i, 8) * 90 + 'ms');
        i += 1;
        items.push(k);
      });
    });
  });
  if (!items.length) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      io.unobserve(el);
      el.classList.add('in');
      el.addEventListener('transitionend', function done(ev) {
        if (ev.propertyName !== 'opacity') return;
        el.removeEventListener('transitionend', done);
        el.classList.remove('rv', 'in');
        el.style.removeProperty('--rv-d');
      });
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
  items.forEach(function (el) { io.observe(el); });
})();
