/* Truvian Shield - pay for a desk run once the free allowance is used.

   TruvianPay.fetch(url, init) behaves like fetch(). When Shield answers 402
   (the 5 free runs a day are used), it shows a small payment sheet: the price,
   the network, and one button. The button connects the visitor's browser
   wallet (wallet.js), signs a gasless USDC authorization for the quoted price
   (x402, EIP-3009) and sends the same request again with the X-PAYMENT
   header. Shield settles the payment only after the run succeeds, and reports
   it in the stream as a {type: "payment"} event.

   Resolves with the final Response (the paid one, or the original when no
   payment was needed). Rejects with an Error whose message is meant for the
   visitor when they cancel or the wallet fails. Plain ES5, no libraries. */
(function (global) {
  'use strict';

  var STYLE_ID = 'truvian-pay-style';
  var CSS = [
    '.tpay,.tpay *{box-sizing:border-box}',
    '.tpay-backdrop{position:fixed;inset:0;z-index:60;background:var(--scrim,rgba(0,0,0,.58));display:flex;align-items:center;justify-content:center;padding:16px}',
    '.tpay{width:100%;max-width:440px;background:var(--ink-2,#13120f);color:var(--bone,#ece5d6);border:1px solid var(--rule,#2b2822);box-shadow:0 30px 80px rgba(0,0,0,.6);font-family:var(--sans,system-ui,sans-serif)}',
    '.tpay-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--rule,#2b2822);font:500 .66rem/1.3 var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;color:var(--bone-faint,#8d8678)}',
    '.tpay-head b{color:var(--gold,#caa53d);font-weight:500}',
    '.tpay-close{background:none;border:0;color:var(--bone-dim,#b2ab9c);font-size:1.4rem;line-height:1;cursor:pointer;min-width:40px;min-height:40px}',
    '.tpay-body{padding:20px 18px calc(20px + env(safe-area-inset-bottom))}',
    '.tpay-price{font:300 2.6rem/1 var(--sans,system-ui);letter-spacing:-.02em}',
    '.tpay-price small{font:400 .8rem var(--mono,monospace);color:var(--bone-faint,#8d8678);margin-left:.5rem;letter-spacing:0}',
    '.tpay p{margin:.8rem 0 0;font-size:.92rem;line-height:1.55;color:var(--bone-dim,#b2ab9c)}',
    '.tpay dl{margin:1rem 0 0;display:grid;grid-template-columns:7rem minmax(0,1fr);gap:.4rem .8rem;font:400 .74rem/1.5 var(--mono,monospace)}',
    '.tpay dt{color:var(--bone-faint,#8d8678);text-transform:uppercase;letter-spacing:.12em;font-size:.62rem;padding-top:.15rem}',
    '.tpay dd{margin:0;color:var(--bone,#ece5d6);overflow-wrap:anywhere}',
    '.tpay-go{margin-top:1.2rem;width:100%;min-height:48px;border:0;background:var(--gold-fill,#caa53d);color:var(--on-gold,#15120a);font:600 .95rem var(--sans,system-ui);cursor:pointer}',
    '.tpay-go:disabled{opacity:.6;cursor:progress}',
    '.tpay-status{margin-top:.8rem;min-height:1.2em;font:400 .76rem/1.5 var(--mono,monospace);color:var(--bone-faint,#8d8678)}',
    '.tpay-status.err{color:var(--reject,#d0645a)}',
    '@media (max-width:640px){.tpay-backdrop{align-items:flex-end;padding:0}.tpay{max-width:none;max-height:94dvh;overflow-y:auto;overscroll-behavior:contain}}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var NETWORK_LABEL = { 'base-sepolia': 'Base Sepolia (testnet)', base: 'Base' };

  function priceUsd(req) {
    var atomic = Number(req.maxAmountRequired);
    return isFinite(atomic) ? (atomic / 1e6).toFixed(2) : null;
  }

  function shortAddr(a) {
    return a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '';
  }

  /** Show the sheet; resolve with an X-PAYMENT header, or reject when the visitor cancels. */
  function askToPay(requirements, what) {
    ensureStyle();
    return new Promise(function (resolve, reject) {
      var opener = document.activeElement;
      var backdrop = el('div', 'tpay-backdrop');
      var box = el('div', 'tpay');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'tpay-title');
      var head = el('div', 'tpay-head');
      var title = el('span');
      title.id = 'tpay-title';
      title.appendChild(document.createTextNode('Free runs used · '));
      title.appendChild(el('b', null, 'pay per run'));
      var close = el('button', 'tpay-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Cancel');
      head.appendChild(title);
      head.appendChild(close);

      var body = el('div', 'tpay-body');
      var price = priceUsd(requirements);
      var p = el('div', 'tpay-price', price ? '$' + price : 'Paid run');
      p.appendChild(el('small', null, 'test USDC'));
      body.appendChild(p);
      body.appendChild(el('p', null, 'Your 5 free runs for today are used. ' + (what || 'This run') + ' needs one payment, signed in your browser wallet. No gas: you sign a USDC authorization and Shield settles it only after the run succeeds.'));
      var dl = el('dl');
      var add = function (k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); };
      add('Network', NETWORK_LABEL[requirements.network] || requirements.network);
      add('Pay to', shortAddr(requirements.payTo));
      add('Asset', 'USDC ' + shortAddr(requirements.asset));
      body.appendChild(dl);
      var go = el('button', 'tpay-go', global.TruvianWallet && global.TruvianWallet.isAvailable() ? 'Connect wallet and pay' : 'No browser wallet found');
      go.type = 'button';
      var status = el('div', 'tpay-status');
      status.setAttribute('aria-live', 'polite');
      if (!global.TruvianWallet || !global.TruvianWallet.isAvailable()) {
        go.disabled = true;
        status.textContent = 'Install MetaMask, Coinbase Wallet or Rabby, get test USDC on Base Sepolia (faucet.circle.com), then try again.';
      }
      body.appendChild(go);
      body.appendChild(status);
      box.appendChild(head);
      box.appendChild(body);
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      go.focus();

      var done = false;
      function finish() {
        done = true;
        document.removeEventListener('keydown', onKey);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (opener && opener.focus) opener.focus();
      }
      function cancel() {
        if (done) return;
        finish();
        reject(new Error('Payment cancelled. Your 5 free runs reset at 00:00 UTC.'));
      }
      function onKey(e) { if (e.key === 'Escape') cancel(); }
      document.addEventListener('keydown', onKey);
      close.addEventListener('click', cancel);
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) cancel(); });
      go.addEventListener('click', function () {
        go.disabled = true;
        status.className = 'tpay-status';
        status.textContent = 'Check your wallet: connect, switch to ' + (NETWORK_LABEL[requirements.network] || requirements.network) + ', then sign.';
        global.TruvianWallet.signPayment(requirements).then(function (header) {
          status.textContent = 'Signed. Running…';
          finish();
          resolve(header);
        }, function (err) {
          go.disabled = false;
          status.className = 'tpay-status err';
          var msg = err && err.message ? err.message : String(err);
          status.textContent = /reject|denied|cancel/i.test(msg) ? 'You declined in the wallet. Nothing was paid.' : msg;
        });
      });
    });
  }

  /**
   * fetch(), paying once if Shield asks. `what` names the run in the sheet,
   * e.g. "This settlement check".
   */
  function paidFetch(url, init, what) {
    init = init || {};
    return fetch(url, init).then(function (res) {
      if (res.status !== 402) return res;
      return res.json().catch(function () { return {}; }).then(function (challenge) {
        var requirements = challenge && challenge.accepts && challenge.accepts[0];
        if (!requirements) throw new Error((challenge && (challenge.message || challenge.error)) || 'Payment required, but no price was quoted.');
        return askToPay(requirements, what).then(function (header) {
          var headers = {};
          var src = init.headers || {};
          for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) headers[k] = src[k];
          headers['X-PAYMENT'] = header;
          var retry = {};
          for (var j in init) if (Object.prototype.hasOwnProperty.call(init, j)) retry[j] = init[j];
          retry.headers = headers;
          return fetch(url, retry);
        });
      });
    });
  }

  /** Show the stream's {type: "payment"} event under the decision: settled (with its Base Sepolia transaction) or not. */
  function showPayment(container, ev) {
    if (!container || !ev) return;
    var span = document.createElement('span');
    span.appendChild(document.createTextNode(ev.success ? 'paid by you ' : 'payment not settled '));
    var b = document.createElement('b');
    if (ev.success && ev.transaction) {
      var a = document.createElement('a');
      a.href = 'https://sepolia.basescan.org/tx/' + ev.transaction;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = ev.transaction.slice(0, 10) + '…';
      b.appendChild(a);
    } else {
      b.textContent = ev.success ? 'settled' : (ev.reason || 'not charged');
    }
    span.appendChild(b);
    container.appendChild(span);
  }

  global.TruvianPay = { fetch: paidFetch, askToPay: askToPay, showPayment: showPayment };
})(window);
