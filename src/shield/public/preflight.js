// Truvian Shield: token preflight, listing review and holdings proof desks.
// Every value shown comes from /api/preflight or /api/memo; miner text is
// inserted as text, never as HTML.
(() => {
  'use strict';

  const NODE = 'https://devnode.telegraphprotocol.com';
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const FIXTURES = {
    trade: [
      { label: 'WETH → expect HOLD', cls: 'preset-safe', v: { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', tradeUsd: '1000' } },
      { label: 'SQUID rug pull (BSC) → not cleared', cls: 'preset-block', v: { chain: 'bsc', token: '0x87230146E138d3F296a9a77e497A2A83012e9Bc5', pool: '0x683c425D917E8fEf34c8bbbeab57246Dd2a8B718', tradeUsd: '1000' } },
      { label: 'Not a token (vitalik.eth) → REJECT, $0', cls: 'preset-block', v: { chain: 'ethereum', token: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', tradeUsd: '1000' } },
      { label: 'Whale-size trade → price impact', cls: '', v: { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', tradeUsd: '5000000' } },
    ],
    listing: [
      { label: 'UNI by Uniswap Labs, timelock treasury', cls: '', v: { chain: 'ethereum', token: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', pool: '', issuer: 'Uniswap Labs', treasury: '0x1a9C8182C09F50C8318d769245beA52c32BE35BC' } },
      { label: 'Sanctioned issuer (Garantex) → REJECT', cls: 'preset-block', v: { chain: 'ethereum', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', pool: '', issuer: 'Garantex Europe OU', treasury: '' } },
    ],
    // Read on-chain 2026-11-23 (block 26476779): the ENS DAO timelock held 2,435,008 USDC and
    // 8,632,326 ENS; the Uniswap timelock held 262,247,996 UNI. Balances move, so the labels say "expect".
    holdings: [
      { label: 'ENS DAO treasury (USDC, ENS + pool) → expect VERIFIED', cls: 'preset-safe', v: { chain: 'ethereum', wallet: '0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7', holdings: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 2400000\n0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72, 8600000, 0x92560C178cE069CC014138eD3C2F5221Ba71f58a' } },
      { label: 'Overstated claim (300M UNI in the Uniswap timelock) → REJECT', cls: 'preset-block', v: { chain: 'ethereum', wallet: '0x1a9C8182C09F50C8318d769245beA52c32BE35BC', holdings: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984, 300000000' } },
    ],
  };

  const NOTES = {
    trade: 'An agent is about to buy a token. Shield reads the contract from the chain, then buys a security review, the total supply, a wash-trading check and the pool\'s liquidity through Telegraph, one routed request each, with one second opinion from the next-best ranked miner when an answer examined nothing, and decides HOLD, REVIEW or REJECT. The buy itself is only simulated.',
    listing: 'A listings desk is reviewing a token. Shield reads the contract from the chain, buys a security review, the total supply and a wash-trading check, screens the issuer against sanctions lists, and checks the treasury balance against the chain, then decides LIST, REVIEW or REJECT in a signed memo.',
    holdings: 'An investor agent checks what a fund or index says it holds, without trusting the issuer. Shield reads every holding\'s balance in the custody wallet from the chain at one block, buys the same balance, the token\'s total supply and, for a rebalancing pool, its liquidity through Telegraph, and decides VERIFIED, REVIEW or REJECT. The memo states each holding\'s share of the float and the pool depth, with a receipt for every answer.',
  };

  const KIND_LABEL = { 'token-preflight': 'Token preflight', 'listing-review': 'Listing review', 'holdings-proof': 'Holdings proof' };
  const KIND_SHORT = { 'token-preflight': 'preflight', 'listing-review': 'listing', 'holdings-proof': 'holdings' };
  const SUBMIT = { trade: 'Run preflight', listing: 'Run listing review', holdings: 'Run holdings proof' };
  // The symbol of each holding, by index, once the chain read names it
  let holdingSymbols = [];
  const rowKey = (p) => `${p.key}${p.holding === undefined || p.holding === null ? '' : `-${p.holding}`}`;
  const tagText = (p) => `${p.intent.replace(/_GENERAL$/, '')}${p.holding === undefined || p.holding === null ? '' : ` · ${holdingSymbols[p.holding] || `#${p.holding + 1}`}`}`;

  let mode = 'trade';

  function setMode(next) {
    mode = next;
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    for (const f of document.querySelectorAll('.mode-trade')) f.classList.toggle('hidden', mode !== 'trade');
    for (const f of document.querySelectorAll('.mode-listing')) f.classList.toggle('hidden', mode !== 'listing');
    for (const f of document.querySelectorAll('.mode-holdings')) f.classList.toggle('hidden', mode !== 'holdings');
    for (const f of document.querySelectorAll('.mode-token')) f.classList.toggle('hidden', mode === 'holdings');
    $('pool-hint').textContent = mode === 'trade' ? '- the pool the trade goes through' : '(optional) - its liquidity is bought too';
    $('desk-note').textContent = NOTES[mode];
    $('submit-btn').textContent = SUBMIT[mode];
    const box = $('fixtures');
    box.replaceChildren(...FIXTURES[mode].map((f) => {
      const b = el('button', { type: 'button', class: `preset-btn ${f.cls}`, text: f.label });
      b.addEventListener('click', () => fill(f.v));
      return b;
    }));
  }

  function fill(v) {
    for (const [k, val] of Object.entries(v)) if ($(k)) $(k).value = val;
  }

  // ---------- rendering ----------

  const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  function answerText(p) {
    if (!p.ok) return el('span', { class: 'err', text: `no answer: ${p.error || 'unknown'}` });
    const f = p.fields || {};
    switch (p.intent) {
      case 'SECURITY_REVIEW_GENERAL': {
        const issues = Array.isArray(f.issues) ? f.issues : [];
        return el('span', {}, el('b', { text: f.verdict || 'no verdict' }), f.vulnerability_count != null ? ` · ${f.vulnerability_count} weaknesses` : '',
          el('div', { class: 'fields', text: [f.summary, ...issues].filter(Boolean).join(' · ').slice(0, 420) }));
      }
      case 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL': return el('span', { text: f.total_supply != null ? `${Number(f.total_supply).toLocaleString('en-US')} tokens` : 'no figure' });
      case 'WASH_TRADING_DETECTION_GENERAL': return el('span', {}, el('b', { text: f.wash_volume_pct != null ? `${f.wash_volume_pct}% wash` : 'no figure' }), f.verdict ? ` · ${f.verdict}` : '', el('div', { class: 'fields', text: String(f.summary || '').slice(0, 300) }));
      case 'LIQUIDITY_DEPTH_VERIFY_GENERAL': return el('span', { text: f.liquidity_usd != null ? usd(f.liquidity_usd) : 'no figure' });
      case 'SANCTIONS_SCREENING_MATCH_GENERAL': return el('span', {}, el('b', { text: f.matched === true ? 'MATCH' : f.matched === false ? 'no match' : 'uncertain' }), f.match_score != null ? ` · score ${f.match_score}` : '', Array.isArray(f.lists) ? el('div', { class: 'fields', text: `${f.lists.length} lists checked` }) : null);
      case 'ONCHAIN_METRIC_VERIFY_GENERAL': return el('span', { text: f.balance_gwei != null ? `${f.balance_gwei} Gwei` : 'no figure' });
      case 'WALLET_BALANCE_CHECK_GENERAL': return el('span', { text: f.balance != null ? `${Number(f.balance).toLocaleString('en-US', { maximumFractionDigits: 6 })}${f.token_symbol ? ` ${f.token_symbol}` : ''}` : 'no figure' });
      default: return el('span', { class: 'fields', text: JSON.stringify(f).slice(0, 300) });
    }
  }

  const signalLink = (hash, label) => el('a', { href: `${NODE}/engine/v1/signal/${hash}`, target: '_blank', rel: 'noopener', class: 'mono', text: `${label || ''}${hash.slice(0, 10)}…${hash.slice(-6)}` });

  // A second opinion: why the first answer was set aside, who was asked, and both signals.
  function secondOpinionNote(so) {
    const who = so.miner ? `${so.miner.id} ${so.miner.name} (rank ${so.miner.rank}, epoch ${so.miner.epoch})` : null;
    const first = so.first.minerId ? `${so.first.minerId}${so.first.minerName ? ` ${so.first.minerName}` : ''}` : 'the routed ask';
    const head = so.used ? `second opinion used: ${who}` : who ? `second opinion not used: ${who}` : 'no second opinion';
    const links = [
      so.first.signalHash ? signalLink(so.first.signalHash, 'first ') : null,
      so.second && so.second.signalHash ? signalLink(so.second.signalHash, 'second ') : null,
    ].filter(Boolean);
    return el('div', { class: 'second' },
      el('b', { text: head }),
      el('div', { text: `first answer (${first}) was no evidence: ${so.reason}` }),
      el('div', { text: so.outcome }),
      so.second ? el('div', { text: `second ask: $${so.second.costUsd}${so.second.receipt ? ` · receipt ${so.second.receipt.hash.slice(0, 10)}…${so.second.receipt.hash.slice(-6)}` : ''}` }) : null,
      links.length ? el('div', {}, ...links.flatMap((a, i) => (i ? [' · ', a] : [a]))) : null);
  }

  function purchaseRow(p) {
    const signal = p.signalHash
      ? el('span', {}, signalLink(p.signalHash))
      : el('span', { class: 'pending', text: '-' });
    const meta = [
      p.minerName ? `${p.minerId} ${p.minerName}` : (p.minerId || '-'),
      p.servedRank ? `rank ${p.servedRank}` : null,
      p.reused ? `reused (bought ${new Date(p.boughtAt).toISOString().slice(11, 19)} UTC) · $0` : `$${p.costUsd}`,
      p.reused ? null : `${(p.latencyMs / 1000).toFixed(1)} s`,
    ].filter(Boolean).join(' · ');
    const receipt = p.receipt
      ? el('div', { class: 'fields mono', title: `paid ${p.receipt.amountUsd} USDC from ${p.receipt.payer} to miner registration ${p.receipt.miner}, settles in epoch ${p.receipt.epochId} (${p.receipt.rail})`, text: `receipt ${p.receipt.hash.slice(0, 10)}…${p.receipt.hash.slice(-6)} · epoch ${p.receipt.epochId}` })
      : null;
    return el('tr', { 'data-key': rowKey(p) },
      el('td', {}, el('span', { class: 'intent-tag', text: tagText(p) })),
      el('td', {}, answerText(p), p.secondOpinion ? secondOpinionNote(p.secondOpinion) : null),
      el('td', { class: 'detail' }, meta, receipt),
      el('td', {}, signal));
  }

  function renderPlan(plan) {
    const body = $('purchases');
    body.replaceChildren(...plan.map((p) => el('tr', { 'data-key': rowKey(p) },
      el('td', {}, el('span', { class: 'intent-tag', text: tagText(p) })),
      el('td', { class: 'pending', colspan: '3', text: 'asking Telegraph…' }))));
    if (plan.length === 0) body.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'pending', text: 'nothing was bought' })));
  }

  function renderPurchase(p) {
    const body = $('purchases');
    const row = purchaseRow(p);
    const old = body.querySelector(`tr[data-key="${rowKey(p)}"]`);
    if (old) old.replaceWith(row); else body.append(row);
  }

  function renderChain(f) {
    const box = $('chainread');
    if (!f) { box.textContent = '-'; return; }
    const parts = [
      `${f.chainLabel} (chain id ${f.chainId}) at block ${f.block}`,
      f.isContract ? `contract, ${f.codeBytes} bytes of code` : f.delegatedTo ? `not a contract: EIP-7702 delegation to ${f.delegatedTo}` : 'no contract code',
      f.symbol ? `${f.name} (${f.symbol}), ${f.decimals} decimals` : null,
      f.totalSupply ? `totalSupply ${Number(f.totalSupply).toLocaleString('en-US')}` : null,
      f.proxy ? `${f.proxy.standard} proxy → ${f.proxy.implementation}` : null,
      f.owner ? `owner ${f.owner}` : null,
    ].filter(Boolean);
    box.replaceChildren(...parts.map((t) => el('div', { class: 'mono', text: t })));
  }

  // Holdings proof: each holding's contract and the wallet's balance, all at one block.
  function renderHoldings(reads) {
    const box = $('chainread');
    if (!reads || !reads.length) { box.textContent = '-'; return; }
    holdingSymbols = reads.map((r) => (r.facts && r.facts.symbol) || null);
    const f0 = reads[0].facts;
    const lines = [`${f0.chainLabel} (chain id ${f0.chainId}) at block ${f0.block}`];
    for (const r of reads) {
      const f = r.facts;
      if (!f.isContract) { lines.push(`${r.token}: no contract code`); continue; }
      const share = r.balanceRaw && f.totalSupplyRaw && f.totalSupplyRaw !== '0'
        ? ` (${(Number(BigInt(r.balanceRaw) * 1000000n / BigInt(f.totalSupplyRaw)) / 10000).toFixed(4)}% of supply)` : '';
      lines.push(`${f.symbol || r.token} ${r.token}: balanceOf = ${r.balance === null ? 'unreadable' : Number(r.balance).toLocaleString('en-US', { maximumFractionDigits: 6 })}${share}, claimed ${Number(r.claimed).toLocaleString('en-US')}${r.pool ? `, pool ${r.pool}` : ''}`);
    }
    box.replaceChildren(...lines.map((t) => el('div', { class: 'mono', text: t })));
  }

  function renderMemo(stored) {
    const m = stored.memo;
    const d = $('decision');
    d.className = `decision ${m.decision}`;
    d.replaceChildren(...[
      el('div', { class: 'word', text: m.decision }),
      el('div', { class: 'rule', text: `${KIND_LABEL[m.kind] || m.kind} · ${m.decisionRule}` }),
      m.action ? el('div', { class: 'action', text: `${m.action.description} (simulated, nothing sent)` }) : null,
    ].filter(Boolean));
    $('costline').replaceChildren(...[
      el('span', {}, 'Telegraph cost ', el('b', { text: `$${m.cost.telegraphUsd.toFixed(2)}` })),
      el('span', {}, 'paid requests ', el('b', { text: String(m.cost.paidRequests) })),
      el('span', {}, 'reused ', el('b', { text: String(m.cost.reusedRequests) })),
      el('span', {}, 'failed ', el('b', { text: String(m.cost.failedRequests) })),
      m.cost.secondOpinions ? el('span', {}, 'second opinions ', el('b', { text: String(m.cost.secondOpinions) })) : null,
      el('span', {}, 'time ', el('b', { text: `${(m.latencyMs / 1000).toFixed(1)} s` })),
      el('span', {}, 'budget ', el('b', { text: `$${m.cost.budgetUsd.toFixed(2)}` })),
      m.cost.escrowBeforeUsd != null ? el('span', {}, 'escrow before ', el('b', { text: `$${m.cost.escrowBeforeUsd.toFixed(2)}` })) : null,
    ].filter(Boolean));
    const order = { block: 0, review: 1, info: 2, pass: 3 };
    const findings = [...m.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    $('findings').replaceChildren(...findings.map((f) => el('tr', {},
      el('td', {}, el('span', { class: `sev ${f.severity}`, text: f.severity })),
      el('td', {}, el('b', { text: f.title }), el('div', { class: 'detail', text: f.detail })),
      el('td', { class: 'detail', text: f.source }))));
    if (m.kind === 'holdings-proof') renderHoldings(m.holdingReads); else renderChain(m.chainReads);
    $('purchases').replaceChildren(...(m.purchases.length ? m.purchases.map(purchaseRow) : [el('tr', {}, el('td', { colspan: '4', class: 'pending', text: 'nothing was bought' }))]));

    const sig = $('sig');
    sig.classList.remove('hidden');
    const row = (k, v) => el('div', { class: 'row' }, el('span', { class: 'k', text: k }), el('span', { class: 'mono', text: v }));
    const verifyOut = el('div', { class: 'detail' });
    const verifyBtn = el('button', { type: 'button', text: 'Verify signature' });
    verifyBtn.addEventListener('click', async () => {
      verifyOut.textContent = 'verifying…';
      try {
        const res = await fetch('/api/memo/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memo: m, signature: stored.signature }) });
        const v = await res.json();
        verifyOut.textContent = v.signedByThisShield
          ? `valid: sha256 ${v.sha256.slice(0, 16)}… recomputed, signed by ${v.recoveredSigner} (this Shield's memo key)`
          : `NOT this Shield's signature${v.error ? `: ${v.error}` : v.recoveredSigner ? ` (recovered ${v.recoveredSigner})` : ''}`;
      } catch (e) { verifyOut.textContent = `could not verify: ${e.message}`; }
    });
    const dl = el('button', { type: 'button', text: 'Download memo (JSON)' });
    dl.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ memo: m, sha256: stored.sha256, message: stored.message, signature: stored.signature, signer: stored.signer }, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `truvian-memo-${stored.id}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const link = el('a', { class: 'btnlike', href: `/preflight?m=${stored.id}`, text: 'Permalink' });
    sig.replaceChildren(
      row('memo id', stored.id),
      row('sha256', stored.sha256),
      row('signed message', stored.message),
      row('signature', stored.signature || 'unsigned (no memo key configured)'),
      row('signer', stored.signer || '-'),
      el('div', { class: 'actions' }, verifyBtn, dl, link),
      verifyOut,
    );
  }

  // ---------- running ----------

  function showError(msg) {
    const e = $('form-error');
    e.textContent = msg;
    e.hidden = !msg;
  }

  async function run(evt) {
    evt.preventDefault();
    showError('');
    let body;
    if (mode === 'holdings') {
      // One holding per line: token, claimed amount, pool (optional). Commas inside the amount are not supported here; write 2400000.
      const holdings = $('holdings').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [token, claimed, pool] = l.split(/[,\s]+/).filter(Boolean);
        return pool ? { token, claimed, pool } : { token, claimed };
      });
      body = { mode, chain: $('chain').value, wallet: $('wallet').value.trim(), holdings };
    } else {
      body = { mode, chain: $('chain').value, token: $('token').value.trim(), pool: $('pool').value.trim() };
      if (mode === 'trade') body.tradeUsd = $('tradeUsd').value.trim();
      else { body.issuer = $('issuer').value.trim(); body.treasury = $('treasury').value.trim(); }
    }
    holdingSymbols = [];
    const btn = $('submit-btn');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'working…';
    $('out').classList.remove('hidden');
    $('decision').className = 'decision';
    $('decision').replaceChildren(el('div', { class: 'word pending', text: 'reading the chain…' }));
    $('costline').replaceChildren();
    $('findings').replaceChildren(el('tr', {}, el('td', { colspan: '3', class: 'pending', text: 'waiting for the evidence…' })));
    $('purchases').replaceChildren();
    $('chainread').textContent = '';
    $('sig').classList.add('hidden');
    try {
      const res = await fetch('/api/preflight?stream=1', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
      if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('ndjson')) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'chain') { renderChain(ev.facts); $('decision').replaceChildren(el('div', { class: 'word pending', text: ev.facts.isContract ? 'buying intelligence through Telegraph…' : 'not a contract' })); }
          else if (ev.type === 'holdings') { renderHoldings(ev.reads); $('decision').replaceChildren(el('div', { class: 'word pending', text: 'buying the balances through Telegraph…' })); }
          else if (ev.type === 'plan') renderPlan(ev.plan);
          else if (ev.type === 'purchase') renderPurchase(ev.purchase);
          else if (ev.type === 'memo') { renderMemo(ev); history.replaceState(null, '', `/preflight?m=${ev.id}`); }
          else if (ev.type === 'error') { $('decision').className = 'decision REVIEW'; $('decision').replaceChildren(el('div', { class: 'word', text: 'NO DECISION' }), el('div', { class: 'rule', text: ev.message })); }
        }
      }
      loadRecent();
    } catch (e) {
      showError(e.message);
      $('out').classList.add('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function loadRecent() {
    try {
      const res = await fetch('/api/memos?limit=10');
      const j = await res.json();
      const list = $('recent');
      if (!j.memos.length) { list.replaceChildren(el('li', { class: 'pending', text: 'none yet' })); return; }
      list.replaceChildren(...j.memos.map((m) => el('li', {},
        el('a', { href: `/preflight?m=${m.id}`, text: `${m.decision}` }),
        ` · ${KIND_SHORT[m.kind] || m.kind} · ${m.kind === 'holdings-proof' ? `wallet ${m.token.slice(0, 10)}…` : m.symbol || m.token.slice(0, 10)} on ${m.chain} · $${m.costUsd.toFixed(2)} · ${m.createdAt.replace('T', ' ').slice(0, 16)} UTC`)));
    } catch {
      $('recent').replaceChildren(el('li', { class: 'pending', text: 'could not load' }));
    }
  }

  async function loadPermalink(id) {
    try {
      const res = await fetch(`/api/memo/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('no stored memo with that id');
      const stored = await res.json();
      const input = stored.memo.input;
      setMode(input.mode);
      if (input.mode === 'holdings') {
        fill({ chain: input.chain, wallet: input.wallet || '', holdings: (input.holdings || []).map((h) => [h.token, h.claimed, h.pool].filter(Boolean).join(', ')).join('\n') });
      } else {
        fill({ chain: input.chain, token: input.token, pool: input.pool || '', tradeUsd: input.tradeUsd ?? '1000', issuer: input.issuer || '', treasury: input.treasury || '' });
      }
      $('out').classList.remove('hidden');
      renderMemo(stored);
    } catch (e) { showError(e.message); }
  }

  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  $('pf-form').addEventListener('submit', run);
  setMode('trade');
  fill(FIXTURES.trade[0].v);
  const id = new URLSearchParams(location.search).get('m');
  if (id) loadPermalink(id);
  loadRecent();
})();
