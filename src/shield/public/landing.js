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

  /* ---------------- the featured memo: always in motion, always a real memo ----------------
     The paper floats (a slow sway, CSS), a gold hairline sweeps down it as if
     the hash were being recomputed (CSS), and every 7 s the current memo
     tears off and the next recent decision (fetched from /api/memo/<id>, the
     signed record itself) prints underneath: header, each row in turn, the
     values, the verdict stamp pressed down, the signature line drawn, then
     the hash and cost. The old memo lifts away over the new one, so the paper
     is never blank. Hover, keyboard focus or a hidden tab pause it. With
     reduced motion: no sway, no scan, no printing; the dots still switch. */
  var memoEl = $('memo');
  var body = $('memo-body');
  var stampEl = $('memo-stamp');
  var fig = memoEl ? memoEl.parentNode.parentNode : null; // figure > .memo-float > article
  var cache = {};
  var idx = 0;
  var timer = null;
  var paused = false;
  var STEP = 120; // ms between printed rows


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

  /* number the printed parts so CSS can stagger them: header, title, each row */
  function indexMemo() {
    var parts = [body.querySelector('.memo-top'), body.querySelector('.memo-title')].concat(Array.prototype.slice.call(body.querySelectorAll('.memo-fields > div')));
    parts.forEach(function (p, i) { if (p) p.style.setProperty('--i', i); });
    memoEl.style.setProperty('--n', parts.length);
  }

  function print() {
    indexMemo();
    memoEl.classList.remove('printing');
    void memoEl.offsetWidth; // restart every staggered animation
    memoEl.classList.add('printing');
  }

  /* the memo on show lifts off as a copy, over the next one printing beneath it */
  function tearOff() {
    var ghost = el('div', 'memo-ghost paper');
    var b = body.cloneNode(true); b.removeAttribute('id'); ghost.appendChild(b);
    var st = stampEl.cloneNode(true); st.removeAttribute('id'); st.classList.remove('repress'); ghost.appendChild(st);
    ghost.setAttribute('aria-hidden', 'true');
    memoEl.appendChild(ghost);
    setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 900);
  }

  function dots() {
    var c = $('memo-cycle');
    c.hidden = false; c.textContent = '';
    memoList.forEach(function (m, i) {
      var b = el('button', i === idx ? 'on' : null);
      b.type = 'button';
      b.setAttribute('aria-label', 'Show memo ' + m.id);
      if (i === idx) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', function () { show(i); restart(); });
      c.appendChild(b);
    });
  }

  function show(i) {
    var m = memoList[i];
    if (!m) return;
    var got = cache[m.id] ? Promise.resolve(cache[m.id]) : json('/api/memo/' + encodeURIComponent(m.id)).then(function (r) { cache[m.id] = r; return r; });
    got.then(function (rec) {
      if (!rec || !rec.memo) return;
      if (MOTION) tearOff();
      renderMemo(rec);
      idx = i; dots();
      if (MOTION) print();
    }).catch(function () { idx = i; /* unreadable: keep the memo on show, move on next tick */ });
  }

  function tick() {
    if (paused || document.hidden || !memoList.length) return;
    show((idx + 1) % memoList.length);
  }
  function restart() { if (timer) { clearInterval(timer); timer = setInterval(tick, 7000); } }
  function hold(on) { paused = on; if (fig) fig.classList.toggle('held', on); }

  function startMemoCycle() {
    if (!memoEl || memoList.length < 2) return;
    // start on the memo already printed in the HTML, if it is in the feed
    var at = memoList.map(function (m) { return m.id; }).indexOf('Py5ehwTL');
    idx = at >= 0 ? at : 0;
    dots();
    if (at < 0) show(0);
    if (!MOTION) return; // reduced motion: still, but the dots switch memos
    fig.classList.add('memo-live');
    if (at >= 0) print();
    memoEl.addEventListener('mouseenter', function () { hold(true); });
    memoEl.addEventListener('mouseleave', function () { hold(false); });
    fig.addEventListener('focusin', function () { hold(true); });
    fig.addEventListener('focusout', function () { hold(false); });
    document.addEventListener('visibilitychange', function () { if (fig) fig.classList.toggle('held', document.hidden || paused); });
    if (!timer) timer = setInterval(tick, 7000);
  }

  stats();
  tape(true);
  setInterval(stats, 30000);
  setInterval(function () { tape(false); }, 45000);
})();

/* Scroll effects: one IntersectionObserver marks each element .in once. All
   hidden-before-reveal CSS is scoped to html.js-reveal (landing-motion.css),
   which is only set here, so without JS or with reduced motion the page is
   fully visible and still. Also: word masks for headlines, counting figures,
   and the copy button on FIG. 02 (which works with reduced motion too). */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // copy button for the request examples (no motion involved)
  var code = document.querySelector('.code');
  if (code && navigator.clipboard) {
    var cap = code.querySelector('.fig-cap span:last-child');
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'copy-btn'; btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.querySelector('pre').textContent).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('done');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
      });
    });
    if (cap) cap.replaceWith(btn);
  }

  if (reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js-reveal');

  // headlines: wrap each word (and the serif accent as one unit) in a line mask
  Array.prototype.forEach.call(document.querySelectorAll('.sec-head h2, .final h2'), function (h) {
    var w = 0;
    Array.prototype.slice.call(h.childNodes).forEach(function (n) {
      var ref = n.nextSibling;
      var parts = n.nodeType === 3 ? n.textContent.split(/(\s+)/) : [n];
      var frag = document.createDocumentFragment();
      parts.forEach(function (p) {
        if (typeof p === 'string' && (p === '' || /^\s+$/.test(p))) { if (p) frag.appendChild(document.createTextNode(p)); return; }
        var outer = document.createElement('span'); outer.className = 'rw';
        var inner = document.createElement('span'); inner.style.setProperty('--w', String(w++));
        inner.appendChild(typeof p === 'string' ? document.createTextNode(p) : p);
        outer.appendChild(inner); frag.appendChild(outer);
      });
      if (n.nodeType === 3) h.removeChild(n); // an element was moved into its mask already
      h.insertBefore(frag, ref);
    });
  });

  // stagger indexes
  [['.desks', '.desk'], ['.cases', 'li'], ['.flow-steps', 'li'], ['.tracks', '.track'], ['.endpoints', 'tr'], ['.limits', 'li']].forEach(function (g) {
    Array.prototype.forEach.call(document.querySelectorAll(g[0]), function (box) {
      Array.prototype.forEach.call(box.querySelectorAll(':scope > ' + g[1] + ', :scope > tbody > ' + g[1]), function (el, i) { el.style.setProperty('--i', String(i)); });
    });
  });

  // figures that count up once from 0 to the value already on the page
  function countUp(el) {
    var node = null;
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3 && /\d/.test(el.childNodes[i].textContent)) { node = el.childNodes[i]; break; }
    if (!node) return;
    var m = node.textContent.match(/^(\s*\$?)([\d,]*\.?\d+)(.*)$/);
    if (!m) return;
    var target = Number(m[2].replace(/,/g, ''));
    var dec = (m[2].split('.')[1] || '').length;
    var grouped = m[2].indexOf(',') >= 0;
    var t0 = null, dur = 1100;
    function fmt(v) { var s = v.toFixed(dec); return grouped ? Number(s).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : s; }
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur); k = 1 - Math.pow(1 - k, 3);
      if (!node.parentNode) return; // the live stats replaced it: keep theirs
      node.textContent = m[1] + fmt(target * k) + m[3];
      if (k < 1) requestAnimationFrame(step);
    }
    node.textContent = m[1] + fmt(0) + m[3];
    requestAnimationFrame(step);
  }

  var targets = document.querySelectorAll('.sec-head, .final, .desk, .cases li, .flow, .track, .code, .endpoints, .limits, .stats dd, .track-fig');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      e.target.classList.add('in');
      if (e.target.matches('.stats dd, .track-fig')) countUp(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  Array.prototype.forEach.call(targets, function (el) { io.observe(el); });
})();

/* Phones and tablets (900px and below): the menu is a left drawer. It opens
   from the burger; it closes on the backdrop, Esc, the close button, any link,
   and when the window grows past 900px. Focus moves into it on open and back
   to the burger on close; the page behind does not scroll while it is open. */
(function () {
  'use strict';
  var burger = document.getElementById('burger');
  var nav = document.getElementById('mnav');
  var backdrop = document.getElementById('mbackdrop');
  var closeBtn = document.getElementById('mclose');
  if (!burger || !nav) return;
  function isOpen() { return document.body.classList.contains('menu-open'); }
  function open() {
    document.body.classList.add('menu-open');
    nav.removeAttribute('inert');
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close menu');
    setTimeout(function () { (nav.querySelector('.mlink') || closeBtn).focus({ preventScroll: true }); }, 60);
  }
  function close(returnFocus) {
    if (!isOpen()) return;
    document.body.classList.remove('menu-open');
    nav.setAttribute('inert', '');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
    if (returnFocus) burger.focus({ preventScroll: true });
  }
  burger.addEventListener('click', function () { if (isOpen()) close(true); else open(); });
  if (closeBtn) closeBtn.addEventListener('click', function () { close(true); });
  if (backdrop) backdrop.addEventListener('click', function () { close(true); });
  Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) { a.addEventListener('click', function () { close(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(true); });
  if (window.matchMedia) {
    var wide = window.matchMedia('(min-width: 901px)');
    var onWide = function () { if (wide.matches) close(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
  }
})();
