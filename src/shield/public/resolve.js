// Truvian Resolve: independent prediction-market resolution desk.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c !== null && c !== undefined) n.append(c);
    return n;
  };

  // Recorded live on 2026-11-25; markets do not change once settled.
  const FIXTURES = [
    { label: 'Trump wins 2024 (Polymarket) · expect RESOLVED', cls: 'preset-safe', v: { source: 'polymarket', market: '253591', event: '' } },
    { label: 'Ukraine minerals deal "before April" (Polymarket, settled YES) · expect DISPUTED', cls: 'preset-block', v: { source: 'polymarket', market: '521607', event: 'Did the United States and Ukraine sign a minerals deal before April 1, 2025?' } },
    { label: 'Fed, December 2026 (Kalshi) · expect TOO EARLY, $0', cls: '', v: { source: 'kalshi', market: 'KXFEDDECISION-26DEC-H0', event: '' } },
    { label: 'Dallas vs Denver, Nov 24 (Kalshi) · expect REVIEW', cls: '', v: { source: 'kalshi', market: 'KXNBAGAME-26NOV24DALDEN-DAL', event: '' } },
  ];

  function setSource(src) {
    $('source').value = src;
    for (const f of document.querySelectorAll('.v-market')) f.classList.toggle('hidden', src === 'manual');
    for (const f of document.querySelectorAll('.v-manual')) f.classList.toggle('hidden', src !== 'manual');
  }
  function fill(v) {
    setSource(v.source);
    for (const [k, val] of Object.entries(v)) if ($(k) && k !== 'source') $(k).value = val;
  }
  $('fixtures').replaceChildren(...FIXTURES.map((f) => {
    const b = el('button', { type: 'button', class: `preset-btn ${f.cls}`, text: f.label });
    b.addEventListener('click', () => fill(f.v));
    return b;
  }));
  $('source').addEventListener('change', () => setSource($('source').value));

  const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
  const short = (h) => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h || '');

  function showError(msg) {
    const e = $('form-error');
    e.textContent = msg;
    e.hidden = false;
  }

  function renderMarket(m) {
    const settled = m.settled ? `${m.settled.toUpperCase()}${m.settledAt ? ` at ${m.settledAt}` : ''}` : 'not settled';
    $('market-card').replaceChildren(
      el('div', { class: 'q', text: m.question }),
      el('div', { class: 'row' }, [el('span', { text: `${m.source} · ` }), el('b', { text: m.id }), el('span', { text: ` · status ${m.status} · closes ${m.closeTime || 'n/a'} · venue settlement: ` }), el('b', { text: settled })]),
      el('div', { class: 'row' }, [el('span', { text: 'sent to miners: ' }), el('span', { class: 'mono', text: m.event })]),
      m.rules ? el('div', { class: 'row detail', text: m.rules.length > 420 ? `${m.rules.slice(0, 420)}…` : m.rules }) : null,
    );
  }

  const answerRows = new Map();
  function answerRow(a) {
    const what = a.ok
      ? el('div', {}, [
        el('b', { text: (a.outcome || 'none').toUpperCase() }),
        a.winner ? el('span', { text: ` · winner ${a.winner}` }) : null,
        a.resolvedAt ? el('span', { text: ` · settled ${a.resolvedAt}` }) : null,
        el('div', { class: 'srcs' }, a.sources.slice(0, 3).map((s) => (/^https?:\/\//.test(s) ? el('a', { href: s, target: '_blank', rel: 'noopener', text: s }) : el('span', { text: s })))),
      ])
      : el('span', { class: 'err', text: a.error || 'no answer' });
    const receipt = a.receipt ? el('div', { class: 'mono', text: `receipt ${short(a.receipt.hash)}` }) : null;
    const signal = a.signalHash ? el('div', {}, [el('a', { class: 'mono', href: `/api/signal/${a.signalHash}`, target: '_blank', rel: 'noopener', text: `signal ${short(a.signalHash)}` })]) : null;
    return el('tr', {}, [
      el('td', {}, [el('div', { text: a.minerName || a.minerId || '—' }), el('div', { class: 'detail', text: `${a.route}${a.rank ? ` · rank ${a.rank}` : ''}` })]),
      el('td', {}, [what]),
      el('td', {}, [el('span', { class: `sev ${a.verdict}`, text: a.verdict }), el('div', { class: 'detail', text: a.why })]),
      el('td', {}, [el('div', { text: `${usd(a.costUsd)} · ${(a.latencyMs / 1000).toFixed(1)} s` }), receipt, signal]),
    ]);
  }
  function addAnswer(a) {
    const body = $('answers');
    if (answerRows.size === 0) body.replaceChildren();
    const row = answerRow(a);
    answerRows.set(`${a.route}-${a.minerId}-${answerRows.size}`, row);
    body.append(row);
  }

  function renderStored(stored) {
    const m = stored.memo;
    renderMarket(m.market);
    $('decision').className = `decision ${m.decision}`;
    $('decision').replaceChildren(
      el('div', { class: 'word', text: m.decision === 'TOO_EARLY' ? 'TOO EARLY' : m.decision + (m.outcome ? `: ${m.outcome.toUpperCase()}` : '') }),
      el('div', { class: 'rule', text: m.decisionRule }),
    );
    $('costline').replaceChildren(
      el('span', {}, ['Telegraph cost ', el('b', { text: usd(m.cost.telegraphUsd) })]),
      el('span', {}, ['paid answers ', el('b', { text: String(m.cost.paidRequests) })]),
      el('span', {}, ['memo ', el('b', { text: stored.id })]),
    );
    answerRows.clear();
    $('answers').replaceChildren();
    if (m.answers.length === 0) $('answers').append(el('tr', {}, [el('td', { colspan: '4', class: 'pending', text: 'nothing was bought' })]));
    for (const a of m.answers) addAnswer(a);
    $('findings').replaceChildren(...m.findings.map((f) => el('tr', {}, [
      el('td', {}, [el('span', { class: `sev ${f.severity}`, text: f.severity })]),
      el('td', {}, [el('div', { text: f.title }), el('div', { class: 'detail', text: f.detail })]),
    ])));
    const sel = m.selection;
    $('selection').replaceChildren(
      el('div', { text: `Node ranking: epoch ${sel.epoch ?? 'n/a'}. Routed ask expected to reach ${sel.routedTop ? sel.routedTop.slug : 'the node\'s pick'}.` }),
      ...sel.attempts.map((t) => el('div', { text: `pinned ${t.slug} (${t.minerId}): ${t.outcome}` })),
      sel.excluded.length ? el('div', { text: `Left out: ${sel.excluded.map((x) => `${x.slug} (${x.why})`).join('; ')}` }) : null,
      sel.note ? el('div', { text: sel.note }) : null,
    );
    renderSig(stored);
  }

  function renderSig(stored) {
    const box = $('sig');
    box.classList.remove('hidden');
    const a = stored.anchor || {};
    const anchorRow = a.anchored
      ? el('a', { href: a.explorer, target: '_blank', rel: 'noopener', class: 'mono', text: `${short(a.signature)} (slot ${a.slot ?? '?'})` })
      : el('span', { text: a.note || 'not anchored' });
    const result = el('span', { class: 'detail' });
    const verifyBtn = el('button', { type: 'button', text: 'Verify signature' });
    verifyBtn.addEventListener('click', async () => {
      result.textContent = 'checking…';
      try {
        const r = await fetch('/api/memo/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memo: stored.memo, signature: stored.signature }) });
        const v = await r.json();
        result.textContent = v.signedByThisShield ? `valid: signed by ${v.recoveredSigner}, sha256 ${short(v.sha256)}` : `not this Shield's signature (${v.error || v.recoveredSigner})`;
      } catch (e) { result.textContent = String(e); }
    });
    const dl = el('a', { class: 'btnlike', href: `data:application/json,${encodeURIComponent(JSON.stringify(stored, null, 2))}`, download: `resolution-${stored.id}.json`, text: 'Download memo (JSON)' });
    const link = el('a', { class: 'btnlike', href: `/resolve?r=${stored.id}`, text: 'Permalink' });
    box.replaceChildren(
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'sha256' }), el('span', { class: 'mono', text: stored.sha256 })]),
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'signer' }), el('span', { class: 'mono', text: stored.signer || 'unsigned' })]),
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'Solana devnet' }), anchorRow]),
      el('div', { class: 'row' }, [el('span', { class: 'k', text: 'anchor memo' }), el('span', { class: 'mono', text: a.memoText || '' })]),
      el('div', { class: 'actions' }, [verifyBtn, dl, link, result]),
    );
  }

  async function run(ev) {
    ev.preventDefault();
    $('form-error').hidden = true;
    const src = $('source').value;
    const body = { source: src };
    if (src === 'manual') { body.question = $('question').value; body.rules = $('rules').value; body.closeTime = $('closeTime').value; } else body.market = $('market').value.trim();
    if ($('event').value.trim()) body.event = $('event').value.trim();
    $('out').classList.remove('hidden');
    $('decision').className = 'decision';
    $('decision').replaceChildren(el('div', { class: 'word pending', text: 'working…' }));
    $('market-card').replaceChildren(el('span', { class: 'pending', text: 'reading the venue…' }));
    answerRows.clear();
    $('answers').replaceChildren(el('tr', {}, [el('td', { colspan: '4', class: 'pending', text: 'waiting for the miners… (the routed ask can take a minute)' })]));
    $('findings').replaceChildren();
    $('selection').replaceChildren();
    $('sig').classList.add('hidden');
    $('submit-btn').disabled = true;
    try {
      const res = await fetch('/api/resolve?stream=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || j.error || `http ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.type === 'market') renderMarket(e.market);
          else if (e.type === 'answer') addAnswer(e.answer);
          else if (e.type === 'memo') { renderStored(e); history.replaceState(null, '', `/resolve?r=${e.id}`); }
          else if (e.type === 'error') throw new Error(e.message);
        }
      }
      loadRecent();
    } catch (e) {
      showError(String(e.message || e));
      $('decision').replaceChildren(el('div', { class: 'word err', text: 'no decision' }));
    } finally {
      $('submit-btn').disabled = false;
    }
  }

  async function loadPermalink(id) {
    try {
      const r = await fetch(`/api/resolution/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error('no stored resolution with that id');
      $('out').classList.remove('hidden');
      renderStored(await r.json());
    } catch (e) { showError(e.message); }
  }

  async function loadRecent() {
    try {
      const r = await fetch('/api/resolutions?limit=10');
      const { resolutions } = await r.json();
      $('recent').replaceChildren(...(resolutions.length ? resolutions.map((x) => el('li', {}, [
        el('a', { href: `/resolve?r=${x.id}`, text: x.id }),
        el('span', { text: ` · ${x.decision}${x.outcome ? ` ${x.outcome.toUpperCase()}` : ''} · ${x.source} ${x.market} · ${usd(x.costUsd)}${x.anchored ? ' · anchored' : ''} · ${x.question}` }),
      ])) : [el('li', { class: 'pending', text: 'none yet' })]));
    } catch { $('recent').replaceChildren(el('li', { class: 'pending', text: 'could not load' })); }
  }

  $('rs-form').addEventListener('submit', run);
  fill(FIXTURES[0].v);
  const id = new URLSearchParams(location.search).get('r');
  if (id) loadPermalink(id);
  loadRecent();
})();
