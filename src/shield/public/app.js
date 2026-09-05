/* Truvian Shield frontend - vanilla JS against the Shield API.
   Consumes: POST /api/check -> CheckReport, GET /api/stats.
   Handles the x402 402 -> pay -> retry flow via wallet.js (TruvianWallet).
   All server strings are rendered via textContent (never innerHTML). */
'use strict';

(function (global) {
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
  var payNotice = document.getElementById('pay-notice');
  var receiptBar = document.getElementById('receipt-bar');
  var walletBtn = document.getElementById('wallet-btn');
  var walletState = document.getElementById('wallet-state');

  var lastReceiptId = null;
  var ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  var TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
  // The node's own signal endpoint resolves a signal hash to its recorded
  // payload - a verification anyone can perform, which is the whole point.
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
        var head = [
          fmtInt(stats.checksRun) + ' checks',
          fmtInt(stats.telegraphRequests) + ' Telegraph requests routed',
        ];
        if (typeof stats.paidUsd === 'number' && stats.paidUsd > 0) {
          head.push('$' + stats.paidUsd.toFixed(2) + ' paid to miners');
        }
        statsMain.textContent = head.join(' · ');

        var parts = [];
        if (stats.byIntent && typeof stats.byIntent === 'object') {
          Object.keys(stats.byIntent).forEach(function (intent) {
            var count = stats.byIntent[intent];
            if (typeof count === 'number' && isFinite(count)) {
              parts.push(intent + ' ' + fmtInt(count));
            }
          });
        }
        var tail = parts.length ? '(' + parts.join(' · ') + ')' : '';
        // Budget: how many checks the payer wallet can still fund, and how
        // many free checks this visitor has left today.
        var budget = stats.budget;
        if (budget && typeof budget.checksFunded === 'number') {
          tail += (tail ? ' · ' : '') + 'funded for ' + fmtInt(budget.checksFunded) + ' more checks';
        }
        var you = stats.you;
        if (you && typeof you.checksLeftToday === 'number' && typeof you.perDay === 'number' && you.perDay > 0) {
          tail += (tail ? ' · ' : '') + you.checksLeftToday + ' of ' + you.perDay + ' free checks left today';
        }
        statsDetail.textContent = tail;
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
      showFormError('That transaction hash does not look right - expected 0x followed by 64 hex characters.');
      return null;
    }
    if (to && !ADDRESS_RE.test(to)) {
      showFormError('That recipient address does not look right - expected 0x followed by 40 hex characters.');
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

  /* ---- one-click examples ----
     Real mined Base transactions, so a first-time visitor sees a verdict
     without owning a transaction hash. SAFE: a succeeded 4.78 ETH transfer.
     BLOCK: a reverted transaction plus a value above the $100k fail line, so
     two checks fail and the verdict engine blocks. */

  var PRESETS = {
    safe: {
      chain: 'base',
      to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
      valueEth: '0.05',
      txHash: '0x772e04669ec9ad56635d998be5638c5eae6f2897cb28192bdb8e1bdedad3c769',
      protocol: '',
    },
    block: {
      chain: 'base',
      to: '0x83d55acdc72027ed339d267eebaf9a41e47490d5',
      valueEth: '60',
      txHash: '0xef26d7918abb2ba7cbe6a121507a3f2a4f54bb9c31f3e568643501e2394c9863',
      protocol: '',
    },
  };

  function applyPreset(name) {
    var preset = PRESETS[name];
    if (!preset) return;
    document.getElementById('chain').value = preset.chain;
    document.getElementById('to').value = preset.to;
    document.getElementById('valueEth').value = preset.valueEth;
    document.getElementById('txHash').value = preset.txHash;
    document.getElementById('protocol').value = preset.protocol;
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (btn) {
    btn.addEventListener('click', function () {
      applyPreset(btn.getAttribute('data-preset'));
      clearFormError();
      // Run it straight away: one click from landing on the page to a verdict.
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  });

  /* ---- x402: pay for a check when the free allowance is used ---- */

  function postCheck(body, paymentHeader) {
    var headers = { 'content-type': 'application/json' };
    if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;
    return fetch('/api/check', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (data) { return { res: res, data: data }; });
    });
  }

  /* ---- streaming: watch each paid miner answer land ----
     The server can emit NDJSON (one JSON object per line) so the report
     assembles itself instead of appearing after a ten-second spinner. Any
     failure here falls back to the plain request. */

  function streamSupported() {
    return typeof ReadableStream === 'function' && typeof TextDecoder === 'function';
  }

  function postCheckStreaming(body, paymentHeader, onEvent) {
    var headers = { 'content-type': 'application/json', accept: 'application/x-ndjson' };
    if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;
    return fetch('/api/check?stream=1', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (res) {
      // A 402 or an error is plain JSON, not a stream: hand it back unchanged.
      var type = res.headers.get('content-type') || '';
      if (!res.ok || type.indexOf('x-ndjson') === -1 || !res.body) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (data) { return { res: res, data: data }; });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var last = { res: res, data: null };

      function handleLine(line) {
        if (!line) return;
        var event;
        try {
          event = JSON.parse(line);
        } catch (e) {
          return;
        }
        if (event.type === 'report' && event.report) last.data = event.report;
        onEvent(event);
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            handleLine(buffer.trim());
            return last;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach(function (line) { handleLine(line.trim()); });
          return pump();
        });
      }
      return pump();
    });
  }

  function priceOf(requirements) {
    var atomic = Number(requirements.maxAmountRequired);
    return isFinite(atomic) ? '$' + (atomic / 1e6).toFixed(2) : 'the quoted price';
  }

  /**
   * Run a check, paying if Shield asks. A 402 carries the price and the
   * payment requirements; the wallet signs a gasless USDC authorization and
   * the request is retried once with it.
   */
  function runCheck(body, onEvent) {
    var send = function (payment) {
      return streamSupported() ? postCheckStreaming(body, payment, onEvent) : postCheck(body, payment);
    };
    return send(null).then(function (result) {
      if (result.res.status !== 402) return result;

      var challenge = result.data || {};
      var requirements = challenge.accepts && challenge.accepts[0];
      if (!requirements) throw new Error(challenge.error || 'payment required, but no price was quoted');

      if (!global.TruvianWallet || !global.TruvianWallet.isAvailable()) {
        throw new Error(
          'Free checks for today are used. Paying ' + priceOf(requirements) +
          ' in USDC needs a browser wallet (MetaMask, Coinbase Wallet or Rabby).',
        );
      }
      setPayNotice('Free checks used. Approve ' + priceOf(requirements) + ' in your wallet to run this check.');
      return global.TruvianWallet.signPayment(requirements).then(function (header) {
        setPayNotice('Payment signed. Querying live miners…');
        return send(header);
      });
    });
  }

  function setPayNotice(text) {
    if (!payNotice) return;
    payNotice.textContent = text || '';
    payNotice.hidden = !text;
  }

  /* ---- progressive report: rows appear, then fill in, then get graded ---- */

  var liveRows = {};

  function liveRow(name, intent) {
    var card = el('div', 'check-card live');
    var head = el('div', 'check-head');
    head.appendChild(el('span', 'check-name', name));
    head.appendChild(el('span', 'intent-tag', intent));
    var chip = el('span', 'status-chip pending', 'querying');
    head.appendChild(chip);
    card.appendChild(head);
    var summary = el('p', 'check-summary', 'asking a live Telegraph miner…');
    card.appendChild(summary);
    return { card: card, chip: chip, summary: summary };
  }

  function handleStreamEvent(event) {
    if (!event || typeof event.type !== 'string') return;

    if (event.type === 'start') {
      liveRows = {};
      report.hidden = false;
      banner.className = 'verdict';
      banner.textContent = '';
      banner.appendChild(el('span', 'verdict-score', 'running ' + event.checks.length + ' paid miner queries…'));
      reasonsEl.textContent = '';
      evidenceHeading.textContent = 'Evidence';
      checksEl.textContent = '';
      (event.checks || []).forEach(function (planned) {
        var row = liveRow(planned.name, planned.intent);
        liveRows[planned.name] = row;
        checksEl.appendChild(row.card);
      });
      return;
    }

    if (event.type === 'signal') {
      var row = liveRows[event.name];
      if (!row) return;
      row.chip.className = 'status-chip ' + (event.ok ? 'answered' : 'error');
      row.chip.textContent = event.ok ? 'answered' : 'no answer';
      var bits = [];
      if (event.minerName) bits.push(event.minerName + (event.minerId ? ' · ' + event.minerId : ''));
      var latency = fmtLatency(event.latencyMs);
      if (latency) bits.push(latency);
      if (typeof event.costUsd === 'number') bits.push('$' + event.costUsd.toFixed(2));
      if (event.transport) bits.push(event.transport);
      row.summary.textContent = bits.join(' · ') || (event.ok ? 'answered' : 'no answer');
      return;
    }

    if (event.type === 'payment') {
      setPayNotice(event.success && event.transaction ? 'Paid. Settlement ' + event.transaction : event.success ? 'Payment settled.' : 'Payment could not be settled.');
      return;
    }

    if (event.type === 'report' && event.id) {
      lastReceiptId = event.id;
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearFormError();
    setPayNotice('');

    var body = buildRequestBody();
    if (!body) return;

    setLoading(true);
    runCheck(body, handleStreamEvent)
      .then(function (result) {
        var data = result.data;
        if (!result.res.ok || !data || typeof data.verdict !== 'string') {
          var detail =
            (data && typeof data.message === 'string' && data.message) ||
            (data && typeof data.error === 'string' && data.error) ||
            ('server replied ' + result.res.status);
          throw new Error(detail);
        }
        var settled = result.res.headers.get('x-payment-response');
        if (settled) {
          try {
            var receipt = JSON.parse(global.atob(settled));
            setPayNotice(receipt.transaction ? 'Paid. Settlement ' + receipt.transaction : 'Payment settled.');
          } catch (e) {
            setPayNotice('Payment settled.');
          }
        } else {
          setPayNotice('');
        }
        renderReport(data);
        refreshStats();
      })
      .catch(function (err) {
        var detail = err && err.message ? err.message : 'network error';
        if (err && (err.code === 4001 || /user rejected|denied/i.test(detail))) {
          detail = 'payment was rejected in the wallet';
        }
        setPayNotice('');
        showFormError('Check failed: ' + detail);
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
      ? 'Evidence - ' + checks.length + (checks.length === 1 ? ' check' : ' checks') + ' against live Telegraph miners'
      : '';
    checksEl.textContent = '';
    checks.forEach(function (check) {
      checksEl.appendChild(renderCheckCard(check));
    });

    renderReceiptBar();

    report.hidden = false;
    var reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    report.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  /* ---- shareable receipt ---- */

  function renderReceiptBar() {
    if (!receiptBar) return;
    receiptBar.textContent = '';
    if (!lastReceiptId) {
      receiptBar.hidden = true;
      return;
    }
    var url = global.location.origin + '/app?r=' + lastReceiptId;
    receiptBar.hidden = false;
    receiptBar.appendChild(el('span', null, 'Permanent link to this report:'));
    var field = document.createElement('input');
    field.type = 'text';
    field.readOnly = true;
    field.value = url;
    field.setAttribute('aria-label', 'Permanent link to this report');
    field.addEventListener('focus', function () { field.select(); });
    receiptBar.appendChild(field);
    var copy = el('button', 'copy-btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var done = function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
      };
      if (global.navigator && global.navigator.clipboard) {
        global.navigator.clipboard.writeText(url).then(done, function () { field.select(); });
      } else {
        field.select();
      }
    });
    receiptBar.appendChild(copy);
  }

  /** Open a stored report from /app?r=<id> - the shared-link entry point. */
  function loadSharedReport() {
    var match = /[?&]r=([0-9a-f]{10})\b/.exec(global.location.search);
    if (!match) return;
    var id = match[1];
    fetch('/api/report/' + id)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (entry) {
        if (!entry || !entry.report) {
          showFormError('That shared report is no longer available - the feed keeps the most recent checks only.');
          return;
        }
        var request = entry.request || {};
        if (request.chain) document.getElementById('chain').value = request.chain;
        if (request.to) document.getElementById('to').value = request.to;
        if (request.valueEth !== undefined) document.getElementById('valueEth').value = String(request.valueEth);
        if (request.txHash) document.getElementById('txHash').value = request.txHash;
        if (request.protocol) document.getElementById('protocol').value = request.protocol;
        lastReceiptId = id;
        renderReport(entry.report);
        setPayNotice('Shared report from ' + entry.at + ' - every check below was paid for and answered live.');
      })
      .catch(function () { /* leave the form empty */ });
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
        : 'Direct call to the live miner from the free Telegraph catalog - dev/fallback mode';
      meta.appendChild(chip);
    }
    if (check.signalHash) {
      var hash = String(check.signalHash);
      var link = el('a', 'signal-link', 'signal ' + hash.slice(0, 10) + '…');
      link.href = SIGNAL_VERIFY_URL + encodeURIComponent(hash);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Open the raw signal on the Telegraph node: ' + hash;
      meta.appendChild(link);

      // Resolve the hash on the node without leaving the page: the answer we
      // showed either is recorded there under a miner's name, or it is not.
      var verifyBtn = el('button', 'verify-btn', 'Verify on node');
      verifyBtn.type = 'button';
      var verdictLine = el('span', 'verify-result');
      verdictLine.hidden = true;
      verifyBtn.addEventListener('click', function () {
        verifyBtn.disabled = true;
        verifyBtn.textContent = 'checking node…';
        fetch('/api/signal/' + encodeURIComponent(hash))
          .then(function (res) { return res.json().catch(function () { return null; }); })
          .then(function (data) {
            verdictLine.hidden = false;
            if (data && data.found) {
              var who = data.minerSlug || data.minerId || 'a Telegraph miner';
              var when = data.recordedAt ? ' at ' + data.recordedAt : '';
              verdictLine.className = 'verify-result ok';
              verdictLine.textContent = 'recorded by ' + who + when;
              verifyBtn.textContent = 'verified';
            } else {
              verdictLine.className = 'verify-result bad';
              verdictLine.textContent = (data && data.message) || 'the node did not recognise this hash';
              verifyBtn.textContent = 'not found';
            }
          })
          .catch(function () {
            verdictLine.hidden = false;
            verdictLine.className = 'verify-result bad';
            verdictLine.textContent = 'could not reach the node';
            verifyBtn.textContent = 'Verify on node';
            verifyBtn.disabled = false;
          });
      });
      meta.appendChild(verifyBtn);
      meta.appendChild(verdictLine);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    return card;
  }

  /* ---- wallet button ---- */

  function renderWallet(address) {
    if (!walletBtn || !walletState) return;
    if (!global.TruvianWallet || !global.TruvianWallet.isAvailable()) {
      walletBtn.hidden = true;
      walletState.textContent = 'no browser wallet detected - free checks only';
      return;
    }
    walletBtn.hidden = false;
    if (address) {
      walletBtn.textContent = global.TruvianWallet.shorten(address);
      walletBtn.classList.add('connected');
      walletState.textContent = 'connected - paid checks enabled';
    } else {
      walletBtn.textContent = 'Connect wallet';
      walletBtn.classList.remove('connected');
      walletState.textContent = 'optional - only needed once the free checks are used';
    }
  }

  if (walletBtn && global.TruvianWallet) {
    walletBtn.addEventListener('click', function () {
      if (global.TruvianWallet.getAddress()) return; // already connected
      walletBtn.disabled = true;
      global.TruvianWallet.connect()
        .then(function (address) { renderWallet(address); })
        .catch(function (err) {
          walletState.textContent = err && err.message ? err.message : 'wallet connection failed';
        })
        .then(function () { walletBtn.disabled = false; });
    });
    global.TruvianWallet.onAccountsChanged(renderWallet);
  }

  /* ---- boot ---- */

  if (global.TruvianWallet) {
    global.TruvianWallet.restore().then(renderWallet);
  } else {
    renderWallet(null);
  }
  loadSharedReport();
  refreshStats();
  setInterval(refreshStats, 30000);
})(window);
