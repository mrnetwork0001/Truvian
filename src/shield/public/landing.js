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
