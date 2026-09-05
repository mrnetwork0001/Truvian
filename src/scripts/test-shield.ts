/**
 * Truvian Shield verdict-engine tests.
 *
 * Unit section: pure verdict logic with injected IntentResult fixtures. The
 * fixture answer strings are copied verbatim from LIVE responses of our
 * Telegraph miner (https://miner.truvian.xyz /gas and /tx, captured
 * 2026-09-05) so the parsers are exercised against real answer shapes.
 *
 * E2E section (SHIELD_E2E=1): boots the real Fastify server and runs
 * /api/check + /api/verify against live Telegraph miners. Requires
 * src/shield/telegraph.ts to exist — the unit section does not.
 */
import {
  assessTxVerification,
  buildCheckReport,
  normalizeCheckRequest,
  parseFeeLevel,
  parseFirstGwei,
  parseTxStatus,
  parseUsdAmount,
  ShieldInputError,
  type SignalOutcome,
  type SignalSet,
} from '../shield/verdict.js';
import type { CheckReport, CheckRequest, IntentResult } from '../shield/types.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---------- fixtures (real live answer text) ----------

// live: GET https://miner.truvian.xyz/gas?chain=base
const GAS_LOW_BASE =
  'The current gas price on Base (chain id 8453) is 0.006 gwei (6000000 wei) at block 50920176, a low transaction fee level. The base fee per gas is 0.005 gwei (5000000 wei) and the suggested priority fee is 0.001 gwei (1000000 wei), so a standard EIP-1559 transaction can use max fee 0.011 gwei (11000000 wei). Recent priority fees over the last 5 blocks: 25th percentile 0.001 gwei, median 0.0011 gwei, 75th percentile 0.0022 gwei. The L1 base fee observed by Base is 0.085975448 gwei (85975448 wei).';

// same composer, congested numbers (level word per our miner's classifier)
const GAS_HIGH_BASE =
  'The current gas price on Base (chain id 8453) is 62 gwei (62000000000 wei) at block 50920176, a high transaction fee level. The base fee per gas is 60 gwei (60000000000 wei) and the suggested priority fee is 1.5 gwei (1500000000 wei), so a standard EIP-1559 transaction can use max fee 121.5 gwei (121500000000 wei).';

const GAS_NORMAL_ETH =
  'The current gas price on Ethereum (chain id 1) is 25 gwei (25000000000 wei) at block 21550100, a normal transaction fee level.';

// live: GET https://miner.truvian.xyz/tx?chain=base&hash=0xfc6f...
const TX_HASH = '0xfc6fb2065f2f85353b46bebbb1b171c3d7e2ce71695c9a6d111c4f25af00b66a';
const TX_TO = '0x41f4F4197718e083b54FE89D28A7d4f41F498BF6';
const TX_SUCCESS =
  'Transaction 0xfc6fb2065f2f85353b46bebbb1b171c3d7e2ce71695c9a6d111c4f25af00b66a on Base (chain id 8453) succeeded in block 50920180. It transferred 0 ETH (0 wei) from 0x1f6791653247bf9C8C09598E6B1A1AeC3aaec957 to the recipient 0x41f4F4197718e083b54FE89D28A7d4f41F498BF6, invoking function selector 0x7b84f330.';

// same composer, reverted status word
const TX_REVERTED =
  'Transaction 0x9d3f7f2065f2f85353b46bebbb1b171c3d7e2ce71695c9a6d111c4f25af00b66a on Base (chain id 8453) reverted in block 50812345. It transferred 0.05 ETH (50000000000000000 wei) from 0x1f6791653247bf9C8C09598E6B1A1AeC3aaec957 to the recipient 0x41f4F4197718e083b54FE89D28A7d4f41F498BF6, invoking function selector 0xa9059cbb.';

// our miner's IntentError.answerText for TX_NOT_FOUND (src/types/index.ts)
const NOT_FOUND_HASH = `0x${'ab'.repeat(32)}`;
const TX_NOT_FOUND =
  `Transaction ${NOT_FOUND_HASH} not found on base. The transaction hash is well formed but no matching transaction exists on the chains searched, so it was never mined there or belongs to a chain this miner does not serve.`;

// third-party CRYPTO_PRICE / TVL_LOOKUP miners answer in this style
const PRICE_ETH = 'The current price of Ethereum (ETH) is $4,215.34 USD, up 2.1% in the last 24 hours.';
const TVL_BIG = "Uniswap's total value locked (TVL) is currently $4.12 billion across all deployments.";
const TVL_SMALL = 'The total value locked in tinyswap is $412,000.00.';
const GIBBERISH = 'sorry, upstream data source unavailable right now, please retry';

// ---------- helpers ----------

function ok(answer: string, over: Partial<IntentResult> = {}): SignalOutcome {
  return { ok: true, result: { answer, latencyMs: 42, transport: 'direct', raw: { answer }, ...over } };
}
function down(reason = 'connect ECONNREFUSED'): SignalOutcome {
  return { ok: false, reason, transport: 'direct', latencyMs: 7 };
}
function signals(p: Partial<SignalSet>): SignalSet {
  return { gas: undefined, tx: undefined, price: undefined, tvl: undefined, ...p };
}
function checkOf(report: CheckReport, name: string) {
  return report.checks.find((c) => c.name === name);
}

function unitTests() {
  console.log('--- parsers (fixtures from live miner answers) ---');
  check('fee level parsed from live gas answer', parseFeeLevel(GAS_LOW_BASE) === 'low');
  check('gwei parsed from live gas answer', parseFirstGwei(GAS_LOW_BASE) === 0.006);
  check('high fee level parsed', parseFeeLevel(GAS_HIGH_BASE) === 'high');
  check('normal fee level parsed', parseFeeLevel(GAS_NORMAL_ETH) === 'normal');
  check('fee level null on gibberish', parseFeeLevel(GIBBERISH) === null);
  check('tx success parsed from live tx answer', parseTxStatus(TX_SUCCESS) === 'success');
  check('tx reverted parsed', parseTxStatus(TX_REVERTED) === 'reverted');
  check('tx not-found parsed from miner not-found text', parseTxStatus(TX_NOT_FOUND) === 'not_found');
  check('tx status null on gibberish', parseTxStatus(GIBBERISH) === null);
  check('usd price parsed with commas', parseUsdAmount(PRICE_ETH) === 4215.34);
  check('tvl parsed with billion suffix', parseUsdAmount(TVL_BIG) === 4.12e9);
  check('tvl parsed plain dollars', parseUsdAmount(TVL_SMALL) === 412000);
  check('usd amount in "N usd" form', parseUsdAmount('price is 4,215.34 USD today') === 4215.34);
  check('usd null on gibberish', parseUsdAmount(GIBBERISH) === null);

  console.log('\n--- FEE check ---');
  const feeOnly: CheckRequest = { chain: 'base' };
  let r = buildCheckReport(feeOnly, signals({ gas: ok(GAS_LOW_BASE) }));
  check('low gas on base -> FEE pass, SAFE 100', r.verdict === 'SAFE' && r.score === 100 && checkOf(r, 'FEE')?.status === 'pass');
  r = buildCheckReport(feeOnly, signals({ gas: ok(GAS_HIGH_BASE) }));
  check('high fee level -> FEE warn', checkOf(r, 'FEE')?.status === 'warn');
  check('single warn -> score 85 SAFE with reason', r.score === 85 && r.verdict === 'SAFE' && r.reasons.length === 1);
  r = buildCheckReport({ chain: 'ethereum' }, signals({ gas: ok(GAS_NORMAL_ETH) }));
  check('25 gwei > 10x ethereum floor -> warn despite normal level', checkOf(r, 'FEE')?.status === 'warn');
  r = buildCheckReport(feeOnly, signals({ gas: ok(GIBBERISH) }));
  check('unparseable gas answer -> warn, never a crash', checkOf(r, 'FEE')?.status === 'warn');
  r = buildCheckReport(feeOnly, signals({ gas: down() }));
  check('gas query failure -> FEE error with reason', checkOf(r, 'FEE')?.status === 'error' && r.reasons[0]!.includes('ECONNREFUSED'));
  check('all checks errored can never be SAFE', r.verdict !== 'SAFE');

  console.log('\n--- COUNTERPARTY check ---');
  const withTx: CheckRequest = { chain: 'base', txHash: TX_HASH, to: TX_TO.toLowerCase() };
  r = buildCheckReport(withTx, signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_SUCCESS) }));
  check('succeeded referenced tx involving to -> pass', checkOf(r, 'COUNTERPARTY')?.status === 'pass');
  check('address match is case-insensitive', r.verdict === 'SAFE');
  r = buildCheckReport(withTx, signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_REVERTED) }));
  const cpFail = checkOf(r, 'COUNTERPARTY');
  check('reverted referenced tx -> fail', cpFail?.status === 'fail');
  check('one fail caps verdict at CAUTION', r.verdict === 'CAUTION' && r.score === 65);
  r = buildCheckReport(withTx, signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_NOT_FOUND) }));
  check('not-found referenced tx -> warn', checkOf(r, 'COUNTERPARTY')?.status === 'warn');
  const otherTo: CheckRequest = { chain: 'base', txHash: TX_HASH, to: `0x${'12'.repeat(20)}` };
  r = buildCheckReport(otherTo, signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_SUCCESS) }));
  check('succeeded tx not mentioning counterparty -> warn', checkOf(r, 'COUNTERPARTY')?.status === 'warn');
  r = buildCheckReport(withTx, signals({ gas: ok(GAS_LOW_BASE), tx: ok(GIBBERISH) }));
  check('unparseable tx answer -> warn', checkOf(r, 'COUNTERPARTY')?.status === 'warn');
  r = buildCheckReport({ chain: 'base' }, signals({ gas: ok(GAS_LOW_BASE) }));
  check('no txHash -> no COUNTERPARTY row', checkOf(r, 'COUNTERPARTY') === undefined);

  console.log('\n--- VALUE check (ETH priced at $4,215.34) ---');
  r = buildCheckReport({ chain: 'base', valueEth: 0.5 }, signals({ gas: ok(GAS_LOW_BASE), price: ok(PRICE_ETH) }));
  check('0.5 ETH (~$2.1k) -> pass', checkOf(r, 'VALUE')?.status === 'pass' && r.verdict === 'SAFE');
  r = buildCheckReport({ chain: 'base', valueEth: 5 }, signals({ gas: ok(GAS_LOW_BASE), price: ok(PRICE_ETH) }));
  check('5 ETH (~$21k) -> warn over $10k', checkOf(r, 'VALUE')?.status === 'warn');
  r = buildCheckReport({ chain: 'base', valueEth: 30 }, signals({ gas: ok(GAS_LOW_BASE), price: ok(PRICE_ETH) }));
  check('30 ETH (~$126k) without txHash -> fail', checkOf(r, 'VALUE')?.status === 'fail' && r.verdict === 'CAUTION');
  r = buildCheckReport(
    { chain: 'base', valueEth: 30, txHash: TX_HASH, to: TX_TO },
    signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_SUCCESS), price: ok(PRICE_ETH) }),
  );
  check('30 ETH with verified success tx evidence -> warn not fail', checkOf(r, 'VALUE')?.status === 'warn' && r.verdict === 'SAFE');
  r = buildCheckReport(
    { chain: 'base', valueEth: 30, txHash: TX_HASH },
    signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_REVERTED), price: ok(PRICE_ETH) }),
  );
  check('30 ETH with REVERTED evidence -> VALUE fail + COUNTERPARTY fail', checkOf(r, 'VALUE')?.status === 'fail' && checkOf(r, 'COUNTERPARTY')?.status === 'fail');
  check('two fails -> BLOCK', r.verdict === 'BLOCK' && r.score === 30);
  r = buildCheckReport({ chain: 'base', valueEth: 5 }, signals({ gas: ok(GAS_LOW_BASE), price: ok(GIBBERISH) }));
  check('unparseable price answer -> warn', checkOf(r, 'VALUE')?.status === 'warn');
  r = buildCheckReport({ chain: 'base', valueEth: 5 }, signals({ gas: ok(GAS_LOW_BASE), price: down() }));
  check('price query failure -> VALUE error', checkOf(r, 'VALUE')?.status === 'error');

  console.log('\n--- LIQUIDITY check ---');
  r = buildCheckReport({ chain: 'base', protocol: 'uniswap' }, signals({ gas: ok(GAS_LOW_BASE), tvl: ok(TVL_BIG) }));
  check('$4.12B TVL -> pass', checkOf(r, 'LIQUIDITY')?.status === 'pass');
  r = buildCheckReport({ chain: 'base', protocol: 'tinyswap' }, signals({ gas: ok(GAS_LOW_BASE), tvl: ok(TVL_SMALL) }));
  check('$412k TVL -> warn under $1M', checkOf(r, 'LIQUIDITY')?.status === 'warn');
  r = buildCheckReport({ chain: 'base', protocol: 'uniswap' }, signals({ gas: ok(GAS_LOW_BASE), tvl: down() }));
  check('TVL unavailable -> warn (per spec, not error)', checkOf(r, 'LIQUIDITY')?.status === 'warn');
  r = buildCheckReport({ chain: 'base', protocol: 'uniswap' }, signals({ gas: ok(GAS_LOW_BASE), tvl: ok(GIBBERISH) }));
  check('unparseable TVL -> warn', checkOf(r, 'LIQUIDITY')?.status === 'warn');
  r = buildCheckReport({ chain: 'base' }, signals({ gas: ok(GAS_LOW_BASE) }));
  check('no protocol -> no LIQUIDITY row', checkOf(r, 'LIQUIDITY') === undefined);

  console.log('\n--- report assembly ---');
  const fullReq: CheckRequest = { chain: 'base', to: TX_TO, valueEth: 0.5, txHash: TX_HASH, protocol: 'uniswap' };
  const fullSignals = signals({ gas: ok(GAS_LOW_BASE), tx: ok(TX_SUCCESS), price: ok(PRICE_ETH), tvl: ok(TVL_BIG) });
  r = buildCheckReport(fullReq, fullSignals);
  check('all four green -> SAFE 100, 4 checks', r.verdict === 'SAFE' && r.score === 100 && r.checks.length === 4);
  check('all-pass report still states a reason', r.reasons.length === 1);
  const r2 = buildCheckReport(fullReq, fullSignals);
  check('deterministic: identical report on repeat call', JSON.stringify(r) === JSON.stringify(r2));
  const allBad = buildCheckReport(
    { chain: 'base', valueEth: 5, txHash: TX_HASH, protocol: 'x' },
    signals({ gas: ok(GIBBERISH), tx: ok(GIBBERISH), price: ok(GIBBERISH), tvl: ok(GIBBERISH) }),
  );
  check('four unparseable answers -> four warns, no crash', allBad.checks.every((c) => c.status === 'warn') && allBad.checks.length === 4);
  check('four warns -> score 40 BLOCK', allBad.score === 40 && allBad.verdict === 'BLOCK');
  check('empty signal set -> CAUTION 50', buildCheckReport({}, signals({})).verdict === 'CAUTION');
  const meta = ok(GAS_LOW_BASE, { minerName: 'truvian-onchain-truth', costUsd: 0.001, signalHash: '0xdeadbeef', transport: 'x402' });
  r = buildCheckReport({ chain: 'base' }, signals({ gas: meta }));
  const feeItem = checkOf(r, 'FEE');
  check(
    'miner metadata carried onto the check item',
    feeItem?.minerName === 'truvian-onchain-truth' && feeItem?.signalHash === '0xdeadbeef' && feeItem?.costUsd === 0.001 && feeItem?.transport === 'x402',
  );

  console.log('\n--- assessTxVerification ---');
  let v = assessTxVerification(TX_HASH, ok(TX_SUCCESS));
  check('verify success -> SAFE 100 pass', v.verdict === 'SAFE' && v.score === 100 && v.checks[0]!.status === 'pass');
  v = assessTxVerification(TX_HASH.toUpperCase().replace('0X', '0x'), ok(TX_SUCCESS));
  check('verify hash match is case-insensitive', v.verdict === 'SAFE');
  v = assessTxVerification('0x9d3f7f2065f2f85353b46bebbb1b171c3d7e2ce71695c9a6d111c4f25af00b66a', ok(TX_REVERTED));
  check('verify reverted -> BLOCK fail', v.verdict === 'BLOCK' && v.score === 20 && v.checks[0]!.status === 'fail');
  v = assessTxVerification(NOT_FOUND_HASH, ok(TX_NOT_FOUND));
  check('verify not-found -> CAUTION warn', v.verdict === 'CAUTION' && v.checks[0]!.status === 'warn');
  v = assessTxVerification(TX_HASH, ok('Transaction 0x1111111111111111111111111111111111111111111111111111111111111111 succeeded.'));
  check('success about a DIFFERENT hash -> CAUTION warn', v.verdict === 'CAUTION' && v.checks[0]!.status === 'warn');
  v = assessTxVerification(TX_HASH, down());
  check('verify with failed query -> CAUTION error', v.verdict === 'CAUTION' && v.checks[0]!.status === 'error');
  v = assessTxVerification(TX_HASH, undefined);
  check('verify with no signal -> CAUTION error', v.verdict === 'CAUTION' && v.checks[0]!.status === 'error');

  console.log('\n--- normalizeCheckRequest ---');
  const n = normalizeCheckRequest({ chain: 'Base', to: TX_TO, valueEth: '1.5', txHash: TX_HASH.toUpperCase().replace('0X', '0x'), protocol: ' uniswap ' });
  check('chain lowercased', n.chain === 'base');
  check('string valueEth coerced to number', n.valueEth === 1.5);
  check('txHash lowercased', n.txHash === TX_HASH);
  check('protocol trimmed', n.protocol === 'uniswap');
  const throws = (fn: () => unknown): boolean => {
    try { fn(); return false; } catch (e) { return e instanceof ShieldInputError; }
  };
  check('bad txHash rejected', throws(() => normalizeCheckRequest({ txHash: '0x123' })));
  check('bad to address rejected', throws(() => normalizeCheckRequest({ to: 'vitalik.eth' })));
  check('negative valueEth rejected', throws(() => normalizeCheckRequest({ valueEth: -1 })));
  check('non-object body rejected', throws(() => normalizeCheckRequest('nope')));
  check('empty body -> empty request', Object.keys(normalizeCheckRequest({})).length === 0);
}

// ---------- e2e (SHIELD_E2E=1): real server + live Telegraph miners ----------

async function e2eTests() {
  console.log('\n--- e2e: live server + live Telegraph miners ---');
  const { buildShieldServer } = await import('../shield/server.js');
  const app = buildShieldServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = (await (await fetch(`${base}/healthz`)).json()) as { ok?: boolean };
    check('e2e healthz ok', health.ok === true);

    const res = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', valueEth: 0.25 }),
    });
    check('e2e /api/check responds 200', res.status === 200);
    const report = (await res.json()) as CheckReport;
    console.log(JSON.stringify(report, null, 2));
    check('e2e verdict is a real verdict', ['SAFE', 'CAUTION', 'BLOCK'].includes(report.verdict));
    check('e2e report has checks', Array.isArray(report.checks) && report.checks.length >= 1);
    check('e2e transports labeled', report.checks.every((c) => c.transport === 'x402' || c.transport === 'direct'));

    const verify = (await (await fetch(`${base}/api/verify/${TX_HASH}?chain=base`)).json()) as CheckReport;
    check('e2e /api/verify returns a report', ['SAFE', 'CAUTION', 'BLOCK'].includes(verify.verdict) && verify.checks.length === 1);

    const bad = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: '0xnope' }),
    });
    check('e2e invalid input -> 400', bad.status === 400);

    const stats = (await (await fetch(`${base}/api/stats`)).json()) as { checksRun: number; telegraphRequests: number };
    check('e2e stats counted', stats.checksRun >= 1 && stats.telegraphRequests >= 2);
  } finally {
    await app.close();
  }
}

async function main() {
  unitTests();
  if (process.env.SHIELD_E2E === '1') {
    await e2eTests();
  } else {
    console.log('\n(e2e skipped — set SHIELD_E2E=1 to run the real server against live Telegraph miners)');
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
