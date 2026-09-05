/**
 * Truvian Shield verdict engine.
 *
 * Pure and deterministic: (caller request, live Telegraph signals) -> CheckReport.
 * No I/O, no clock reads — identical inputs always produce an identical report.
 *
 * Miner answers arrive as natural-language TEXT (that is what Telegraph
 * validators score, and what live miners actually return), so every parser
 * here is defensive: regexes for numbers and keywords, and an unparseable
 * answer degrades to a 'warn' with a stated reason — never a crash.
 */
import type {
  CheckItem,
  CheckReport,
  CheckRequest,
  CheckStatus,
  IntentResult,
  ShieldIntent,
  ShieldTransport,
  ShieldVerdict,
} from './types.js';

// ---------- signal plumbing ----------

/** Outcome of one askIntent() call; ok:false carries what the server observed. */
export type SignalOutcome =
  | { ok: true; result: IntentResult }
  | { ok: false; reason: string; transport: ShieldTransport; latencyMs: number };

/** The four Telegraph signals a check run can draw on; undefined = not collected. */
export interface SignalSet {
  /** GAS_PRICE for the request chain */
  gas: SignalOutcome | undefined;
  /** ONCHAIN_TX_LOOKUP for request.txHash */
  tx: SignalOutcome | undefined;
  /** CRYPTO_PRICE for ETH/USD */
  price: SignalOutcome | undefined;
  /** TVL_LOOKUP for request.protocol */
  tvl: SignalOutcome | undefined;
}

export class ShieldInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShieldInputError';
  }
}

// ---------- thresholds (exported so tests and UI copy stay in sync) ----------

export const VALUE_WARN_USD = 10_000;
export const VALUE_FAIL_USD = 100_000;
export const MIN_TVL_USD = 1_000_000;

/**
 * Typical quiet-hours gas floor per chain, in gwei. The FEE check warns when
 * the live gas price exceeds 10x this floor even if the miner did not label
 * the fee level 'high'.
 */
export const TYPICAL_GAS_FLOOR_GWEI: Record<string, number> = {
  base: 0.01,
  'base-sepolia': 0.001,
  ethereum: 1,
  xlayer: 0.02,
};
const DEFAULT_GAS_FLOOR_GWEI = 0.01;

/** Points subtracted from 100 per check status. */
const PENALTY: Record<CheckStatus, number> = { pass: 0, warn: 15, fail: 35, error: 10 };

// ---------- defensive text parsers (exported for tests) ----------

const NUM_RE = '([\\d][\\d,]*(?:\\.\\d+)?)';

function toNumber(s: string): number | null {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** First "<number> gwei" figure in an answer, or null. */
export function parseFirstGwei(text: string): number | null {
  const m = new RegExp(`${NUM_RE}\\s*gwei`, 'i').exec(text);
  return m?.[1] !== undefined ? toNumber(m[1]) : null;
}

const SUFFIX_MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
};
const SUFFIX_RE = '(k|thousand|mm?|million|bn?|billion|t|trillion)?';

/**
 * First USD amount in an answer — "$4,215.34", "$4.12 billion", "412,000 USD",
 * "4.12 billion dollars" — scaled by any magnitude suffix. Null if none found.
 */
export function parseUsdAmount(text: string): number | null {
  const m =
    new RegExp(`\\$\\s*${NUM_RE}\\s*${SUFFIX_RE}\\b`, 'i').exec(text) ??
    new RegExp(`${NUM_RE}\\s*${SUFFIX_RE}\\s*(?:usd|dollars)\\b`, 'i').exec(text);
  if (m?.[1] === undefined) return null;
  const base = toNumber(m[1]);
  if (base === null) return null;
  const mult = m[2] !== undefined ? SUFFIX_MULT[m[2].toLowerCase()] ?? 1 : 1;
  return base * mult;
}

/** Fee level stated in a GAS_PRICE answer, or null when unstated. */
export function parseFeeLevel(text: string): 'low' | 'normal' | 'high' | null {
  if (/\b(?:very\s+)?high\b[^.]{0,80}\b(?:fees?|gas|congestion)\b|\b(?:fees?|gas|congestion)\b[^.]{0,60}\bhigh\b/i.test(text)) return 'high';
  if (/\blow\b[^.]{0,80}\b(?:fees?|gas|congestion)\b|\b(?:fees?|gas|congestion)\b[^.]{0,60}\blow\b/i.test(text)) return 'low';
  if (/\b(?:normal|moderate|average|medium|standard)\b[^.]{0,80}\b(?:fees?|gas|congestion)\b/i.test(text)) return 'normal';
  return null;
}

/** Transaction outcome stated in an ONCHAIN_TX_LOOKUP answer, or null. */
export function parseTxStatus(text: string): 'success' | 'reverted' | 'not_found' | null {
  if (/\brevert(?:ed)?\b|\bfail(?:ed|ure)\b|\bstatus\b[^.]{0,20}\b(?:0x0\b|fail)/i.test(text)) return 'reverted';
  if (/\bnot\s+found\b|\bno\s+matching\s+transaction\b|\bdoes\s+not\s+exist\b|\bnever\s+(?:been\s+)?mined\b|\bunknown\s+transaction\b/i.test(text)) return 'not_found';
  if (/\bsucceed(?:ed)?\b|\bsuccess(?:ful(?:ly)?)?\b|\bconfirmed\b|\bwas\s+mined\b/i.test(text)) return 'success';
  return null;
}

/** Deterministic "$1,234.56" formatting (no locale dependence). */
function fmtUsd(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return `$${int!.replace(/\B(?=(\d{3})+$)/g, ',')}.${dec}`;
}

// ---------- request normalization ----------

/** Validate and normalize a raw POST /api/check body. Throws ShieldInputError. */
export function normalizeCheckRequest(raw: unknown): CheckRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ShieldInputError('request body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
    return undefined;
  };

  const out: CheckRequest = {};
  const chain = str(body.chain ?? body.network);
  if (chain !== undefined) out.chain = chain.toLowerCase();

  const to = str(body.to);
  if (to !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new ShieldInputError('to must be a 20-byte 0x-hex address');
    out.to = to;
  }

  if (body.valueEth !== undefined && body.valueEth !== null && body.valueEth !== '') {
    const n = typeof body.valueEth === 'number' ? body.valueEth : Number(String(body.valueEth).trim());
    if (!Number.isFinite(n) || n < 0) throw new ShieldInputError('valueEth must be a non-negative number');
    out.valueEth = n;
  }

  const txHash = str(body.txHash ?? body.tx_hash ?? body.hash);
  if (txHash !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ShieldInputError('txHash must be a 32-byte 0x-hex string');
    out.txHash = txHash.toLowerCase();
  }

  const protocol = str(body.protocol);
  if (protocol !== undefined) out.protocol = protocol;
  return out;
}

// ---------- check item construction ----------

function itemFromResult(
  name: string,
  intent: ShieldIntent,
  status: CheckStatus,
  summary: string,
  r: IntentResult,
): CheckItem {
  return {
    name,
    intent,
    status,
    summary,
    answer: r.answer,
    latencyMs: r.latencyMs,
    transport: r.transport,
    ...(r.signalHash !== undefined ? { signalHash: r.signalHash } : {}),
    ...(r.minerName !== undefined ? { minerName: r.minerName } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
  };
}

function itemFromFailure(
  name: string,
  intent: ShieldIntent,
  status: CheckStatus,
  summary: string,
  outcome: SignalOutcome | undefined,
): CheckItem {
  const failed = outcome !== undefined && !outcome.ok ? outcome : null;
  return {
    name,
    intent,
    status,
    summary,
    answer: '',
    latencyMs: failed ? failed.latencyMs : 0,
    transport: failed ? failed.transport : 'direct',
  };
}

// ---------- individual checks ----------

function evaluateFee(request: CheckRequest, outcome: SignalOutcome | undefined): CheckItem | null {
  const name = 'FEE';
  const intent: ShieldIntent = 'GAS_PRICE';
  if (outcome === undefined) return null; // gas signal never collected — no check row
  if (!outcome.ok) return itemFromFailure(name, intent, 'error', `Telegraph GAS_PRICE query failed: ${outcome.reason}`, outcome);

  const r = outcome.result;
  const chain = request.chain ?? 'base';
  const level = parseFeeLevel(r.answer);
  const gwei = parseFirstGwei(r.answer);
  const floor = TYPICAL_GAS_FLOOR_GWEI[chain] ?? DEFAULT_GAS_FLOOR_GWEI;

  if (level === 'high') {
    return itemFromResult(name, intent, 'warn',
      `miner reports a high fee level${gwei !== null ? ` (${gwei} gwei)` : ''} — consider waiting for fees to settle`, r);
  }
  if (gwei !== null && gwei > floor * 10) {
    return itemFromResult(name, intent, 'warn',
      `gas price ${gwei} gwei is more than 10x the typical ${chain} floor of ${floor} gwei`, r);
  }
  if (level === null && gwei === null) {
    return itemFromResult(name, intent, 'warn', 'could not parse a gas price or fee level from the miner answer', r);
  }
  return itemFromResult(name, intent, 'pass',
    `gas price ${gwei !== null ? `${gwei} gwei` : 'unstated'} is within the normal range for ${chain} (${level ?? 'level unstated'})`, r);
}

function evaluateCounterparty(request: CheckRequest, outcome: SignalOutcome | undefined): CheckItem | null {
  const name = 'COUNTERPARTY';
  const intent: ShieldIntent = 'ONCHAIN_TX_LOOKUP';
  if (outcome === undefined) {
    if (request.txHash === undefined) return null; // no referenced tx — check not applicable
    return itemFromFailure(name, intent, 'error', 'no ONCHAIN_TX_LOOKUP signal was collected for the referenced transaction', outcome);
  }
  if (!outcome.ok) return itemFromFailure(name, intent, 'error', `Telegraph ONCHAIN_TX_LOOKUP query failed: ${outcome.reason}`, outcome);

  const r = outcome.result;
  const status = parseTxStatus(r.answer);
  if (status === 'reverted') {
    return itemFromResult(name, intent, 'fail', 'the referenced transaction REVERTED on-chain — the counterparty evidence indicates failure', r);
  }
  if (status === 'not_found') {
    return itemFromResult(name, intent, 'warn', 'the referenced transaction was not found on-chain — no usable evidence for this counterparty', r);
  }
  if (status === 'success') {
    if (request.to !== undefined && !r.answer.toLowerCase().includes(request.to.toLowerCase())) {
      return itemFromResult(name, intent, 'warn',
        `referenced transaction succeeded but its answer does not mention counterparty ${request.to} — evidence may be unrelated`, r);
    }
    return itemFromResult(name, intent, 'pass',
      `referenced transaction succeeded on-chain${request.to !== undefined ? ' and involves the stated counterparty' : ''}`, r);
  }
  return itemFromResult(name, intent, 'warn', 'could not determine the referenced transaction status from the miner answer', r);
}

function evaluateValue(
  request: CheckRequest,
  outcome: SignalOutcome | undefined,
  txOutcome: SignalOutcome | undefined,
): CheckItem | null {
  const name = 'VALUE';
  const intent: ShieldIntent = 'CRYPTO_PRICE';
  if (outcome === undefined) {
    if (request.valueEth === undefined) return null; // nothing to appraise
    return itemFromFailure(name, intent, 'error', 'no CRYPTO_PRICE signal was collected to price the transaction value', outcome);
  }
  if (!outcome.ok) return itemFromFailure(name, intent, 'error', `Telegraph CRYPTO_PRICE query failed: ${outcome.reason}`, outcome);

  const r = outcome.result;
  if (request.valueEth === undefined) {
    return itemFromResult(name, intent, 'pass', 'no transaction value supplied — nothing to appraise', r);
  }
  const usdPerEth = parseUsdAmount(r.answer);
  if (usdPerEth === null) {
    return itemFromResult(name, intent, 'warn', 'could not parse an ETH/USD price from the miner answer — transaction value left unpriced', r);
  }
  const usd = request.valueEth * usdPerEth;
  const label = `${request.valueEth} ETH ~ ${fmtUsd(usd)} (ETH at ${fmtUsd(usdPerEth)})`;
  if (usd > VALUE_FAIL_USD) {
    // >$100k needs on-chain evidence: a referenced tx that actually succeeded.
    const txVerified = txOutcome !== undefined && txOutcome.ok && parseTxStatus(txOutcome.result.answer) === 'success';
    if (request.txHash !== undefined && txVerified) {
      return itemFromResult(name, intent, 'warn', `${label} exceeds ${fmtUsd(VALUE_FAIL_USD)} — allowed only because verified on-chain tx evidence was supplied`, r);
    }
    return itemFromResult(name, intent, 'fail', `${label} exceeds ${fmtUsd(VALUE_FAIL_USD)} with no verified txHash evidence`, r);
  }
  if (usd > VALUE_WARN_USD) {
    return itemFromResult(name, intent, 'warn', `${label} exceeds ${fmtUsd(VALUE_WARN_USD)} — double-check the recipient before signing`, r);
  }
  return itemFromResult(name, intent, 'pass', `transaction value ${label} is below the caution thresholds`, r);
}

function evaluateLiquidity(request: CheckRequest, outcome: SignalOutcome | undefined): CheckItem | null {
  const name = 'LIQUIDITY';
  const intent: ShieldIntent = 'TVL_LOOKUP';
  const protocol = request.protocol ?? 'the protocol';
  if (outcome === undefined) {
    if (request.protocol === undefined) return null; // no protocol named — check not applicable
    // spec: TVL unavailable => warn (not error)
    return itemFromFailure(name, intent, 'warn', `no TVL signal available for ${protocol} — liquidity unverified`, outcome);
  }
  if (!outcome.ok) {
    return itemFromFailure(name, intent, 'warn', `TVL signal unavailable for ${protocol} (${outcome.reason}) — liquidity unverified`, outcome);
  }

  const r = outcome.result;
  const tvl = parseUsdAmount(r.answer);
  if (tvl === null) {
    return itemFromResult(name, intent, 'warn', `could not parse a TVL figure for ${protocol} from the miner answer`, r);
  }
  if (tvl < MIN_TVL_USD) {
    return itemFromResult(name, intent, 'warn', `reported TVL ${fmtUsd(tvl)} for ${protocol} is below the ${fmtUsd(MIN_TVL_USD)} liquidity threshold`, r);
  }
  return itemFromResult(name, intent, 'pass', `reported TVL ${fmtUsd(tvl)} for ${protocol} clears the ${fmtUsd(MIN_TVL_USD)} liquidity threshold`, r);
}

// ---------- report assembly ----------

function finalizeReport(checks: CheckItem[]): CheckReport {
  if (checks.length === 0) {
    return {
      verdict: 'CAUTION',
      score: 50,
      reasons: ['No live Telegraph signals were available to evaluate this request.'],
      checks: [],
    };
  }
  let score = 100;
  let fails = 0;
  const reasons: string[] = [];
  for (const c of checks) {
    score -= PENALTY[c.status];
    if (c.status === 'fail') fails++;
    if (c.status !== 'pass') reasons.push(`${c.name}: ${c.summary}`);
  }
  score = Math.max(0, Math.min(100, score));

  let verdict: ShieldVerdict = score >= 80 ? 'SAFE' : score >= 50 ? 'CAUTION' : 'BLOCK';
  if (fails >= 1 && verdict === 'SAFE') verdict = 'CAUTION'; // any fail caps at CAUTION
  if (fails >= 2) verdict = 'BLOCK'; // two fails always block
  // zero live evidence can never green-light a signature
  if (verdict === 'SAFE' && checks.every((c) => c.status === 'error')) verdict = 'CAUTION';

  if (reasons.length === 0) reasons.push('All checks passed against live Telegraph miner signals.');
  return { verdict, score, reasons, checks };
}

/**
 * Build the go/no-go report for POST /api/check from the caller's request and
 * whatever live Telegraph signals were collected. Any signal may be missing
 * (undefined) or failed (ok:false); the report degrades gracefully.
 */
export function buildCheckReport(request: CheckRequest, signals: SignalSet): CheckReport {
  const checks: CheckItem[] = [];
  const fee = evaluateFee(request, signals.gas);
  if (fee) checks.push(fee);
  const counterparty = evaluateCounterparty(request, signals.tx);
  if (counterparty) checks.push(counterparty);
  const value = evaluateValue(request, signals.price, signals.tx);
  if (value) checks.push(value);
  const liquidity = evaluateLiquidity(request, signals.tvl);
  if (liquidity) checks.push(liquidity);
  return finalizeReport(checks);
}

/**
 * Single-transaction verification report for GET /api/verify/:txHash, judged
 * from one ONCHAIN_TX_LOOKUP signal. Stricter mapping than the composite
 * report: verifying a reverted transaction is an outright BLOCK.
 */
export function assessTxVerification(txHash: string, outcome: SignalOutcome | undefined): CheckReport {
  const name = 'TX_VERIFICATION';
  const intent: ShieldIntent = 'ONCHAIN_TX_LOOKUP';
  const hash = txHash.toLowerCase();

  if (outcome === undefined || !outcome.ok) {
    const reason = outcome !== undefined && !outcome.ok ? outcome.reason : 'no signal collected';
    const check = itemFromFailure(name, intent, 'error', `Telegraph ONCHAIN_TX_LOOKUP query failed: ${reason}`, outcome);
    return { verdict: 'CAUTION', score: 50, reasons: [`${name}: ${check.summary}`], checks: [check] };
  }

  const r = outcome.result;
  const status = parseTxStatus(r.answer);
  let check: CheckItem;
  let verdict: ShieldVerdict;
  let score: number;
  if (status === 'reverted') {
    check = itemFromResult(name, intent, 'fail', `transaction ${hash} REVERTED on-chain per the live Telegraph miner`, r);
    verdict = 'BLOCK';
    score = 20;
  } else if (status === 'not_found') {
    check = itemFromResult(name, intent, 'warn', `transaction ${hash} was not found on-chain — it may be unmined, dropped, or on another chain`, r);
    verdict = 'CAUTION';
    score = 60;
  } else if (status === 'success') {
    if (r.answer.toLowerCase().includes(hash)) {
      check = itemFromResult(name, intent, 'pass', `transaction ${hash} succeeded on-chain per the live Telegraph miner`, r);
      verdict = 'SAFE';
      score = 100;
    } else {
      check = itemFromResult(name, intent, 'warn', `miner reports success but its answer does not reference ${hash} — treat as unverified`, r);
      verdict = 'CAUTION';
      score = 60;
    }
  } else {
    check = itemFromResult(name, intent, 'warn', 'could not determine the transaction status from the miner answer', r);
    verdict = 'CAUTION';
    score = 60;
  }
  return { verdict, score, reasons: [`${name}: ${check.summary}`], checks: [check] };
}
