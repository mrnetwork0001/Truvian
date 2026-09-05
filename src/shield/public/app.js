/* Truvian Shield frontend — vanilla JS against the Shield API.
   Consumes: POST /api/check -> CheckReport, GET /api/stats.
   All server strings are rendered via textContent (never innerHTML). */
'use strict';

(function () {
  var form = document.getElementById('check-form');
  var submitBtn = document.getElementById('submit-btn');
  var formError = document.getElementById('form-error');
  var report = document.getElementById('report');
  var banner = document.getElementById('verdict-banner');
  var reasonsEl = document.getElementById('reasons');
  var evidenceHeading = document.getElementById('evidence-heading');
  var checksEl = document.getElementById('checks');
  var statsMain = document.getElementById('stats-main');
  var statsDetail = document.getElementById('stats-detail');

  var ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  var TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
  // The node's own signal endpoint resolves a signal hash to its recorded
  // payload — a verification anyone can perform, which is the whole point.
  var SIGNAL_VERIFY_URL = 'https://devnode.telegraphprotocol.com/engine/v1/signal/';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtInt(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
  }

  function fmtCost(usd) {
    if (typeof usd !== 'number' || !isFinite(usd)) return null;
    return '$' + usd.toFixed(4);
  }

  function fmtLatency(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    return Math.round(ms).toLocaleString('en-US') + ' ms';
  }

  /* ---- live stats strip ---- */

  function refreshStats() {
    fetch('/api/stats')
      .then(function (res) {
        if (!res.ok) throw new Error('stats replied ' + res.status);
        return res.json();
      })
      .then(function (stats) {
        statsMain.textContent =
          fmtInt(stats.checksRun) + ' checks · ' +
          fmtInt(stats.telegraphRequests) + ' Telegraph requests routed';
        var parts = [];
        if (stats.byIntent && typeof stats.byIntent === 'object') {
          Object.keys(stats.byIntent).forEach(function (intent) {
            var count = stats.byIntent[intent];
            if (typeof count === 'number' && isFinite(count)) {
              parts.push(intent + ' ' + fmtInt(count));
            }
          });
        }
        statsDetail.textContent = parts.length ? '(' + parts.join(' · ') + ')' : '';
      })
      .catch(function () {
        statsMain.textContent = 'live stats unavailable';
        statsDetail.textContent = '';
      });
  }

  /* ---- form handling ---- */

  function showFormError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function clearFormError() {
    formError.textContent = '';
    formError.hidden = true;
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.textContent = loading ? 'Checking with live miners…' : 'Run safety check';
  }

  function buildRequestBody() {
    var chain = document.getElementById('chain').value;
    var to = document.getElementById('to').value.trim();
    var valueEth = document.getElementById('valueEth').value.trim();
    var txHash = document.getElementById('txHash').value.trim();
    var protocol = document.getElementById('protocol').value.trim();

    if (txHash && !TX_HASH_RE.test(txHash)) {
      showFormError('That transaction hash does not look right — expected 0x followed by 64 hex characters.');
      return null;
    }
    if (to && !ADDRESS_RE.test(to)) {
      showFormError('That recipient address does not look right — expected 0x followed by 40 hex characters.');
      return null;
    }
    if (!txHash && !to) {
      showFormError('Enter a recipient address to pre-check a transaction, or a transaction hash to verify a mined one.');
      return null;
    }

    var body = { chain: chain };
    if (to) body.to = to;
    if (valueEth) body.valueEth = valueEth;
    if (txHash) body.txHash = txHash;
    if (protocol) body.protocol = protocol;
    return body;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearFormError();

    var body = buildRequestBody();
    if (!body) return;

    setLoading(true);
    fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (data) { return { res: res, data: data }; });
      })
      .then(function (result) {
        var data = result.data;
        if (!result.res.ok || !data || typeof data.verdict !== 'string') {
          var detail =
            (data && typeof data.message === 'string' && data.message) ||
            (data && typeof data.error === 'string' && data.error) ||
            ('server replied ' + result.res.status);
          throw new Error(detail);
        }
        renderReport(data);
        refreshStats();
      })
      .catch(function (err) {
        var detail = err && err.message ? err.message : 'network error';
        showFormError('Check failed: ' + detail + '. Make sure the Shield server is reachable, then try again.');
      })
      .then(function () {
        setLoading(false);
      });
  });

  /* ---- report rendering ---- */

  var VERDICT_CLASSES = { SAFE: 'safe', CAUTION: 'caution', BLOCK: 'block' };
  var STATUS_CLASSES = { pass: 'pass', warn: 'warn', fail: 'fail', error: 'error' };

  function renderReport(data) {
    var verdict = String(data.verdict).toUpperCase();
    var verdictClass = VERDICT_CLASSES[verdict] || 'caution';
    var checks = Array.isArray(data.checks) ? data.checks : [];
    var reasons = Array.isArray(data.reasons) ? data.reasons : [];

    // Verdict banner
    banner.className = 'verdict ' + verdictClass;
    banner.textContent = '';
    banner.appendChild(el('span', 'verdict-word', verdict));
    if (typeof data.score === 'number' && isFinite(data.score)) {
      banner.appendChild(el('span', 'verdict-score', 'score ' + Math.round(data.score) + ' / 100'));
    }

    // Reasons
    reasonsEl.textContent = '';
    reasons.forEach(function (reason) {
      reasonsEl.appendChild(el('li', null, String(reason)));
    });

    // Evidence cards
    evidenceHeading.textContent = checks.length
      ? 'Evidence — ' + checks.length + (checks.length === 1 ? ' check' : ' checks') + ' against live Telegraph miners'
      : '';
    checksEl.textContent = '';
    checks.forEach(function (check) {
      checksEl.appendChild(renderCheckCard(check));
    });

    report.hidden = false;
    var reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    report.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function renderCheckCard(check) {
    var card = el('div', 'check-card');

    var head = el('div', 'check-head');
    head.appendChild(el('span', 'check-name', String(check.name || 'check')));
    if (check.intent) head.appendChild(el('span', 'intent-tag', String(check.intent)));
    var status = String(check.status || 'error');
    var statusClass = STATUS_CLASSES[status] || 'error';
    head.appendChild(el('span', 'status-chip ' + statusClass, status));
    card.appendChild(head);

    if (check.summary) card.appendChild(el('p', 'check-summary', String(check.summary)));
    if (check.answer) card.appendChild(el('p', 'check-answer', String(check.answer)));

    var meta = el('div', 'check-meta');
    if (check.minerName) meta.appendChild(el('span', null, 'miner ' + String(check.minerName)));
    var cost = fmtCost(check.costUsd);
    if (cost) meta.appendChild(el('span', null, cost));
    var latency = fmtLatency(check.latencyMs);
    if (latency) meta.appendChild(el('span', null, latency));
    if (check.transport) {
      var transport = String(check.transport);
      var chip = el('span', 'transport-chip ' + (transport === 'x402' ? 'x402' : 'direct'),
        transport === 'x402' ? 'x402 · paid' : 'direct · fallback');
      chip.title = transport === 'x402'
        ? 'Paid through the Telegraph engine via x402 (USDC on Base Sepolia)'
        : 'Direct call to the live miner from the free Telegraph catalog — dev/fallback mode';
      meta.appendChild(chip);
    }
    if (check.signalHash) {
      var hash = String(check.signalHash);
      var link = el('a', 'signal-link', 'verify signal ' + hash.slice(0, 10) + '…');
      link.href = SIGNAL_VERIFY_URL + encodeURIComponent(hash);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Verify on the Telegraph node: ' + hash;
      meta.appendChild(link);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    return card;
  }

  /* ---- boot ---- */

  refreshStats();
  setInterval(refreshStats, 30000);
})();
