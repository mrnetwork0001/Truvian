/**
 * Shield preflight and listing-review tests.
 *
 * Unit section: the decision rules (preflight.ts evaluate) over answers
 * copied verbatim from LIVE routed Telegraph requests made on 2026-11-20 and
 * 2026-11-21 (memos FKLfi2qT, WOYbyG3x, B4k2AxbY; signal hashes kept so each
 * can be resolved on the node), the node's ranking and the pinned ask over
 * recorded replies, second opinions with stubbed answers, plus memo hashing,
 * signing and tamper detection.
 *
 * Live section (PREFLIGHT_LIVE=1): runs real preflights through Telegraph,
 * paid from TELEGRAPH_API_KEY's escrow (about $0.04-0.08 each, second
 * opinions included): the legitimate fixture, the not-a-contract fixture
 * (which must buy nothing) and a listing review against a sanctioned issuer.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import {
  evaluate,
  memoCost,
  normalizePreflightRequest,
  noEvidence,
  PreflightInputError,
  runPreflight,
  mentionsToken,
  notExamined,
  notMeasured,
  Spend,
  summaryFacts,
  withSecondOpinion,
  type OpinionDeps,
  type Purchase,
  type PreflightRequest,
} from '../shield/preflight.js';
import { canonicalJson, memoDigest, signMemo, verifyMemo } from '../shield/memo.js';
import {
  askPinnedIntent,
  errorBodyText,
  latestRanked,
  rankMiners,
  typedAnswerFrom,
  type CatalogMinerEntry,
  type IntentRanking,
  type Leaderboard,
  type LeaderboardRow,
  type PaymentReceipt,
  type TypedAnswer,
} from '../shield/telegraph.js';
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
  // live, memo FKLfi2qT (2026-11-20 20:33 UTC): the ranked reviewer said "Secure" about a contract it never saw,
  // signal 0x693f64e553c9eb36e02e44697b6ba277194240b22b0e28b79dc9cfb0685a76a5 (miner 9002)
  const secureUnseen = bought('security', 'SECURITY_REVIEW_GENERAL', {
    verdict: 'Secure', vulnerability_count: 0, issues: null,
    summary: 'Secure. No code, configuration, or system description was provided to evaluate, so there are no observable security weaknesses to address.',
  }, { verdict: 'ok', vulnerability_count: 'ok', issues: 'missing', summary: 'ok' });
  // signal 0x3f66aa458a06b995e423d4d0a70aad7e25035b4b2617dfbf49102c8d5aab72a2 (miner 9002)
  const washUnseen = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
    subject: 'SQUID pool 0x683c425D917E8fEf34c8bbbeab57246Dd2a8B718 on BNB Smart Chain', verdict: 'organic', wash_volume_pct: 0,
    signals: ['24h volume $2,344 is 0.0x the pool\'s $321,772 liquidity', '38 buys and 12 sells in 24h'],
    summary: 'Insufficient data. The request only contains a query string without any trade records, timestamps, addresses, or volume information to evaluate for wash trading patterns. Without actual transaction data, repeated address activity, round‑trip trades, or price impact analysis cannot be performed. Consequently, no assessment of wash trading can be made.',
  }, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' });
  // signal 0x77847c7096258b1574d44654fc069dd98f1a51176e48083618458dc729243cc8 (miner 20260828): 5.1% under the contract's 800M
  const supplySquidOff = bought('supply', 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', { total_supply: 758870612.0653371 }, { total_supply: 'ok' });
  const liquiditySquid = bought('liquidity', 'LIQUIDITY_DEPTH_VERIFY_GENERAL', { liquidity_usd: 321771.53 }, { liquidity_usd: 'ok' });
  const squidTrade: PreflightRequest = { mode: 'trade', chain: 'bsc', token: SQUID, pool: '0x683c425D917E8fEf34c8bbbeab57246Dd2a8B718', tradeUsd: 1000 };

  const r = evaluate(squidTrade, squidFacts, [secureUnseen, supplySquidOff, washUnseen, liquiditySquid], null);
  check('a "Secure" verdict about a contract the reviewer never saw does not pass', r.findings.some((f) => f.rule === 'security.not_examined') && !r.findings.some((f) => f.rule === 'security.secure'));
  check('0% wash volume with "Insufficient data" is no evidence', r.findings.some((f) => f.rule === 'wash.not_examined') && !r.findings.some((f) => f.rule === 'wash.ok'));
  check('SQUID with the live 20:33 answers: REVIEW, and supply conflict caught', r.decision === 'REVIEW' && r.findings.some((f) => f.rule === 'supply.conflict'));
  const fixedSupply = evaluate(squidTrade, squidFacts, [secureUnseen, { ...supplySquidOff, fields: { total_supply: 800000000 } }, washUnseen, liquiditySquid], null);
  check('even with supply agreeing, answers that examined nothing cannot clear SQUID', fixedSupply.decision === 'REVIEW', fixedSupply.findings.filter((f) => f.severity === 'review').map((f) => f.rule).join(','));
  const honeypotUnseen = evaluate(squidTrade, squidFacts, [{ ...secureUnseen, fields: { ...secureUnseen.fields!, summary: 'No code was provided. honeypot: yes' } }, supplyUsdc, washUsdc, liquiditySquid], null);
  check('an answer that saw no code can neither clear nor reject: REVIEW', honeypotUnseen.decision === 'REVIEW');
  // live, memo WOYbyG3x (20:43 UTC): 86% "likely wash trading" on USDC after "Insufficient data", against a $6.12M pool
  const wash86 = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
    subject: 'USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', verdict: 'likely_wash_trading', wash_volume_pct: 86,
    summary: 'Insufficient data. No trade data or trade records were provided.',
  }, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' });
  const usdcListing = evaluate({ mode: 'listing', chain: 'ethereum', token: USDC, issuer: 'Circle Internet Financial' }, usdcFacts, [securityUsdc, supplyUsdc, wash86, sanctionsClear], null);
  check('86% wash from an answer that saw no trades does not reject USDC: REVIEW', usdcListing.decision === 'REVIEW' && usdcListing.findings.some((f) => f.rule === 'wash.not_examined'));
  check('real scan text is not mistaken for "examined nothing"', notExamined(securityUsdc.fields!.summary, securitySquid.fields!.summary, washUsdc.fields!.summary) === null);
}

// ---------- fixtures: live answers from memos WOYbyG3x (2026-11-20 20:38) and B4k2AxbY (2026-11-21 08:19) ----------

// live: WETH on Ethereum, read for memo B4k2AxbY (no proxy, no owner)
const wethFacts: TokenFacts = {
  chain: 'ethereum', chainId: 1, chainLabel: 'Ethereum', address: WETH, block: '26462238', blockTime: '2026-11-21T08:19:35.000Z',
  isContract: true, codeBytes: 3124, delegatedTo: null, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18,
  totalSupplyRaw: '2150131753628588697468727', totalSupply: '2150131.753628588697468727', proxy: null, owner: null,
};
const tradeWeth: PreflightRequest = { mode: 'trade', chain: 'ethereum', token: WETH, pool: USDC_WETH_POOL, tradeUsd: 1000 };
const receiptOf = (hash: string, miner: string): PaymentReceipt => ({ hash, rail: 'escrow', payer: '0x29476125898638c8634a97fdca8994530e8c9055', miner, amountUsd: 0.01, epochId: 30, settlement: 'epoch' });

// memo WOYbyG3x, signal 0x1e13c18e32eb0217c60a4e30e10621affd121d281eccc0dfbf1789c8617ee0fb (miner 9002 TxLens): "Secure" about a bare query
const secureQueryOnly = bought('security', 'SECURITY_REVIEW_GENERAL', {
  verdict: 'Secure', vulnerability_count: 0,
  issues: ['it is an upgradeable proxy, so its code can be replaced'],
  summary: 'Secure. The input is merely a token contract address query with no executable code, configuration, or data handling to assess; there are no injection vectors, authentication, or exposure concerns present. No further issues identified.',
}, { verdict: 'ok', vulnerability_count: 'ok', issues: 'ok', summary: 'ok' }, { minerId: '9002', minerName: 'TxLens', signalHash: '0x1e13c18e32eb0217c60a4e30e10621affd121d281eccc0dfbf1789c8617ee0fb' });

// memo WOYbyG3x, signal 0x3b029e8e1ed54237635dad42bfd1d5e5c1e9939a09d4fc6a31fd72c651ecc905 (miner 9002 TxLens)
const wash86Live = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
  subject: 'USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', verdict: 'likely_wash_trading', wash_volume_pct: 86,
  signals: ['24h volume $224.45M is 36.7x the pool\'s $6.12M liquidity', 'Buys and sells are almost equal (924 vs 853), as round-trip trading leaves them'],
  summary: 'Insufficient data. No trade data or transaction details were provided to assess patterns such as repeated trades, round‑trip volumes, price impact, identical sizes, or timing clusters.',
}, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' }, { minerId: '9002', minerName: 'TxLens', signalHash: '0x3b029e8e1ed54237635dad42bfd1d5e5c1e9939a09d4fc6a31fd72c651ecc905' });

// memo B4k2AxbY, signal 0x46e2f154f2856fd7bc3436d169feff5a73b79706dff24a0d42b436ab910732aa (miner 77007 NVD Keyword Review, served rank 1)
const securityWethNvd = bought('security', 'SECURITY_REVIEW_GENERAL', {
  verdict: 'Secure', vulnerability_count: 0,
  issues: [
    'CWE-668 Exposure of Resource to Wrong Sphere (Lack of EIP-20 compliance)',
    'CWE-252 Unchecked Return Value (Race conditions in approve)',
    'Low (integration hazard): the fallback function accepts any call without reverting (deposit();), so a call to a function the contract does not have, such as permit, succeeds silently; an integrator that assumes the call worked can be misled (the "phantom function" pattern). The 2022 Multichain (AnySwap) exploit used this against WETH: its permit call to WETH did nothing and did not revert. This is from general knowledge, not the code shown.',
  ],
  summary: 'The WETH9 contract is a legacy implementation that predates the finalized ERC-20 standard, leading to integration hazards such as the lack of return values in certain scenarios and the standard ERC-20 \'approve\' race condition. General knowledge indicates that while the contract is battle-tested and secure for its intended use as a bridge for Ether, its manual implementation of transfer logic and lack of current best-practice protections make it less robust than modern token standards. Low (integration hazard): see issues.',
}, { verdict: 'ok', vulnerability_count: 'ok', issues: 'ok', summary: 'ok' }, {
  minerId: '77007', minerName: 'NVD Keyword Review', servedRank: 1, signalHash: '0x46e2f154f2856fd7bc3436d169feff5a73b79706dff24a0d42b436ab910732aa',
  receipt: receiptOf('0xf8e43ef6d9f26a1cd377980e0d15527fbd46dc9f21b2de4f8070ec6ea7820b0c', '3858'),
});

// memo B4k2AxbY, signal 0x57bb4f2b73514959a9baa0e61dbf9f7399054e2f78891005910986621334e190 (miner 4433 LiveCert)
const supplyWeth = bought('supply', 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', { total_supply: 2150135.6263283747 }, { total_supply: 'ok' }, {
  minerId: '4433', minerName: 'LiveCert — Sourced Answers for Agents', servedRank: 1, signalHash: '0x57bb4f2b73514959a9baa0e61dbf9f7399054e2f78891005910986621334e190',
  receipt: receiptOf('0x84cf18d03b10523254935b6251dd1c18f7aee9045cea7f2eedf97747d1211540', '6126'),
});

// memo B4k2AxbY, signal 0x12a3d4a9461b0d4e687dcdfe30a1e51ef2756591a28a59eb6d2e4b5e322217be (miner 9002 TxLens, served rank 3):
// TxLens's own answer was only "Insufficient data"; the node's shaping filled in the 0% and the volume signals
const washWethTxLens = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
  subject: 'WETH pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum', verdict: 'inconclusive', wash_volume_pct: 0,
  signals: ['24h volume $140.22M is 2.1x the pool\'s $67.57M liquidity', '5925 buys and 4761 sells in 24h'],
  summary: 'Insufficient data. The query references a WETH pool address, but no transaction logs, timestamps, or trade details are provided, so wash‑trading indicators cannot be evaluated.',
}, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' }, {
  minerId: '9002', minerName: 'TxLens', servedRank: 3, signalHash: '0x12a3d4a9461b0d4e687dcdfe30a1e51ef2756591a28a59eb6d2e4b5e322217be',
  receipt: receiptOf('0x1ad16bfe7dd504441ff0b775304ddc7b30917fa69ac72ea1bf210fd64615269d', '6121'),
});

// memo B4k2AxbY, signal 0xa660248967ec8cf8ff536ca6895e07c3f848699eda201cda7beba4439cfdf5ef (miner 7373 VerifyWire)
const liquidityWeth = bought('liquidity', 'LIQUIDITY_DEPTH_VERIFY_GENERAL', { liquidity_usd: 67634825.4031 }, { liquidity_usd: 'ok' }, {
  minerId: '7373', minerName: 'VerifyWire Liquidity Depth', servedRank: 1, signalHash: '0xa660248967ec8cf8ff536ca6895e07c3f848699eda201cda7beba4439cfdf5ef',
  receipt: receiptOf('0xa16fd7b39f997f0dc05606337c9089f2406304b8e8eb0d0856355bb57d246aea', '4434'),
});

// ---------- unit: "examined nothing", widened ----------

{
  const said = notExamined(secureQueryOnly.fields!.summary, secureQueryOnly.fields!.issues);
  check('"merely a token contract address query" is read as examined nothing (memo WOYbyG3x)', said !== null, String(said));
  const r = evaluate(tradeUsdc, usdcFacts, [secureQueryOnly, supplyUsdc, washUsdc, liquidityUsdc], null);
  check('the WOYbyG3x "Secure" no longer clears USDC: not_examined, no pass', r.findings.some((f) => f.rule === 'security.not_examined') && !r.findings.some((f) => f.rule === 'security.secure') && r.decision === 'REVIEW', r.findings.filter((f) => f.evidence.includes('security')).map((f) => `${f.rule}:${f.severity}`).join(','));
  check('the live WOYbyG3x wash answer (86%, "Insufficient data") is examined nothing', notExamined(wash86Live.fields!.summary) !== null);
  for (const [name, text] of [
    ['request only contains a query string', 'The request only contains a query string, so no review is possible.'],
    ['input only contains a contract address', 'The input only contains a contract address.'],
    ['nothing to assess', 'Secure. There is nothing to assess in a bare address.'],
    ['no source code to review', 'Secure. The provided target is just a contract address; there is no source code to review.'],
    ['an echoed target that is merely a lookup', `Secure. The target ${USDC} (USDC token contract) on Ethereum is merely an address lookup.`],
    ['cannot be assessed', 'The security of the contract cannot be assessed from an address alone.'],
  ] as const) check(`examined nothing: ${name}`, notExamined(text) !== null);
}

{
  // Every live scan text Shield clears on must stay readable as a scan.
  const wethGoPlus = "Wrapped Ether (WETH) at 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on Ethereum is low risk. honeypot: no; buy tax 0%, sell tax 0%; mintable: unknown; owner: none reported; top 10 holders own 58.2%, per GoPlus's contract scan.";
  const real: Array<[string, unknown]> = [
    ['GoPlus USDC summary', securityUsdc.fields!.summary],
    ['GoPlus SQUID summary', securitySquid.fields!.summary],
    ['GoPlus WETH summary', wethGoPlus],
    ['GoPlus proxy issue', securityUsdc.fields!.issues],
    ['wash scan on the USDC/WETH pool', washUsdc.fields!.summary],
    ['NVD WETH summary (B4k2AxbY)', securityWethNvd.fields!.summary],
    ...(securityWethNvd.fields!.issues as string[]).map((t, i): [string, unknown] => [`NVD WETH issue ${i + 1} (B4k2AxbY)`, t]),
    // wording of real findings that uses "only", "address", "input" or "code" about the contract
    ['"input is only checked against the zero address"', 'The input is only checked against the zero address before transferFrom.'],
    ['"only has a single owner address"', 'The contract only has a single owner address that can pause transfers.'],
    ['"only contains a transfer function ... owner address"', 'The contract only contains a transfer function that sends fees to the owner address.'],
    ['"only a question of time"', 'This is only a question of time before the owner mints more.'],
    ['"honeypot: yes ... blacklist"', 'Honeypot: yes. Sellers are blocked by a blacklist.'],
  ];
  for (const [name, text] of real) check(`real scan text is not "examined nothing": ${name}`, notExamined(text) === null, String(notExamined(text)));
  const r = evaluate(tradeWeth, wethFacts, [securityWethNvd, supplyWeth, washWethTxLens, liquidityWeth], null);
  check('B4k2AxbY replayed: the NVD review counts as a review (three issues, verdict Secure)', r.findings.filter((f) => f.rule === 'security.issue').length === 3 && r.findings.some((f) => f.rule === 'security.secure') && !r.findings.some((f) => f.rule === 'security.not_examined'));
  check('B4k2AxbY replayed: TxLens\'s "Insufficient data" wash answer is no evidence, decision REVIEW as live', r.findings.some((f) => f.rule === 'wash.not_examined') && r.decision === 'REVIEW');
}

// ---------- unit: a pass must be about this token ----------

{
  const usdc = { address: USDC, symbol: 'USDC', name: 'USD Coin' };
  check('WOYbyG3x "Secure" names no token', mentionsToken([secureQueryOnly.fields!.summary, secureQueryOnly.fields!.issues], usdc) === null);
  check('FKLfi2qT "Secure" names no token', mentionsToken(['Secure. No code, configuration, or system description was provided to evaluate, so there are no observable security weaknesses to address.'], { address: SQUID, symbol: 'SQUID', name: 'Squid Game' }) === null);
  check('the GoPlus scan names USDC by its address', /address/.test(mentionsToken([securityUsdc.fields!.summary], usdc) ?? ''));
  check('the NVD review (B4k2AxbY) names WETH as a word', /symbol "WETH"/.test(mentionsToken([securityWethNvd.fields!.summary, securityWethNvd.fields!.issues], wethFacts) ?? ''), String(mentionsToken([securityWethNvd.fields!.summary, securityWethNvd.fields!.issues], wethFacts)));
  check('"WETH9" alone is not the word WETH', mentionsToken(['The WETH9 contract is a legacy implementation.'], wethFacts) === null);
  check('the address counts in any letter case', mentionsToken([`Secure: ${USDC.toLowerCase()} is fine`], usdc) !== null);
  check('scan facts count as being about a contract', mentionsToken(['Secure. honeypot: no; buy tax 0%, sell tax 0%'], usdc) !== null);
  check('a token named after a review word is not "mentioned" by a generic answer', mentionsToken(['Secure. No further issues identified.'], { address: USDC, symbol: 'Secure', name: 'Token' }) === null);

  // The second half of the live WOYbyG3x answer, verbatim: it says nothing about examining, so only the token rule catches it.
  const generic = bought('security', 'SECURITY_REVIEW_GENERAL', {
    verdict: 'Secure', vulnerability_count: 0, issues: null,
    summary: 'Secure. There are no injection vectors, authentication, or exposure concerns present. No further issues identified.',
  }, { verdict: 'ok', vulnerability_count: 'ok', issues: 'missing', summary: 'ok' });
  check('the generic tail is not "examined nothing" (the token rule must catch it)', notExamined(generic.fields!.summary) === null);
  const r = evaluate(tradeUsdc, usdcFacts, [generic, supplyUsdc, washUsdc, liquidityUsdc], null);
  const finding = r.findings.find((f) => f.rule === 'security.not_about_token');
  check('a "Secure" that names no token is a review finding, not a pass: REVIEW', finding?.severity === 'review' && !r.findings.some((f) => f.rule === 'security.secure') && r.decision === 'REVIEW', r.findings.map((f) => `${f.rule}:${f.severity}`).join(','));
  check('the finding says what the answer failed to name', finding?.title === 'The security review does not mention this token' && finding.detail.includes(USDC) && finding.detail.includes('USDC'), finding?.detail);
  const named = evaluate(tradeUsdc, usdcFacts, [{ ...generic, fields: { ...generic.fields!, summary: 'Secure. USDC has no injection vectors, authentication, or exposure concerns. No further issues identified.' } }, supplyUsdc, washUsdc, liquidityUsdc], null);
  check('the same "Secure" naming USDC passes, and USDC clears: HOLD', named.decision === 'HOLD' && named.findings.some((f) => f.rule === 'security.secure'), named.findings.filter((f) => f.severity === 'review').map((f) => f.rule).join(','));
  const nvd = evaluate(tradeWeth, wethFacts, [securityWethNvd, supplyWeth, washWethTxLens, liquidityWeth], null);
  check('the NVD review of WETH still passes the token rule', !nvd.findings.some((f) => f.rule === 'security.not_about_token'));
}

// ---------- fixtures and unit: the live run of 2026-11-21 09:34 UTC (PREFLIGHT_LIVE=1) ----------

// signal 0x14d56f1036036120fb3ebf2ae0c09524fda726b6f3d2ac249683da7b6d8e68e5 (miner 9002 TxLens, served rank 2). TxLens's own
// answer was the verdict and the summary; the count and the three issues were added by the node's shaping.
const securityWethTxLensLive = bought('security', 'SECURITY_REVIEW_GENERAL', {
  ...securityWethNvd.fields!, vulnerability_count: 3,
  summary: 'Secure. The provided text is a standard Ethereum address for the Wrapped Ether (WETH) token contract, which is a widely recognized and audited smart contract. No executable code, configuration files, or system descriptions were supplied for review. Therefore, no vulnerabilities such as injection flaws, insecure direct object references, or cryptographic failures can be identified. The input is purely informational data.',
}, { verdict: 'ok', vulnerability_count: 'ok', issues: 'ok', summary: 'ok' }, {
  minerId: '9002', minerName: 'TxLens', servedRank: 2, signalHash: '0x14d56f1036036120fb3ebf2ae0c09524fda726b6f3d2ac249683da7b6d8e68e5',
  receipt: receiptOf('0xecdd4d25a8639ed6792541fc2efa0eff63a2c8c1de318663e2a476a2a221baa1', '6121'),
});
// signal 0xecc4810da56e82252094d56353db17241d275e2e4f6390f5eb34afaf2064d8f9 (miner 7378 VerifyWire, served rank 4). The miner
// answered wash_volume_pct null, wash_volume_status "not_measured"; the node's shaping returned 0 with status ok.
const washWethVerifyWireLive = bought('wash', 'WASH_TRADING_DETECTION_GENERAL', {
  subject: 'WETH pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum', verdict: 'inconclusive', wash_volume_pct: 0,
  signals: ['caller/recipient concentration and bidirectional swaps do not establish common beneficial ownership or artificial volume'],
  summary: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum: 104 observed Swap events across 1 ABI-compatible pools in inclusive blocks 26462504-26462623. Wash trading is inconclusive: caller/recipient concentration and bidirectional swaps do not establish common beneficial ownership or artificial volume; wash volume is not measured.',
}, { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' }, {
  minerId: '7378', minerName: 'VerifyWire Wash Trading Detection', servedRank: 4, signalHash: '0xecc4810da56e82252094d56353db17241d275e2e4f6390f5eb34afaf2064d8f9',
  receipt: receiptOf('0xcabc2419059a6945feda98c1c32a989d7c7211e75f3494604d27f92c994ae50b', '4438'),
});

{
  check('live 09:34: "No executable code, configuration files, or system descriptions were supplied for review" is examined nothing', notExamined(securityWethTxLensLive.fields!.summary) !== null, String(notExamined(securityWethTxLensLive.fields!.summary)));
  check('live 09:34: "The input is purely informational data" is examined nothing on its own', notExamined('The input is purely informational data.') !== null);
  const r = evaluate(tradeWeth, wethFacts, [securityWethTxLensLive, supplyWeth, washWethVerifyWireLive, liquidityWeth], null);
  check('live 09:34: TxLens\'s "Secure" about WETH is not a pass (it named WETH, but examined nothing)', r.findings.some((f) => f.rule === 'security.not_examined') && !r.findings.some((f) => f.rule === 'security.secure'));
  check('live 09:34: a 0% the provider says it did not measure is no evidence, not "0% of volume"', r.findings.some((f) => f.rule === 'wash.not_measured') && !r.findings.some((f) => f.rule === 'wash.ok'), r.findings.filter((f) => f.evidence.includes('wash')).map((f) => f.rule).join(','));
  check('live 09:34: WETH with those answers is REVIEW', r.decision === 'REVIEW');
  check('live 09:34: an unmeasured figure is a reason for a second opinion', noEvidence(washWethVerifyWireLive, { req: tradeWeth, facts: wethFacts, treasuryRead: null })?.rule === 'wash.not_measured');
  check('a measured 0% stays a measurement (GoPlus-style turnover, USDC/WETH pool)', notMeasured(washUsdc.fields!.summary) === null && evaluate(tradeUsdc, usdcFacts, usdcAll, null).findings.some((f) => f.rule === 'wash.ok'));
  for (const [name, text] of [
    ['"the request is only processed if"', 'The request is only processed if the caller holds the minter role.'],
    ['"the input is simply passed to an external call"', 'The input is simply passed to an external call, which allows reentrancy.'],
    ['"only used as calldata"', 'The input is only used as calldata for the router.'],
  ] as const) check(`real wording is not "examined nothing": ${name}`, notExamined(text) === null, String(notExamined(text)));
}

{
  const f = summaryFacts(securitySquid.fields!.summary as string);
  check('summary facts parsed from the provider text', f.honeypot === 'unknown' && f.buyTax === 0 && f.sellTax === 0 && f.top10 === 59.1, JSON.stringify(f));
  check('summary facts absent when the provider words it otherwise', summaryFacts('Looks fine.').honeypot === null);
}

// ---------- unit: the node's ranking and the pinned ask (telegraph.ts) ----------

const WASH = 'WASH_TRADING_DETECTION_GENERAL';
// GET /leaderboard/miners/epoch/29 -> intents.WASH_TRADING_DETECTION_GENERAL, first rows as read on 2026-11-21
const washRows29: LeaderboardRow[] = [
  { miner_slug: 'wash-dex-search', score: 0.8836, rank: 1, activation_status: 'active' },
  { miner_slug: 'chainsight-oracle', score: 0.4967, rank: 2, activation_status: 'active' },
  { miner_slug: 'txlens', score: 0, rank: 3, activation_status: 'active' },
  { miner_slug: 'a1-preflight', score: 0, rank: 4, activation_status: 'active' },
];
// GET /api/miners?intent=WASH_TRADING_DETECTION_GENERAL, the fields a pinned ask needs
const washCatalog: CatalogMinerEntry[] = [
  { id: '9002', slug: 'txlens', name: 'TxLens', activation_status: 'active', supported_intents: ['ONCHAIN_TX_LOOKUP_GENERAL', WASH], min_price_usdc: 10000 },
  { id: '80002', slug: 'wash-dex-search', name: 'DexScreener Search', activation_status: 'active', supported_intents: [WASH], min_price_usdc: 10000 },
  { id: '302', slug: 'chainsight-oracle', name: 'ChainSight — Universal Intelligence & Data Oracle', activation_status: 'active', supported_intents: [WASH], min_price_usdc: 10000 },
  { id: '20260828', slug: 'a1-preflight', name: 'PREFLIGHT Infrastructure Signals', activation_status: 'active', supported_intents: [WASH], min_price_usdc: 10000 },
];

{
  const ranked = rankMiners(WASH, [...washRows29].reverse(), washCatalog);
  check('ranking: leaderboard slugs joined to catalog ids, best rank first', ranked.map((m) => `${m.rank}:${m.minerId}`).join(',') === '1:80002,2:302,3:9002,4:20260828', ranked.map((m) => `${m.rank}:${m.minerId}`).join(','));
  check('ranking: the price per call comes from the catalog (10000 micro-USDC = $0.01)', ranked.every((m) => m.priceUsd === 0.01));
  const dropped = rankMiners(WASH, [...washRows29, { miner_slug: 'gone-miner', score: 1, rank: 0 }], [
    { ...washCatalog[1]!, supported_intents: ['SOMETHING_ELSE'] },
    { ...washCatalog[2]!, min_price_usdc: undefined },
    { ...washCatalog[3]!, activation_status: 'inactive' },
    washCatalog[0]!,
  ]);
  check('ranking: a ranked slug the catalog lacks, or that no longer serves the intent, has no price or is inactive, is left out', dropped.map((m) => m.minerId).join(',') === '9002', dropped.map((m) => m.minerId).join(','));

  const boardsSeen: Array<number | null> = [];
  const board = (have: Record<number, Record<string, LeaderboardRow[]> | null>) => async (epoch: number | null): Promise<Leaderboard | null> => {
    boardsSeen.push(epoch);
    const n = epoch ?? 30;
    const intents = have[n];
    return intents === undefined || intents === null ? null : { epoch: n, intents };
  };
  const found = await latestRanked(WASH, board({ 30: { SECURITY_REVIEW_GENERAL: [] }, 29: { [WASH]: washRows29 } }), 5);
  check('ranking: the latest epoch without the intent is skipped for the one before (30 -> 29, as live)', found.epoch === 29 && found.rows.length === 4 && found.searched.join(',') === '30,29');
  const none = await latestRanked('LIQUIDITY_DEPTH_VERIFY_GENERAL', board({ 30: {}, 29: {}, 28: null }), 5);
  check('ranking: the search stops at an epoch the node does not have (404)', none.epoch === null && none.searched.join(',') === '30,29');
  boardsSeen.length = 0;
  const capped = await latestRanked('LIQUIDITY_DEPTH_VERIFY_GENERAL', board({ 30: {}, 29: {}, 28: {}, 27: {}, 26: {} }), 2);
  check('ranking: the search goes back at most the epochs allowed', capped.epoch === null && capped.searched.join(',') === '30,29,28' && boardsSeen.length === 3);

  const gatewayPage = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head>\n<title>backend.telegraphprotocol.com | 504: Gateway time-out</title>\n</head><body>...</body></html>';
  check('a gateway\'s HTML error page is named by its title, not quoted', errorBodyText(gatewayPage) === 'an HTML error page, "backend.telegraphprotocol.com | 504: Gateway time-out"' && errorBodyText('<html><body>x</body></html>') === 'an HTML error page', errorBodyText(gatewayPage));
  check('a JSON error body is kept as text', errorBodyText({ error: 'invalid_params' }) === '{"error":"invalid_params"}');

  const saved = process.env.TELEGRAPH_API_KEY;
  delete process.env.TELEGRAPH_API_KEY;
  const pinned = await askPinnedIntent('80002', WASH, { subject: 'x' });
  check('pinned ask without an API key: no answer, refused, nothing thrown', !pinned.ok && pinned.refused === true && /TELEGRAPH_API_KEY/.test(pinned.error ?? ''));
  if (saved !== undefined) process.env.TELEGRAPH_API_KEY = saved;
}

// ---------- unit: second opinions (stubbed ranking and pinned answers) ----------

const washParams = { subject: 'WETH pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum' };
// The one paid pinned call, 2026-11-21 09:11 UTC: POST /engine/ask/80002, as replied (DexScreener's 30 pairs cut to one)
const pinnedReply80002 = {
  result: {
    miner_id: '80002', miner_name: 'DexScreener Search', endpoint: '/query',
    result: { pairs: [{ chainId: 'ethereum', dexId: 'uniswap', pairAddress: '0x6ceA05f7cb348D48A0BDf86889040f6a5Bae98dd', baseToken: { symbol: 'CRYPTO' }, quoteToken: { symbol: 'WETH' }, volume: { h24: 62.57 }, liquidity: { usd: 19219.09 } }], schemaVersion: '1.0.0' },
    result_shape: 'raw', shape_error: 'answer_unreadable', format_version: 3, input: washParams, input_schema_version: 3,
    cost_usd: 0.01, duration_ms: 225, timestamp: '2026-11-21T09:11:26.498911231Z',
    reasoning: 'Intent: miner wash-dex-search given by the caller\nMiner: The user is asking a question related to wash trading detection, and the DexScreener Search miner has an endpoint that specifically serves the WASH_TRADING_DETECTION intent. The question is directly mapped to the \'q\' query parameter as required by the miner\'s configuration for this intent.',
    intent: WASH, intent_version: 1, signal_hash: '0xd10e5d14f5fe5bece5048acc90f6dba3b206ba1ddad8d46ce19115efe250cbe7',
  },
  receipt: { receipt_hash: '0x04a70698cc964f0a535fc2fef2370c2a6ba664076a3f4081368be9a1673e668b', rail: 'escrow', payer: '0x29476125898638c8634a97fdca8994530e8c9055', miner: '4279', intent: WASH, amount_uusdc: '10000', epoch_id: 30, settlement: 'epoch', chain: 'telegraph', timestamp: 1795252286 },
};
const typed = (p: Purchase, params: Record<string, unknown>): TypedAnswer => {
  const out: TypedAnswer = { intent: p.intent, params, ok: p.ok, fields: p.fields, fieldStatus: p.fieldStatus, costUsd: p.costUsd, latencyMs: p.latencyMs };
  for (const k of ['minerId', 'minerName', 'signalHash', 'receipt', 'servedRank', 'error'] as const) if (p[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = p[k];
  return out;
};
// A stub for a pinned answer that did examine the pool (not a live answer)
const washExaminedStub: TypedAnswer = {
  intent: WASH, params: washParams, ok: true, minerId: '80002', minerName: 'DexScreener Search', costUsd: 0.01, latencyMs: 4_000, signalHash: `0x${'5'.repeat(64)}`,
  fields: { subject: washParams.subject, verdict: 'organic', wash_volume_pct: 2, signals: ['24h volume $140.13M is 2.1x the pool\'s $67.88M liquidity'], summary: 'The WETH/USDC pool trades 2.1x its liquidity a day, inside a normal turnover; 2% of volume is in excess.' },
  fieldStatus: { subject: 'ok', verdict: 'ok', wash_volume_pct: 'ok', signals: 'ok', summary: 'ok' },
  receipt: { hash: `0x${'6'.repeat(64)}`, rail: 'escrow', payer: '0x29476125898638c8634a97fdca8994530e8c9055', miner: '4279', amountUsd: 0.01, epochId: 30, settlement: 'epoch' },
};
const washRanking: IntentRanking = { intent: WASH, epoch: 29, miners: rankMiners(WASH, washRows29, washCatalog) };
const securityRanking: IntentRanking = {
  intent: 'SECURITY_REVIEW_GENERAL', epoch: 30, miners: [
    { minerId: '302', slug: 'chainsight-oracle', name: 'ChainSight — Universal Intelligence & Data Oracle', rank: 1, score: 0.9991, priceUsd: 0.01 },
    { minerId: '9002', slug: 'txlens', name: 'TxLens', rank: 2, score: 0.9979, priceUsd: 0.01 },
  ],
};
function stubDeps(ranking: IntentRanking | Error, pinned: TypedAnswer | ((minerId: string) => TypedAnswer)) {
  const calls = { ranking: 0, pinned: [] as string[] };
  const deps: OpinionDeps = {
    ranking: async () => { calls.ranking++; if (ranking instanceof Error) throw ranking; return ranking; },
    askPinned: async (minerId) => { calls.pinned.push(minerId); return typeof pinned === 'function' ? pinned(minerId) : pinned; },
  };
  return { deps, calls };
}
const wethCtx = (budget = 0.1, committed = 0.04) => ({ req: tradeWeth, facts: wethFacts, treasuryRead: null, spend: new Spend(budget, committed) });
const wethGoPlusScan = bought('security', 'SECURITY_REVIEW_GENERAL', {
  verdict: null, vulnerability_count: null, issues: [],
  summary: "Wrapped Ether (WETH) at 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on Ethereum is low risk. honeypot: no; buy tax 0%, sell tax 0%; mintable: unknown; owner: none reported; top 10 holders own 58.2%, per GoPlus's contract scan.",
}, { verdict: 'rejected', vulnerability_count: 'missing', issues: 'ok', summary: 'ok' }, { minerId: '20260828', signalHash: '0x0908884b720c7c6aab9fe4f6c0c5ae36f6881adc7c2ba222f599963775d4b4f5' });

{
  const raw = typedAnswerFrom(WASH, washParams, { body: pinnedReply80002.result, receipt: pinnedReply80002.receipt, latencyMs: 4851 });
  check('the recorded pinned reply parses: catalog id 80002, receipt to registration 4279, $0.01 billed', raw.minerId === '80002' && raw.receipt?.miner === '4279' && raw.receipt.hash.startsWith('0x04a70698') && raw.costUsd === 0.01 && raw.signalHash?.startsWith('0xd10e5d14') === true);
  check('...and a raw answer is no answer, saying why', !raw.ok && raw.fields === null && /result_shape raw, shape_error answer_unreadable/.test(raw.error ?? ''), raw.error);
  check('...and is not marked refused (a second opinion may still be taken for it)', raw.refused === undefined);

  // TxLens's live "Insufficient data" (B4k2AxbY), then a pinned answer that examined the pool
  const { deps, calls } = stubDeps(washRanking, washExaminedStub);
  const ctx = wethCtx();
  const used = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), ctx, deps);
  const so = used.secondOpinion;
  check('second opinion: "Insufficient data" asks once more, pinned to the next-best miner (80002, rank 1 in epoch 29)', calls.pinned.join(',') === '80002' && so?.miner?.id === '80002' && so.miner.rank === 1 && so.miner.epoch === 29, calls.pinned.join(','));
  check('second opinion: the miner that answered (9002) is never the one asked', !calls.pinned.includes('9002'));
  check('second opinion: why it was asked is recorded (the first answer\'s finding)', so?.reasonRule === 'wash.not_examined' && /Insufficient data/.test(so.reason));
  check('second opinion: an answer that examined the trades is used', so?.used === true && used.minerId === '80002' && used.fields?.wash_volume_pct === 2 && /^used/.test(so.outcome), so?.outcome);
  check('second opinion: both answers keep their signal hashes and receipts', so !== undefined && so.first.signalHash === washWethTxLens.signalHash && so.first.receipt?.hash === washWethTxLens.receipt?.hash && so.second?.signalHash === washExaminedStub.signalHash && so.second?.receipt?.hash === washExaminedStub.receipt?.hash);
  check('second opinion: its cost is counted ($0.01 + $0.01) and the time of both asks', used.costUsd === 0.02 && used.latencyMs === washWethTxLens.latencyMs + 4_000 && Math.abs(ctx.spend.committedUsd - 0.05) < 1e-9, `${used.costUsd} ${used.latencyMs} ${ctx.spend.committedUsd}`);
  check('second opinion: the pinned answer has no served rank (nothing was routed)', used.servedRank === undefined);
  const p: Purchase = { ...used, reused: false, boughtAt: '2026-11-21T09:20:00.000Z' };
  const r = evaluate(tradeWeth, wethFacts, [wethGoPlusScan, supplyWeth, p, liquidityWeth], null);
  check('second opinion used: WETH can clear on the pinned answer: HOLD', r.decision === 'HOLD' && r.findings.some((f) => f.rule === 'wash.ok'), r.findings.filter((f) => f.severity === 'review').map((f) => f.rule).join(','));
  const info = r.findings.find((f) => f.rule === 'wash.second_opinion');
  check('second opinion used: an info finding names both miners and both signal hashes', info?.severity === 'info' && info.detail.includes('9002') && info.detail.includes('80002') && info.detail.includes(washWethTxLens.signalHash!) && info.detail.includes(washExaminedStub.signalHash!), info?.detail);
  const cost = memoCost([wethGoPlusScan, supplyWeth, p, liquidityWeth]);
  check('memo cost: both wash asks are paid requests, one second opinion', cost.paidRequests === 5 && cost.failedRequests === 0 && cost.secondOpinions === 1 && cost.telegraphUsd === 0.05, JSON.stringify(cost));
  check('memo cost: a reused fact counts no ask and costs $0', memoCost([{ ...p, reused: true, costUsd: 0 }]).paidRequests === 0 && memoCost([{ ...p, reused: true, costUsd: 0 }]).reusedRequests === 1);
}

{
  // The live pinned answer, raw: no evidence either. The first answer stays; both were billed.
  const raw = typedAnswerFrom(WASH, washParams, { body: pinnedReply80002.result, receipt: pinnedReply80002.receipt, latencyMs: 4851 });
  const { deps, calls } = stubDeps(washRanking, raw);
  const kept = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), wethCtx(), deps);
  check('second opinion not usable (the live raw reply): not used, the first answer stays', kept.secondOpinion?.used === false && kept.minerId === '9002' && kept.signalHash === washWethTxLens.signalHash && calls.pinned.length === 1, kept.secondOpinion?.outcome);
  check('...the outcome says why, and both asks are billed', /not used/.test(kept.secondOpinion?.outcome ?? '') && /shape_error answer_unreadable/.test(kept.secondOpinion?.outcome ?? '') && kept.costUsd === 0.02);
  const p: Purchase = { ...kept, reused: false, boughtAt: '2026-11-21T09:20:00.000Z' };
  const r = evaluate(tradeWeth, wethFacts, [wethGoPlusScan, supplyWeth, p, liquidityWeth], null);
  check('...so WETH stays in REVIEW on "Insufficient data"', r.decision === 'REVIEW' && r.findings.some((f) => f.rule === 'wash.not_examined') && r.findings.some((f) => f.rule === 'wash.second_opinion'));
  const cost = memoCost([p]);
  check('...memo cost: one paid, one failed ask, one second opinion, $0.02', cost.paidRequests === 1 && cost.failedRequests === 1 && cost.secondOpinions === 1 && cost.telegraphUsd === 0.02, JSON.stringify(cost));
}

{
  // Never more than one extra answer: the pinned answer also examined nothing.
  const { deps, calls } = stubDeps(washRanking, (id) => ({ ...typed(washWethTxLens, washParams), minerId: id, signalHash: `0x${'7'.repeat(64)}` }));
  const r = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), wethCtx(), deps);
  check('at most one extra answer per fact, even when it also examined nothing', calls.pinned.length === 1 && r.secondOpinion?.used === false && r.minerId === '9002');

  // The first answer came from the top-ranked miner: the next one down is asked.
  const fromTop = { ...typed(washWethTxLens, washParams), minerId: '80002' };
  const top = stubDeps(washRanking, washExaminedStub);
  await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, fromTop, wethCtx(), top.deps);
  check('the next-best is the best-ranked miner other than the one that answered (80002 answered: 302)', top.calls.pinned.join(',') === '302');

  // Miners whose answers scored 0 are no better opinion.
  const zero = stubDeps({ ...washRanking, miners: washRanking.miners.map((m) => (m.minerId === '9002' ? m : { ...m, score: 0 })) }, washExaminedStub);
  const z = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), wethCtx(), zero.deps);
  check('no miner with a score above 0 besides the one that answered: none asked, and the memo says so', zero.calls.pinned.length === 0 && z.secondOpinion?.miner === null && /scored above 0/.test(z.secondOpinion?.outcome ?? ''), z.secondOpinion?.outcome);

  // Within the decision's budget only.
  const broke = stubDeps(washRanking, washExaminedStub);
  const b = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), wethCtx(0.04, 0.04), broke.deps);
  check('over budget: not asked, nothing spent, the memo says so', broke.calls.pinned.length === 0 && b.costUsd === washWethTxLens.costUsd && b.secondOpinion?.second === null && /budget/.test(b.secondOpinion?.outcome ?? ''), b.secondOpinion?.outcome);

  // No ranking for the intent (LIQUIDITY_DEPTH_VERIFY_GENERAL in epochs 26-30), or the leaderboard unreachable.
  const liquidityFailed = failed('liquidity', 'LIQUIDITY_DEPTH_VERIFY_GENERAL', 'miner step failed: timeout');
  const none = stubDeps({ intent: 'LIQUIDITY_DEPTH_VERIFY_GENERAL', epoch: null, miners: [], error: 'the leaderboard ranks no miner for LIQUIDITY_DEPTH_VERIFY_GENERAL in epochs 30, 29, 28, 27, 26' }, washExaminedStub);
  const n = await withSecondOpinion({ key: 'liquidity', intent: 'LIQUIDITY_DEPTH_VERIFY_GENERAL', params: { pool: USDC_WETH_POOL, chain: 'ethereum' } }, typed(liquidityFailed, {}), wethCtx(), none.deps);
  check('no ranking for the intent: not asked, and the memo says why', none.calls.pinned.length === 0 && n.secondOpinion?.reasonRule === 'liquidity.unavailable' && /ranks no miner/.test(n.secondOpinion?.outcome ?? ''));
  const down = stubDeps(new Error('fetch failed'), washExaminedStub);
  const d = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(washWethTxLens, washParams), wethCtx(), down.deps);
  check('an unreachable leaderboard is no second opinion, not a crash', down.calls.pinned.length === 0 && /could not read the ranking: fetch failed/.test(d.secondOpinion?.outcome ?? ''));
}

{
  // When to take none at all.
  const refusedAsk: TypedAnswer = { intent: WASH, params: washParams, ok: false, fields: null, fieldStatus: {}, latencyMs: 300, error: 'http 400: {"error":"invalid_params"}', refused: true };
  const refused = stubDeps(washRanking, washExaminedStub);
  const r1 = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, refusedAsk, wethCtx(), refused.deps);
  check('a refused request (4xx, no key) takes no second opinion: another miner would be refused the same way', r1.secondOpinion === undefined && refused.calls.ranking === 0);
  const evidence = stubDeps(securityRanking, washExaminedStub);
  const r2 = await withSecondOpinion({ key: 'security', intent: 'SECURITY_REVIEW_GENERAL', params: {} }, typed(wethGoPlusScan, {}), wethCtx(), evidence.deps);
  check('an answer that is evidence takes no second opinion (and the ranking is not even read)', r2.secondOpinion === undefined && evidence.calls.ranking === 0);
  const honeypot = bought('security', 'SECURITY_REVIEW_GENERAL', { verdict: null, vulnerability_count: null, issues: [], summary: 'honeypot: yes' }, { verdict: 'rejected' });
  check('an answer that blocks in its own right is evidence, even with no verdict: it is never set aside', noEvidence(honeypot, wethCtx()) === null);
  const blockedTimeout = stubDeps(washRanking, washExaminedStub);
  const timedOut = failed('wash', WASH, 'miner step failed: timeout');
  const r3 = await withSecondOpinion({ key: 'wash', intent: WASH, params: washParams }, typed(timedOut, washParams), wethCtx(), blockedTimeout.deps);
  check('a check that did not answer (timeout) takes a second opinion, and uses it', blockedTimeout.calls.pinned.join(',') === '80002' && r3.ok && r3.secondOpinion?.used === true && r3.secondOpinion.reasonRule === 'wash.unavailable');
  const cost = memoCost([{ ...r3, reused: false, boughtAt: '' }]);
  check('...memo cost counts the failed ask and the paid one', cost.failedRequests === 1 && cost.paidRequests === 1 && cost.secondOpinions === 1);
}

{
  // Security: the WOYbyG3x "Secure" from TxLens, then a pinned review that names the token.
  const usdcCtx = { req: tradeUsdc, facts: usdcFacts, treasuryRead: null, spend: new Spend(0.1, 0.04) };
  const named: TypedAnswer = {
    intent: 'SECURITY_REVIEW_GENERAL', params: {}, ok: true, minerId: '302', minerName: 'ChainSight — Universal Intelligence & Data Oracle', costUsd: 0.01, latencyMs: 9_000, signalHash: `0x${'8'.repeat(64)}`,
    fields: { verdict: 'Secure', vulnerability_count: 0, issues: [], summary: 'Secure. USDC is a FiatToken proxy run by Circle; no exploitable weakness is reported for it.' },
    fieldStatus: { verdict: 'ok', vulnerability_count: 'ok', issues: 'ok', summary: 'ok' },
  };
  const { deps, calls } = stubDeps(securityRanking, named);
  const r = await withSecondOpinion({ key: 'security', intent: 'SECURITY_REVIEW_GENERAL', params: {} }, typed(secureQueryOnly, {}), usdcCtx, deps);
  check('security: a "Secure" that examined nothing gets a second opinion from the top other reviewer (302)', calls.pinned.join(',') === '302' && r.secondOpinion?.reasonRule === 'security.not_examined');
  check('security: the pinned review names USDC, so it is used', r.secondOpinion?.used === true && r.fields?.summary === named.fields!.summary);
  const generic = stubDeps(securityRanking, { ...named, fields: { ...named.fields!, summary: 'Secure. There are no injection vectors, authentication, or exposure concerns present. No further issues identified.' } });
  const g = await withSecondOpinion({ key: 'security', intent: 'SECURITY_REVIEW_GENERAL', params: {} }, typed(secureQueryOnly, {}), usdcCtx, generic.deps);
  check('security: a pinned "Secure" that names no token is not used either', g.secondOpinion?.used === false && /does not mention this token/.test(g.secondOpinion?.outcome ?? ''), g.secondOpinion?.outcome);
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
  const show = (memo: Awaited<ReturnType<typeof runPreflight>>) => {
    for (const p of memo.purchases) {
      console.log(`  ${p.key.padEnd(9)} ${p.ok ? 'ok ' : 'ERR'} ${p.minerId ?? '-'} ${p.minerName ?? ''}${p.servedRank ? ` (rank ${p.servedRank})` : ''} $${p.costUsd} ${p.signalHash ?? p.error ?? ''}${p.receipt ? ` receipt ${p.receipt.hash} -> registration ${p.receipt.miner}` : ''}`);
      const so = p.secondOpinion;
      if (!so) continue;
      console.log(`      first:  ${so.first.minerId ?? '-'} ${so.first.minerName ?? ''} $${so.first.costUsd} ${so.first.signalHash ?? so.first.error ?? ''}${so.first.receipt ? ` receipt ${so.first.receipt.hash}` : ''}`);
      console.log(`      why:    [${so.reasonRule}] ${so.reason}`);
      console.log(`      pinned: ${so.miner ? `${so.miner.id} ${so.miner.slug} rank ${so.miner.rank} score ${so.miner.score} epoch ${so.miner.epoch} $${so.miner.priceUsd}` : '-'}`);
      if (so.second) console.log(`      second: ${so.second.ok ? 'ok ' : 'ERR'} ${so.second.minerId ?? '-'} $${so.second.costUsd} ${so.second.signalHash ?? ''}${so.second.receipt ? ` receipt ${so.second.receipt.hash} -> registration ${so.second.receipt.miner}` : ''}${so.second.ok ? ` fields ${JSON.stringify(so.second.fields).slice(0, 400)}` : ` ${so.second.error ?? ''}`}`);
      console.log(`      ${so.outcome}`);
    }
    for (const f of memo.findings) console.log(`  [${f.severity}] ${f.rule}: ${f.title}`);
  };
  const opinionsBounded = (memo: Awaited<ReturnType<typeof runPreflight>>) => memo.purchases.every((p) => !p.secondOpinion || p.secondOpinion.miner === null || (p.secondOpinion.miner.id !== p.secondOpinion.first.minerId));

  const legit = await runPreflight(normalizePreflightRequest(legitInput));
  console.log(`WETH trade: ${legit.decision} (${legit.decisionRule}); $${legit.cost.telegraphUsd} over ${legit.cost.paidRequests} paid, ${legit.cost.reusedRequests} reused, ${legit.cost.failedRequests} failed, ${legit.cost.secondOpinions} second opinion(s); ${legit.latencyMs} ms`);
  show(legit);
  check('live: a second opinion is never pinned to the miner that answered first', opinionsBounded(legit));
  check('live: the trade preflight stays within its budget', legit.cost.telegraphUsd <= legit.cost.budgetUsd + 1e-9, `$${legit.cost.telegraphUsd}`);
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
  console.log(`Garantex listing: ${sanctioned.decision}; $${sanctioned.cost.telegraphUsd} over ${sanctioned.cost.paidRequests} paid, ${sanctioned.cost.failedRequests} failed, ${sanctioned.cost.secondOpinions} second opinion(s); ${sanctioned.latencyMs} ms`);
  show(sanctioned);
  check('live: listing second opinions are never pinned to the miner that answered first', opinionsBounded(sanctioned));
  check('live: the listing stays within its budget', sanctioned.cost.telegraphUsd <= sanctioned.cost.budgetUsd + 1e-9, `$${sanctioned.cost.telegraphUsd}`);
  check('live: sanctioned issuer listing is REJECT', sanctioned.decision === 'REJECT' && sanctioned.findings.some((f) => f.rule === 'sanctions.match'),
    sanctioned.findings.filter((f) => f.evidence.includes('sanctions')).map((f) => `${f.rule}: ${f.detail}`).join('; '));
  // Keep the run's memos, to read them afterwards without buying anything again.
  if (process.env.PREFLIGHT_LIVE_OUT) writeFileSync(process.env.PREFLIGHT_LIVE_OUT, JSON.stringify({ legit, again, eoa, sanctioned }, null, 2));
}

console.log(failures === 0 ? '\nall preflight tests passed' : `\n${failures} preflight test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
