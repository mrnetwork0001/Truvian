/* Truvian Shield landing — behaviors.
   1. Live stats strip: GET /api/stats (same origin), rendered via textContent.
      The strip stays hidden until a response arrives and fails silently if the
      API is unreachable (no error text, no console noise).
   2. Signal-hash resolver: builds the Telegraph node's public signal URL from a
      pasted hash and opens it in a new tab. No proxying, no rewriting.
   Everything is guarded so a missing element or an old browser is a no-op. */
'use strict';

(function () {
  /* ---- live stats strip ---- */
  var strip = document.getElementById('stats-strip');
  var statsMain = document.getElementById('stats-main');
  var statsDetail = document.getElementById('stats-detail');

  function fmtInt(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
  }

  function refreshStats() {
    if (!strip || !statsMain || !statsDetail || typeof fetch !== 'function') return;
    try {
      fetch('/api/stats', { headers: { accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('stats replied ' + res.status);
          return res.json();
        })
        .then(function (stats) {
          if (!stats || typeof stats !== 'object') throw new Error('bad stats body');
          statsMain.textContent =
            fmtInt(stats.checksRun) + ' checks run · ' +
            fmtInt(stats.telegraphRequests) + ' Telegraph requests routed';
          var parts = [];
          if (stats.byIntent && typeof stats.byIntent === 'object') {
            Object.keys(stats.byIntent).forEach(function (intent) {
              var count = stats.byIntent[intent];
              if (typeof count === 'number' && isFinite(count)) parts.push(intent + ' ' + fmtInt(count));
            });
          }
          statsDetail.textContent = parts.length ? '(' + parts.join(' · ') + ')' : '';
          strip.hidden = false;
        })
        .catch(function () {
          /* silent: leave the strip hidden (or showing the last good numbers) */
        });
    } catch (e) {
      /* silent */
    }
  }

  /* ---- signal resolver ---- */
  var SIGNAL_URL = 'https://devnode.telegraphprotocol.com/engine/v1/signal/';
  var form = document.getElementById('verify-form');
  var input = document.getElementById('signal-hash');
  var out = document.getElementById('verify-out');

  function renderResolver(hash) {
    if (!out) return;
    out.textContent = '';
    var code = document.createElement('code');
    if (!hash) {
      code.textContent = SIGNAL_URL + '<hash>';
      out.appendChild(code);
      return;
    }
    var link = document.createElement('a');
    link.href = SIGNAL_URL + encodeURIComponent(hash);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = SIGNAL_URL + hash;
    code.appendChild(link);
    out.appendChild(code);
  }

  if (form && input) {
    input.addEventListener('input', function () {
      renderResolver(input.value.trim());
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var hash = input.value.trim();
      if (!hash) {
        input.focus();
        return;
      }
      renderResolver(hash);
      try {
        window.open(SIGNAL_URL + encodeURIComponent(hash), '_blank', 'noopener');
      } catch (e) {
        /* popup blocked or unsupported: the rendered link above still works */
      }
    });
  }

  refreshStats();
  setInterval(refreshStats, 30000);
})();
