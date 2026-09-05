/* Truvian Shield landing - live stats strip only.
   GET /api/stats (same origin) -> {checksRun, telegraphRequests, byIntent}. Strip stays hidden until real numbers arrive. */
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
          var head = [n(s.checksRun) + ' checks run', n(s.telegraphRequests) + ' Telegraph requests'];
          if (typeof s.paidUsd === 'number' && s.paidUsd > 0) head.push('$' + s.paidUsd.toFixed(2) + ' paid to miners');
          main.textContent = head.join(' · ');
          var parts = [];
          if (s.byIntent && typeof s.byIntent === 'object') {
            Object.keys(s.byIntent).forEach(function (k) {
              var v = s.byIntent[k];
              if (typeof v === 'number' && isFinite(v)) parts.push(k + ' ' + n(v));
            });
          }
          if (s.budget && typeof s.budget.checksFunded === 'number') {
            parts.push('funded for ' + n(s.budget.checksFunded) + ' more checks');
          }
          det.textContent = parts.join(' · ');
          strip.hidden = false;
        })
        .catch(function () { /* stay hidden */ });
    } catch (e) { /* stay hidden */ }
  }
  load();
  setInterval(load, 30000);
})();

/* Recent checks: the public feed of reports anyone can open. Hidden until
   there is something real to show, so the page never advertises an empty list. */
(function () {
  'use strict';
  var section = document.getElementById('recent');
  var list = document.getElementById('recent-list');
  if (!section || !list || typeof fetch !== 'function') return;

  var VERDICT_CLASS = { SAFE: 'safe', CAUTION: 'caution', BLOCK: 'block' };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function ago(iso) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return '';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
  }

  function row(entry) {
    var link = el('a', 'recent-row');
    link.href = '/app?r=' + encodeURIComponent(entry.id);
    var verdict = String(entry.verdict || '').toUpperCase();
    link.appendChild(el('span', 'recent-verdict ' + (VERDICT_CLASS[verdict] || 'caution'), verdict));
    link.appendChild(el('span', 'recent-score', 'score ' + entry.score));
    link.appendChild(el('span', 'recent-meta', entry.chain + ' · ' + entry.checks + (entry.checks === 1 ? ' check' : ' checks')));
    if (entry.signals && entry.signals.length) {
      link.appendChild(el('span', 'recent-signals', entry.signals.length + ' signal ' + (entry.signals.length === 1 ? 'hash' : 'hashes')));
    }
    link.appendChild(el('span', 'recent-when', ago(entry.at)));
    return link;
  }

  function load() {
    fetch('/api/recent?limit=8', { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('recent ' + r.status); return r.json(); })
      .then(function (data) {
        var checks = (data && data.checks) || [];
        if (!checks.length) return;
        list.textContent = '';
        checks.forEach(function (entry) { list.appendChild(row(entry)); });
        section.hidden = false;
        // The reveal pass ran while this section was still hidden, so its
        // blocks are sitting at opacity 0 and were never observed. Show them.
        Array.prototype.forEach.call(section.querySelectorAll('.rv'), function (node) {
          node.classList.remove('rv', 'in');
          node.style.removeProperty('--rv-d');
        });
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
  var GRIDS = '.hero-grid, .bignums, .checks, .score-grid, .agents-grid, .verify-grid, .faq';
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
