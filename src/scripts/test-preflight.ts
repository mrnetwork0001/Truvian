/**
 * Shield preflight and listing-review tests.
 *
 * Unit section: the decision rules (preflight.ts evaluate) over answers
 * copied verbatim from LIVE routed Telegraph requests made on 2026-11-20
 * (signal hashes kept so each can be resolved on the node), plus memo
 * hashing, signing and tamper detection.
 *
 * Live section (PREFLIGHT_LIVE=1): runs real preflights through Telegraph,
 * paid from TELEGRAPH_API_KEY's escrow (about $0.04 each): the legitimate
 * fixture, the not-a-contract fixture (which must buy nothing) and a listing
 * review against a sanctioned issuer.
 */
import 'dotenv/config';
import { generatePrivateKey } from 'viem/accounts';
import {
  evaluate,
  normalizePreflightRequest,
  PreflightInputError,
  runPreflight,
  summaryFacts,
  type Purchase,
  type PreflightRequest,
} from '../shield/preflight.js';
import { canonicalJson, memoDigest, signMemo, verifyMemo } from '../shield/memo.js';
import type { TokenFacts } from '../shield/tokenFacts.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---------- fixtures: chain reads ----------

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const USDC_WETH_POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' as const;
const SQUID = '0x87230146E138d3F296a9a77e497A2A83012e9Bc5' as const;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;

const usdcFacts: TokenFacts = {
  chain: 'ethereum', chainId: 1, chainLabel: 'Ethereum', address: USDC, block: '24000000', blockTime: '2026-11-20T19:00:00.000Z',
  isContract: true, codeBytes: 2186, delegatedTo: null, name: 'USD Coin', symbol: 'USDC', decimals: 6,
  totalSupplyRaw: '44361756913254070', totalSupply: '44361756913.25407',
  proxy: { implementation: '0x43506849D7C04F9138D1A2050bbF3A0c054402dd', admin: '0x807a96288A1A408dBC13DE2b1d087d10356395d2', standard: 'ZeppelinOS' }, owner: null,
};

// live: SQUID on BSC, read 2026-11-20 (735 code bytes, EIP-1967 implementation set, 800M supply)
const squidFacts: TokenFacts = {
  chain: 'bsc', chainId: 56, chainLabel: 'BNB Smart Chain', address: SQUID, block: '70000000', blockTime: '2026-11-20T19:00:00.000Z',
  isContract: true, codeBytes: 735, delegatedTo: null, name: 'Squid Game', symbol: 'SQUID', decimals: 18,
  totalSupplyRaw: '800000000000000000000000000', totalSupply: '800000000',
  proxy: { implementation: '0xF41bd7d47C8589662E852ACe26c99623FaC9c05F', admin: null, standard: 'EIP-1967' }, owner: null,
};

const eoaFacts: TokenFacts = {
  // live: vitalik.eth holds a 23-byte EIP-7702 delegation designator, which is not a token contract
  ...usdcFacts, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', isContract: false, codeBytes: 23, delegatedTo: '0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d',
  name: null, symbol: null, decimals: null, totalSupplyRaw: null, totalSupply: null, proxy: null,
};

// ---------- fixtures: live Telegraph answers (2026-11-20) ----------

function bought(key: Purchase['key'], intent: string, fields: Record<string, unknown> | null, fieldStatus: Record<string, string>, extra: Partial<Purchase> = {}): Purchase {
  return { key, intent, params: {}, ok: fields !== null, fields, fieldStatus, costUsd: 0.01, latencyMs: 20_000, reused: false, boughtAt: '2026-11-20T19:20:00.000Z', ...extra };
}

// signal 0xfd8174c906c6fe47a1b39373586dbab142f162d5308020a15c597f90016e0153 (miner 20260828)
const securityUsdc = bought('security', 'SECURITY_REVIEW_GENERAL', {
  verdict: null, vulnerability_count: null,
  issues: ['it is an upgradeable proxy, so its code can be replaced'],
  summary: 'USD Coin (USDC) at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on Ethereum is medium risk: it is an upgradeable proxy, so its code can be replaced (medium). honeypot: no; buy tax 0%, sell tax 0%; mintable: unknown; owner: none reported; top 10 holders own 22.5%, per GoPlus\'s contract scan. This is an automated scan of the deployed contract, not a manual audit.',
}, { verdict: 'rejected', vulnerability_count: 'missing', issues: 'ok', summary: 'ok' });

// signal 0x52336e27a8fb4cdb4d6f44acb918c213330bc7132d14983a310f18012234c019 (miner 20260828)
const securitySquid = bought('security', 'SECURITY_REVIEW_GENERAL', {
  verdict: null, vulnerability_count: null,
  issues: ['it is an upgradeable proxy, so its code can be replaced'],
  summary: 'Squid Game (SQUID) at 0x87230146E138d3F296a9a77e497A2A83012e9Bc5 on BNB Smart Chain is medium risk: it is an upgradeable proxy, so its code can be replaced (medium). honeypot: not determined; buy tax 0%, sell tax 0%; mintable: unknown; owner: none reported; top 10 holders own 59.1%; DEX liquidity about $167,466, per GoPlus\'s contract scan. This is an automated scan of the deployed contract, not a manual audit.',
}, { verdict: 'rejected', vulnerability_count: 'missing', issues: 'ok', summary: 'ok' });

// signal 0xdf871d49027bb82124d5bccea9c443fb14a8268916bbb670278c3f9ff39dbe34 (miner 4433)
const supplyUsdc = bought('supply', 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', { total_supply: 44361756913.25407 }, { total_supply: 'ok' });

// signal 0x2ed86f8dfd73a3ff636d59370a33474b8efce8ed466996cb30571015e332303f (miner 20260828)
const washUsdc = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
  subject: USDC_WETH_POOL, verdict: 'inconclusive', wash_volume_pct: 0,
  signals: ['24h volume $158.70M is 2.4x the pool\'s $66.63M liquidity', '5207 buys and 4255 sells in 24h'],
  summary: 'The WETH/USDC on uniswap (ethereum) pool is not clearly organic or washed. None of its volume is above a generous organic turnover of 5x liquidity a day (0% in excess).',
}, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' });

// signal 0x6a82404331ea69e05f8076484723a46aece0fdcd5688db88a570bb75051c4b96 (miner 7373)
const liquidityUsdc = bought('liquidity', 'LIQUIDITY_DEPTH_VERIFY_GENERAL', { liquidity_usd: 66608130.9794 }, { liquidity_usd: 'ok' });

// signal 0x220ba1cd6f81dc99842e250250de1878e911f42642b0cf0d63a902f09e30da32 (miner 710637)
const sanctionsGarantex = bought('sanctions', 'SANCTIONS_SCREENING_MATCH_GENERAL', {
  name: 'Garantex Europe OU', matched: true, matches: ['GARANTEX EUROPE OU'], lists: ['OFAC SDN', 'UK Sanctions List (entities only)'], match_score: 1,
}, { name: 'ok', matched: 'ok', matches: 'ok', lists: 'ok', match_score: 'ok' });

// signal 0xa8f6841329e840f3360a262529360ac54cf964095425eda4721be2ca83594569 (miner 710637); delisted by OFAC in March 2025
const sanctionsClear = bought('sanctions', 'SANCTIONS_SCREENING_MATCH_GENERAL', {
  name: 'Circle Internet Financial', matched: false, matches: null, lists: ['OFAC SDN', 'UK Sanctions List (entities only)'], match_score: 0,
}, { name: 'ok', matched: 'ok', matches: 'missing', lists: 'ok', match_score: 'ok' });

const failed = (key: Purchase['key'], intent: string, error: string): Purchase => bought(key, intent, null, {}, { error, costUsd: 0 });

const tradeUsdc: PreflightRequest = { mode: 'trade', chain: 'ethereum', token: USDC, pool: USDC_WETH_POOL, tradeUsd: 1000 };
const usdcAll = [securityUsdc, supplyUsdc, washUsdc, liquidityUsdc];

// ---------- unit: decisions ----------

{
  const r = evaluate(tradeUsdc, usdcFacts, usdcAll, null);
  check('legitimate token (USDC) clears: HOLD', r.decision === 'HOLD', r.findings.filter((f) => f.severity !== 'pass' && f.severity !== 'info').map((f) => f.rule).join(',') || 'no findings to clear');
  check('missing verdict is disclosed, decision rests on scan facts', r.findings.some((f) => f.rule === 'security.scan_clean' && /no verdict field/i.test(f.detail)));
  check('upgradeable proxy is disclosed as info from the chain read', r.findings.some((f) => f.rule === 'chain.upgradeable' && f.severity === 'info' && f.source === 'chain'));
  check('supply agrees with the chain within tolerance', r.findings.some((f) => f.rule === 'supply.agrees'));
}

{
  const r = evaluate({ ...tradeUsdc, token: SQUID, chain: 'bsc' }, squidFacts, [securitySquid, { ...supplyUsdc, fields: { total_supply: 800000000 } }, washUsdc, { ...liquidityUsdc, fields: { liquidity_usd: 167466 } }], null);
  check('risky token (SQUID) is not cleared', r.decision !== 'HOLD' && r.decision !== 'LIST', r.decision);
  check('risky token: holder concentration flagged', r.findings.some((f) => f.rule === 'security.holder_concentration'));
  check('risky token: undetermined honeypot needs review', r.findings.some((f) => f.rule === 'security.honeypot_unknown'));
}

{
  const r = evaluate(tradeUsdc, eoaFacts, [], null);
  check('not a contract: REJECT with nothing bought', r.decision === 'REJECT' && r.findings[0]?.rule === 'chain.not_a_contract');
  check('an EIP-7702 delegated account is named as such', /EIP-7702 delegation to 0x5A7FC1/.test(r.findings[0]?.detail ?? ''));
}

{
  const r = evaluate(tradeUsdc, usdcFacts, [failed('security', 'SECURITY_REVIEW_GENERAL', 'miner step failed: timeout'), supplyUsdc, washUsdc, liquidityUsdc], null);
  check('a check that did not answer cannot clear: REVIEW', r.decision === 'REVIEW' && r.findings.some((f) => f.rule === 'security.unavailable'));
}

{
  const r = evaluate(tradeUsdc, usdcFacts, [securityUsdc, { ...supplyUsdc, fields: { total_supply: 50_000_000_000 } }, washUsdc, liquidityUsdc], null);
  check('conflicting sources (supply 12.7% off the chain) need review', r.decision === 'REVIEW' && r.findings.some((f) => f.rule === 'supply.conflict'));
}

{
  const r = evaluate(tradeUsdc, usdcFacts, [{ ...securityUsdc, fields: { ...securityUsdc.fields!, summary: 'X is high risk. honeypot: yes; buy tax 0%, sell tax 100%; top 10 holders own 10%.' } }, supplyUsdc, washUsdc, liquidityUsdc], null);
  check('honeypot reported: REJECT', r.decision === 'REJECT' && r.findings.some((f) => f.rule === 'security.honeypot'));
  check('100% sell tax is blocking', r.findings.some((f) => f.rule === 'security.sell_tax' && f.severity === 'block'));
}

{
  const r = evaluate(tradeUsdc, usdcFacts, [securityUsdc, supplyUsdc, { ...washUsdc, fields: { ...washUsdc.fields!, wash_volume_pct: 64, verdict: 'wash_trading' } }, liquidityUsdc], null);
  check('64% wash volume: REJECT', r.decision === 'REJECT' && r.findings.some((f) => f.rule === 'wash.block'));
}

{
  const r = evaluate({ ...tradeUsdc, tradeUsd: 2_000_000 }, usdcFacts, usdcAll, null);
  check('a trade of 3% of the pool needs review (price impact)', r.decision === 'REVIEW' && r.findings.some((f) => f.rule === 'liquidity.price_impact'));
}

{
  const listing: PreflightRequest = { mode: 'listing', chain: 'ethereum', token: USDC, issuer: 'Garantex Europe OU' };
  const r = evaluate(listing, usdcFacts, [securityUsdc, supplyUsdc, washUsdc, sanctionsGarantex], null);
  check('listing: sanctioned issuer (Garantex) is REJECT', r.decision === 'REJECT' && r.findings.some((f) => f.rule === 'sanctions.match'));
  const clean = evaluate({ ...listing, issuer: 'Circle Internet Financial' }, usdcFacts, [securityUsdc, supplyUsdc, washUsdc, sanctionsClear], null);
  check('listing: clean issuer and token is LIST', clean.decision === 'LIST', clean.findings.filter((f) => f.severity === 'review' || f.severity === 'block').map((f) => f.rule).join(','));
  const uncertain = evaluate({ ...listing, issuer: 'Circle Internet Financial' }, usdcFacts, [securityUsdc, supplyUsdc, washUsdc, { ...sanctionsClear, fields: { ...sanctionsClear.fields!, matched: null } }], null);
  check('listing: uncertain screening is never cleared', uncertain.decision === 'REVIEW' && uncertain.findings.some((f) => f.rule === 'sanctions.uncertain'));
  const treasury = { address: '0x0000000000000000000000000000000000000001', block: '23999990', balanceGwei: '1000', source: 'test' };
  const conflict = evaluate({ ...listing, issuer: 'Circle Internet Financial', treasury: '0x0000000000000000000000000000000000000001' }, usdcFacts,
    [securityUsdc, supplyUsdc, washUsdc, sanctionsClear, bought('treasury', 'ONCHAIN_METRIC_VERIFY_GENERAL', { balance_gwei: 2000 }, { balance_gwei: 'ok' })], treasury);
  check('listing: treasury balance conflicting with the chain needs review', conflict.decision === 'REVIEW' && conflict.findings.some((f) => f.rule === 'treasury.conflict'));
}

{
  // live, signal 0x0908884b720c7c6aab9fe4f6c0c5ae36f6881adc7c2ba222f599963775d4b4f5: WETH's top 10 holders are protocols and bridges
  const wethScan = { ...securityUsdc, fields: { ...securityUsdc.fields!, issues: [], summary: "Wrapped Ether (WETH) at 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on Ethereum is low risk. honeypot: no; buy tax 0%, sell tax 0%; mintable: unknown; owner: none reported; top 10 holders own 58.2%, per GoPlus's contract scan." } };
  const deep = evaluate(tradeUsdc, usdcFacts, [wethScan, supplyUsdc, washUsdc, liquidityUsdc], null);
  check('concentration with a deep pool ($66M) is disclosed, not held against the token', deep.decision === 'HOLD' && deep.findings.some((f) => f.rule === 'security.holder_concentration' && f.severity === 'info'));
  const thin = evaluate(tradeUsdc, usdcFacts, [wethScan, supplyUsdc, washUsdc, { ...liquidityUsdc, fields: { liquidity_usd: 400_000 } }], null);
  check('the same concentration with a thin pool ($400k) needs review', thin.decision === 'REVIEW' && thin.findings.some((f) => f.rule === 'security.holder_concentration' && f.severity === 'review'));
}

{
  const f = summaryFacts(securitySquid.fields!.summary as string);
  check('summary facts parsed from the provider text', f.honeypot === 'unknown' && f.buyTax === 0 && f.sellTax === 0 && f.top10 === 59.1, JSON.stringify(f));
  check('summary facts absent when the provider words it otherwise', summaryFacts('Looks fine.').honeypot === null);
}

// ---------- unit: input ----------

{
  const rejects = (body: unknown, re: RegExp) => {
    try { normalizePreflightRequest(body); return false; } catch (e) { return e instanceof PreflightInputError && re.test(e.message); }
  };
  check('input: trade needs a pool', rejects({ mode: 'trade', chain: 'ethereum', token: USDC }, /pool/));
  check('input: listing needs an issuer', rejects({ mode: 'listing', chain: 'ethereum', token: USDC }, /issuer/));
  check('input: bad address refused', rejects({ mode: 'trade', chain: 'ethereum', token: '0x123', pool: USDC_WETH_POOL }, /token/));
  check('input: unknown chain refused', rejects({ mode: 'trade', chain: 'dogechain', token: USDC, pool: USDC_WETH_POOL }, /chain/));
  const ok = normalizePreflightRequest({ mode: 'trade', chain: 'ethereum', token: USDC.toLowerCase(), pool: USDC_WETH_POOL });
  check('input: addresses checksummed, trade size defaults to $1,000', ok.token === USDC && ok.tradeUsd === 1000);
}

// ---------- unit: memos ----------

{
  check('canonical JSON sorts keys and drops undefined', canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }) === '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  check('digest ignores key order', memoDigest({ a: 1, b: 2 }) === memoDigest({ b: 2, a: 1 }));
  process.env.SHIELD_MEMO_KEY = generatePrivateKey();
  const memo = { version: 'truvian-shield-memo/1', decision: 'HOLD', cost: { telegraphUsd: 0.04 } } as never;
  const signed = await signMemo(memo);
  const good = await verifyMemo(JSON.parse(JSON.stringify(signed.memo)), signed.signature);
  check('signed memo verifies and recovers the Shield signer', good.signedByThisShield && good.recoveredSigner === signed.signer);
  const tampered = await verifyMemo({ ...(signed.memo as object), decision: 'REJECT' }, signed.signature);
  check('an edited memo no longer verifies as Shield\'s', !tampered.signedByThisShield && tampered.sha256 !== signed.sha256);
  delete process.env.SHIELD_MEMO_KEY;
}

// ---------- live ----------

if (process.env.PREFLIGHT_LIVE === '1') {
  console.log('\n-- live (paid from TELEGRAPH_API_KEY escrow) --');
  // WETH: no owner, no proxy, no mint key. (USDC is a fair REVIEW: one admin key can freeze, upgrade and mint.)
  const legitInput = { mode: 'trade', chain: 'ethereum', token: WETH, pool: USDC_WETH_POOL, tradeUsd: 1000 };
  const legit = await runPreflight(normalizePreflightRequest(legitInput));
  console.log(`WETH trade: ${legit.decision} (${legit.decisionRule}); $${legit.cost.telegraphUsd} over ${legit.cost.paidRequests} paid, ${legit.cost.reusedRequests} reused, ${legit.cost.failedRequests} failed; ${legit.latencyMs} ms`);
  for (const p of legit.purchases) console.log(`  ${p.key.padEnd(9)} ${p.ok ? 'ok ' : 'ERR'} ${p.minerId ?? '-'} ${p.minerName ?? ''} $${p.costUsd} ${p.signalHash ?? p.error ?? ''}`);
  for (const f of legit.findings) console.log(`  [${f.severity}] ${f.rule}: ${f.title}`);
  check('live: every purchase on the legitimate fixture answered', legit.purchases.every((p) => p.ok), legit.purchases.filter((p) => !p.ok).map((p) => `${p.key}: ${p.error}`).join('; '));
  check('live: legitimate fixture is not rejected', legit.decision !== 'REJECT', legit.decision);
  check('live: every finding that holds the token back rests on a paid answer or the chain',
    legit.findings.filter((f) => f.severity === 'review' || f.severity === 'block').every((f) =>
      f.source === 'chain' || f.evidence.every((k) => legit.purchases.some((p) => p.key === k && (p.signalHash || p.error)))));
  check('live: each paid answer carries a signal hash', legit.purchases.filter((p) => p.ok && !p.reused).every((p) => typeof p.signalHash === 'string'));

  const again = await runPreflight(normalizePreflightRequest(legitInput));
  check('live: the same preflight again reuses every fresh answer (a failed one is bought again)', again.cost.reusedRequests === legit.purchases.filter((p) => p.ok).length && again.purchases.filter((p) => p.reused).every((p) => p.costUsd === 0), `$${again.cost.telegraphUsd}, ${again.cost.reusedRequests} reused`);

  const eoa = await runPreflight(normalizePreflightRequest({ mode: 'trade', chain: 'ethereum', token: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', pool: USDC_WETH_POOL }));
  check('live: not-a-contract fixture is REJECT and buys nothing', eoa.decision === 'REJECT' && eoa.purchases.length === 0 && eoa.cost.telegraphUsd === 0);

  const sanctioned = await runPreflight(normalizePreflightRequest({ mode: 'listing', chain: 'ethereum', token: USDC, issuer: 'Garantex Europe OU' }));
  console.log(`Garantex listing: ${sanctioned.decision}; $${sanctioned.cost.telegraphUsd}`);
  check('live: sanctioned issuer listing is REJECT', sanctioned.decision === 'REJECT' && sanctioned.findings.some((f) => f.rule === 'sanctions.match'),
    sanctioned.findings.filter((f) => f.evidence.includes('sanctions')).map((f) => `${f.rule}: ${f.detail}`).join('; '));
}

console.log(failures === 0 ? '\nall preflight tests passed' : `\n${failures} preflight test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
