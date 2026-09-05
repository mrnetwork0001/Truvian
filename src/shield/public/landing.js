/* Truvian Shield landing — live stats strip only.
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
          main.textContent = n(s.checksRun) + ' checks run · ' + n(s.telegraphRequests) + ' Telegraph requests';
          var parts = [];
          if (s.byIntent && typeof s.byIntent === 'object') {
            Object.keys(s.byIntent).forEach(function (k) {
              var v = s.byIntent[k];
              if (typeof v === 'number' && isFinite(v)) parts.push(k + ' ' + n(v));
            });
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
