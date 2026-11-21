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
  notExamined,
  summaryFacts,
  type Purchase,
  type PreflightRequest,
} from '../shield/preflight.js';
import { canonicalJson, memoDigest, signMemo, verifyMemo } from '../shield/memo.js';
import type { PaymentReceipt } from '../shield/telegraph.js';
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
