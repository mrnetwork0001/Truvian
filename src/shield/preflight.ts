/**
 * Truvian Shield preflight: decide about a token before acting on it, from
 * intelligence bought through Telegraph and checked against the chain.
 *
 * Two desks share one engine:
 *  - trade   (Mission 14, Web3 Native & DeFi, route 1 "token-risk preflight"):
 *            an agent about to buy a token gets HOLD / REVIEW / REJECT, and the
 *            trade is only simulated, never sent.
 *  - listing (Mission 01, Exchange, route 1 "autonomous listing review"):
 *            a listings desk gets LIST / REVIEW / REJECT for a token contract,
 *            its issuer and its treasury wallet.
 *
 * How a decision is reached:
 *  1. Free direct chain reads at one block (tokenFacts.ts). An address with no
 *     contract code is rejected here and nothing is bought.
 *  2. One routed Telegraph request per fact, answered by the node's ranked
 *     miner and paid from escrow. A fact bought in the last few minutes is
 *     reused instead of bought again.
 *  3. Fixed rules over the scored fields (`evaluate`, a pure function). Any
 *     blocking finding rejects; any finding that needs a person makes it
 *     REVIEW; only a clean run clears. A check that did not answer can never
 *     clear a token: it is a REVIEW finding, not a pass.
 */
import type { SupportedChain } from '../config/chains.js';
import { apiKeyBalanceUsd, askTypedIntent, type PaymentReceipt, type TypedAnswer } from './telegraph.js';
import { parseAddress, parseChain, readBalanceGwei, readTokenFacts, TokenFactsError, type TokenFacts } from './tokenFacts.js';

export type PreflightMode = 'trade' | 'listing';
export type Decision = 'HOLD' | 'LIST' | 'REVIEW' | 'REJECT';
export type Severity = 'block' | 'review' | 'info' | 'pass';
export type PurchaseKey = 'security' | 'supply' | 'wash' | 'liquidity' | 'sanctions' | 'treasury';

export interface PreflightRequest {
  mode: PreflightMode;
  chain: SupportedChain;
  token: `0x${string}`;
  /** DEX pool the trade would go through (required for trade, optional for listing) */
  pool?: `0x${string}`;
  /** Simulated trade size in USD (trade) */
  tradeUsd?: number;
  /** Legal name of the issuer to screen (listing) */
  issuer?: string;
  /** Issuer treasury wallet (listing) */
  treasury?: `0x${string}`;
}

/** One Telegraph request and its answer, kept as evidence. */
export interface Purchase {
  key: PurchaseKey;
  intent: string;
  params: Record<string, unknown>;
  ok: boolean;
  fields: Record<string, unknown> | null;
  fieldStatus: Record<string, string>;
  minerId?: string;
  minerName?: string;
  /** Billed for this memo: 0 when the answer was reused */
  costUsd: number;
  signalHash?: string;
  /** The escrow payment for this answer (engine route); on a reused answer, the original payment */
  receipt?: PaymentReceipt;
  /** Ranked position of the miner that answered, when the node reports it */
  servedRank?: number;
  latencyMs: number;
  error?: string;
  /** True when a fresh earlier answer to the same request was reused instead of bought again */
  reused: boolean;
  /** When the reused answer was bought */
  boughtAt: string;
}

export interface Finding {
  /** Stable rule id, e.g. security.honeypot */
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Where the evidence comes from */
  source: 'telegraph' | 'chain' | 'telegraph+chain' | 'policy';
  /** Purchase keys this finding rests on */
  evidence: PurchaseKey[];
}

/** The thresholds the rules use, written into every memo so a decision can be re-derived. */
export const POLICY = {
  /** Telegraph total supply vs the chain read; the node's own comparator allows 50 bps */
  supplyToleranceBps: 50,
  /** Telegraph treasury balance vs the chain read; the node's comparator allows 5 bps */
  treasuryToleranceBps: 5,
  /** wash_volume_pct at or above which the token needs review / is rejected */
  washReviewPct: 20,
  washBlockPct: 50,
  /** Pool liquidity below this needs review */
  minLiquidityUsd: 100_000,
  /** A trade above this share of pool liquidity needs review (price impact) */
  maxTradeShareOfLiquidityPct: 1,
  /** Share of supply held by the top 10 holders above which the token needs review */
  holderConcentrationReviewPct: 50,
  /**
   * ...unless the pool is at least this deep: concentration is a risk when
   * large holders can dump into thin liquidity. WETH (58.2%, protocols and
   * bridges) and SQUID (59.1%) are indistinguishable by concentration alone.
   */
  concentrationDeepLiquidityUsd: 1_000_000,
  /** Buy or sell tax at or above these needs review / is rejected */
  taxReviewPct: 10,
  taxBlockPct: 50,
  /** A non-match whose fuzzy score is at least this still needs review */
  sanctionsNearMatchScore: 0.85,
} as const;

export interface PreflightMemo {
  version: 'truvian-shield-memo/1';
  kind: 'token-preflight' | 'listing-review';
  createdAt: string;
  input: {
    mode: PreflightMode;
    chain: SupportedChain;
    token: string;
    pool: string | null;
    tradeUsd: number | null;
    issuer: string | null;
    treasury: string | null;
  };
  network: {
    telegraphNode: string;
    routing: string;
    settlement: string;
    note: string;
  };
  chainReads: (TokenFacts & { source: string }) | null;
  treasuryRead: { address: string; block: string; balanceGwei: string; source: string } | null;
  purchases: Purchase[];
  findings: Finding[];
  decision: Decision;
  decisionRule: string;
  /** What the agent does with the decision (trade mode); always simulated */
  action: { simulated: true; description: string; executed: boolean } | null;
  cost: {
    telegraphUsd: number;
    paidRequests: number;
    reusedRequests: number;
    failedRequests: number;
    budgetUsd: number;
    escrowBeforeUsd: number | null;
  };
  latencyMs: number;
  policy: typeof POLICY;
}

export class PreflightInputError extends Error {}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function normalizePreflightRequest(raw: unknown): PreflightRequest {
  if (typeof raw !== 'object' || raw === null) throw new PreflightInputError('body must be a JSON object');
  const body = raw as Record<string, unknown>;
  const mode = String(body.mode ?? 'trade').trim().toLowerCase();
  if (mode !== 'trade' && mode !== 'listing') throw new PreflightInputError('mode must be "trade" or "listing"');
  try {
    const out: PreflightRequest = {
      mode,
      chain: parseChain(body.chain ?? 'ethereum'),
      token: parseAddress(body.token, 'token'),
    };
    const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
    if (has(body.pool)) out.pool = parseAddress(body.pool, 'pool');
    if (mode === 'trade') {
      if (!out.pool) throw new PreflightInputError('a trade preflight needs the pool the trade would go through (pool)');
      const size = has(body.tradeUsd) ? Number(body.tradeUsd) : 1000;
      if (!Number.isFinite(size) || size <= 0 || size > 1e9) throw new PreflightInputError('tradeUsd must be a positive number of US dollars');
      out.tradeUsd = size;
    } else {
      if (!has(body.issuer)) throw new PreflightInputError('a listing review needs the issuer\'s legal name to screen (issuer)');
      const issuer = String(body.issuer).trim();
      if (issuer.length > 120) throw new PreflightInputError('issuer must be at most 120 characters');
      out.issuer = issuer;
      if (has(body.treasury)) out.treasury = parseAddress(body.treasury, 'treasury');
    }
    return out;
  } catch (err) {
    if (err instanceof TokenFactsError) throw new PreflightInputError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rules (pure)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim() !== '') : []);
const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n: number): string => `${Number(n.toFixed(4))}%`;

function relDiffBps(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return (Math.abs(a - b) / Math.abs(b)) * 10_000;
}

function unavailable(p: Purchase | undefined, key: PurchaseKey, what: string): Finding {
  return {
    rule: `${key}.unavailable`,
    severity: 'review',
    title: `${what}: no answer`,
    detail: `Telegraph did not return ${p?.intent ?? 'this check'}${p?.error ? ` (${p.error})` : ''}. A check that did not answer cannot clear the token.`,
    source: 'telegraph',
    evidence: [key],
  };
}

/** Facts the security provider states in its summary text (GoPlus-based scans word them this way). */
export function summaryFacts(summary: string | null): { honeypot: 'yes' | 'no' | 'unknown' | null; buyTax: number | null; sellTax: number | null; top10: number | null } {
  const s = summary ?? '';
  // Longest alternative first: "no" is a prefix of "not determined".
  const hp = s.match(/honeypot:\s*(not determined|unknown|yes|no)\b/i)?.[1]?.toLowerCase() ?? null;
  const pctOf = (re: RegExp): number | null => {
    const m = s.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    honeypot: hp === null ? null : hp === 'yes' ? 'yes' : hp === 'no' ? 'no' : 'unknown',
    buyTax: pctOf(/buy tax\s*(\d+(?:\.\d+)?)%/i),
    sellTax: pctOf(/sell tax\s*(\d+(?:\.\d+)?)%/i),
    top10: pctOf(/top 10 holders own\s*(\d+(?:\.\d+)?)%/i),
  };
}

/**
 * An answer that says the provider examined nothing. Seen live on 2026-11-20
 * from a ranked miner: verdict "Secure" with "No code, configuration, or
 * system description was provided to evaluate", and a wash-trading answer of
 * 0% "organic" whose summary began "Insufficient data". Minutes later the
 * same miner put 86% "likely wash trading" on USDC, again after "Insufficient
 * data", measured against a $6M pool. Such an answer is no evidence either
 * way: it can neither clear nor reject a token, only send it to a person.
 */
const NOT_EXAMINED = /\bno (?:code|contract|configuration|system description|data|trade records|transaction data|information)\b[^.]{0,80}?\b(?:was|were|is|are)?\s*(?:provided|given|available|supplied)\b|\binsufficient (?:data|information)\b|\bwithout (?:actual|any) (?:transaction|trade|code|data|information)\b|\b(?:cannot|can ?not|could not|unable to) (?:evaluate|assess|analy[sz]e|perform)\b|\bnot enough (?:data|information)\b|\bno assessment\b[^.]{0,40}\bcan be made\b/i;

export function notExamined(...texts: unknown[]): string | null {
  for (const t of texts) {
    const s = typeof t === 'string' ? t : Array.isArray(t) ? t.map(String).join(' ') : '';
    const m = s.match(NOT_EXAMINED);
    if (m) return m[0];
  }
  return null;
}

function securityFindings(p: Purchase | undefined): Finding[] {
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'security', 'Security review')];
  const examined = notExamined(p.fields.summary, p.fields.issues);
  if (examined) {
    return [{
      rule: 'security.not_examined', severity: 'review', title: 'Security review did not examine the contract',
      detail: `The answer says "${examined}"${str(p.fields.verdict) ? ` yet gives the verdict "${str(p.fields.verdict)}"` : ''}, so it is no evidence about this contract either way.`,
      source: 'telegraph', evidence: ['security'],
    }];
  }
  return securityFindingsFrom(p, p.fields);
}

function securityFindingsFrom(p: Purchase, f: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];
  const verdict = str(f.verdict);
  const count = num(f.vulnerability_count);
  const summary = str(f.summary);
  const facts = summaryFacts(summary);
  const ev: PurchaseKey[] = ['security'];

  if (verdict === 'Insecure') out.push({ rule: 'security.insecure', severity: 'block', title: 'Security review: insecure', detail: summary ?? 'The security review judged the contract insecure.', source: 'telegraph', evidence: ev });
  else if (verdict === 'Needs changes') out.push({ rule: 'security.needs_changes', severity: 'review', title: 'Security review: needs changes', detail: summary ?? 'The security review asked for changes.', source: 'telegraph', evidence: ev });
  if (count !== null && count > 0 && verdict !== 'Insecure') {
    out.push({ rule: 'security.vulnerabilities', severity: 'review', title: `Security review found ${count} weakness${count === 1 ? '' : 'es'}`, detail: list(f.issues).join('; ') || 'No details given.', source: 'telegraph', evidence: ev });
  }

  // The scan facts the provider reported, read from its summary text.
  if (facts.honeypot === 'yes') out.push({ rule: 'security.honeypot', severity: 'block', title: 'Honeypot', detail: 'The contract scan reports the token as a honeypot: buyers cannot sell.', source: 'telegraph', evidence: ev });
  else if (facts.honeypot === 'unknown') out.push({ rule: 'security.honeypot_unknown', severity: 'review', title: 'Honeypot status not determined', detail: 'The contract scan could not determine whether holders can sell.', source: 'telegraph', evidence: ev });
  for (const [side, tax] of [['buy', facts.buyTax], ['sell', facts.sellTax]] as const) {
    if (tax === null) continue;
    if (tax >= POLICY.taxBlockPct) out.push({ rule: `security.${side}_tax`, severity: 'block', title: `${side} tax ${pct(tax)}`, detail: `A ${side} tax of ${pct(tax)} takes most of the trade.`, source: 'telegraph', evidence: ev });
    else if (tax >= POLICY.taxReviewPct) out.push({ rule: `security.${side}_tax`, severity: 'review', title: `${side} tax ${pct(tax)}`, detail: `A ${side} tax of ${pct(tax)} is at or above the ${POLICY.taxReviewPct}% review threshold.`, source: 'telegraph', evidence: ev });
  }
  if (facts.top10 !== null && facts.top10 > POLICY.holderConcentrationReviewPct) {
    out.push({ rule: 'security.holder_concentration', severity: 'review', title: `Top 10 holders own ${pct(facts.top10)}`, detail: `More than ${POLICY.holderConcentrationReviewPct}% of the supply sits with ten holders, who can move the price at will.`, source: 'telegraph', evidence: ev });
  }
  for (const issue of list(f.issues)) {
    if (/proxy|upgradeable/i.test(issue)) continue; // reported from the chain read instead, as info
    if (/honeypot/i.test(issue) && facts.honeypot === 'yes') continue;
    out.push({ rule: 'security.issue', severity: /honeypot|blacklist|cannot sell|rug/i.test(issue) ? 'block' : 'review', title: 'Security review issue', detail: issue, source: 'telegraph', evidence: ev });
  }

  // Clearing needs a positive basis: a Secure verdict, or no verdict but every scan fact present and clean.
  if (verdict === 'Secure') {
    out.push({ rule: 'security.secure', severity: 'pass', title: 'Security review: secure', detail: summary ?? 'The security review judged the contract secure.', source: 'telegraph', evidence: ev });
  } else if (verdict === null) {
    const complete = facts.honeypot !== null && facts.buyTax !== null && facts.sellTax !== null && facts.top10 !== null;
    if (!complete) {
      out.push({
        rule: 'security.no_verdict', severity: 'review', title: 'Security review gave no verdict',
        detail: `The review returned no verdict (field status: ${JSON.stringify(p.fieldStatus)}) and did not report every scan fact this desk needs (honeypot, buy and sell tax, holder concentration), so it cannot clear the token.`,
        source: 'telegraph', evidence: ev,
      });
    } else if (!out.some((x) => (x.severity === 'block' || x.severity === 'review') && x.rule !== 'security.holder_concentration')) {
      out.push({
        rule: 'security.scan_clean', severity: 'pass', title: 'Contract scan clean',
        detail: `No verdict field (status ${JSON.stringify(p.fieldStatus)}), so the decision rests on the scan facts reported: honeypot ${facts.honeypot}, buy tax ${pct(facts.buyTax!)}, sell tax ${pct(facts.sellTax!)}, top 10 holders ${pct(facts.top10!)}.`,
        source: 'telegraph', evidence: ev,
      });
    }
  }
  return out;
}

function supplyFindings(p: Purchase | undefined, facts: TokenFacts): Finding[] {
  if (facts.totalSupply === null) {
    return [{ rule: 'supply.no_chain_read', severity: 'review', title: 'No totalSupply() on chain', detail: `${facts.address} did not answer totalSupply() and decimals() like an ERC-20 at block ${facts.block}.`, source: 'chain', evidence: [] }];
  }
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'supply', 'Total supply')];
  const told = num(p.fields.total_supply);
  if (told === null) return [{ rule: 'supply.missing', severity: 'review', title: 'Total supply: no figure', detail: `The answer carried no total_supply (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['supply'] }];
  const chain = Number(facts.totalSupply);
  const bps = relDiffBps(told, chain);
  if (bps <= POLICY.supplyToleranceBps) {
    return [{ rule: 'supply.agrees', severity: 'pass', title: 'Total supply agrees with the chain', detail: `Telegraph: ${told.toLocaleString('en-US')}; chain at block ${facts.block}: ${chain.toLocaleString('en-US')} (${bps.toFixed(1)} bps apart, tolerance ${POLICY.supplyToleranceBps}).`, source: 'telegraph+chain', evidence: ['supply'] }];
  }
  return [{ rule: 'supply.conflict', severity: 'review', title: 'Total supply conflicts with the chain', detail: `Telegraph says ${told.toLocaleString('en-US')} but the contract reports ${chain.toLocaleString('en-US')} at block ${facts.block} (${Number.isFinite(bps) ? `${bps.toFixed(0)} bps` : 'unbounded'} apart, tolerance ${POLICY.supplyToleranceBps}). Conflicting sources need a person.`, source: 'telegraph+chain', evidence: ['supply'] }];
}

function washFindings(p: Purchase | undefined): Finding[] {
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'wash', 'Wash-trading check')];
  const share = num(p.fields.wash_volume_pct);
  const verdict = str(p.fields.verdict);
  const context = [verdict ? `verdict "${verdict}"` : null, str(p.fields.summary)].filter(Boolean).join('; ');
  if (share === null) return [{ rule: 'wash.missing', severity: 'review', title: 'Wash trading: no figure', detail: `The answer carried no wash_volume_pct (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['wash'] }];
  const examined = notExamined(p.fields.summary);
  if (examined) return [{ rule: 'wash.not_examined', severity: 'review', title: 'Wash-trading check did not examine the trades', detail: `The answer reports ${pct(share)}${verdict ? ` ("${verdict}")` : ''} but says "${examined}", so the figure is no evidence either way.`, source: 'telegraph', evidence: ['wash'] }];
  if (share >= POLICY.washBlockPct) return [{ rule: 'wash.block', severity: 'block', title: `${pct(share)} of volume is wash trading`, detail: context, source: 'telegraph', evidence: ['wash'] }];
  if (share >= POLICY.washReviewPct) return [{ rule: 'wash.review', severity: 'review', title: `${pct(share)} of volume is wash trading`, detail: context, source: 'telegraph', evidence: ['wash'] }];
  return [{ rule: 'wash.ok', severity: 'pass', title: `Wash trading ${pct(share)} of volume`, detail: context, source: 'telegraph', evidence: ['wash'] }];
}

function liquidityFindings(p: Purchase | undefined, req: PreflightRequest): Finding[] {
  if (!req.pool) return [{ rule: 'liquidity.not_checked', severity: 'info', title: 'Liquidity not checked', detail: 'No pool was given, so pool depth was not bought.', source: 'policy', evidence: [] }];
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'liquidity', 'Pool liquidity')];
  const depth = num(p.fields.liquidity_usd);
  if (depth === null) return [{ rule: 'liquidity.missing', severity: 'review', title: 'Liquidity: no figure', detail: `The answer carried no liquidity_usd (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['liquidity'] }];
  const out: Finding[] = [];
  if (depth < POLICY.minLiquidityUsd) out.push({ rule: 'liquidity.thin', severity: 'review', title: `Pool liquidity ${usd(depth)}`, detail: `Below the ${usd(POLICY.minLiquidityUsd)} this desk needs; exits can move the price sharply.`, source: 'telegraph', evidence: ['liquidity'] });
  if (req.mode === 'trade' && req.tradeUsd !== undefined) {
    const share = (req.tradeUsd / depth) * 100;
    if (share > POLICY.maxTradeShareOfLiquidityPct) out.push({ rule: 'liquidity.price_impact', severity: 'review', title: `Trade is ${pct(share)} of the pool`, detail: `${usd(req.tradeUsd)} against ${usd(depth)} of liquidity is above the ${POLICY.maxTradeShareOfLiquidityPct}% limit; expect price impact.`, source: 'telegraph', evidence: ['liquidity'] });
  }
  if (out.length === 0) out.push({ rule: 'liquidity.ok', severity: 'pass', title: `Pool liquidity ${usd(depth)}`, detail: req.tradeUsd !== undefined ? `A ${usd(req.tradeUsd)} trade is ${pct((req.tradeUsd / depth) * 100)} of the pool.` : 'Above the minimum this desk needs.', source: 'telegraph', evidence: ['liquidity'] });
  return out;
}

function sanctionsFindings(p: Purchase | undefined, issuer: string): Finding[] {
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'sanctions', 'Sanctions screening')];
  const matched = p.fields.matched;
  const score = num(p.fields.match_score);
  const lists = list(p.fields.lists);
  const matches = list(p.fields.matches);
  if (matched === true) return [{ rule: 'sanctions.match', severity: 'block', title: `Issuer matches a sanctions list`, detail: `"${issuer}" matched ${matches.join(', ') || 'an entry'}${lists.length ? ` (lists checked: ${lists.length})` : ''}.`, source: 'telegraph', evidence: ['sanctions'] }];
  if (matched !== false) return [{ rule: 'sanctions.uncertain', severity: 'review', title: 'Sanctions screening uncertain', detail: `The screening returned no clear match result (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['sanctions'] }];
  if (score !== null && score >= POLICY.sanctionsNearMatchScore) return [{ rule: 'sanctions.near_match', severity: 'review', title: 'Close name match', detail: `No match, but the best fuzzy score is ${score}; a person should compare the names.`, source: 'telegraph', evidence: ['sanctions'] }];
  return [{ rule: 'sanctions.clear', severity: 'pass', title: 'Issuer not on the sanctions lists checked', detail: `"${issuer}" did not match${lists.length ? ` across ${lists.length} lists (${lists.slice(0, 3).join(', ')}${lists.length > 3 ? ', ...' : ''})` : ''}.`, source: 'telegraph', evidence: ['sanctions'] }];
}

function treasuryFindings(p: Purchase | undefined, read: PreflightMemo['treasuryRead'], requested: boolean): Finding[] {
  if (!requested) return [];
  if (!read) return [{ rule: 'treasury.no_chain_read', severity: 'review', title: 'Treasury balance unreadable', detail: 'The chain did not answer for the treasury balance.', source: 'chain', evidence: [] }];
  if (!p) return [{ rule: 'treasury.chain_only', severity: 'info', title: `Treasury holds ${Number(read.balanceGwei) / 1e9} native coin`, detail: `Read directly at block ${read.block}; ONCHAIN_METRIC_VERIFY covers Ethereum, Polygon and Arbitrum only, so it was not bought on this chain.`, source: 'chain', evidence: [] }];
  if (!p.ok || !p.fields) return [unavailable(p, 'treasury', 'Treasury balance')];
  const told = num(p.fields.balance_gwei);
  const chain = Number(read.balanceGwei);
  if (told === null) return [{ rule: 'treasury.missing', severity: 'review', title: 'Treasury balance: no figure', detail: `The answer carried no balance_gwei (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['treasury'] }];
  const bps = relDiffBps(told, chain);
  if (bps <= POLICY.treasuryToleranceBps) return [{ rule: 'treasury.agrees', severity: 'pass', title: `Treasury holds ${chain / 1e9} native coin`, detail: `Telegraph and the chain agree at block ${read.block} (${bps.toFixed(2)} bps apart).`, source: 'telegraph+chain', evidence: ['treasury'] }];
  return [{ rule: 'treasury.conflict', severity: 'review', title: 'Treasury balance conflicts with the chain', detail: `Telegraph says ${told} Gwei, the chain says ${read.balanceGwei} Gwei at block ${read.block}.`, source: 'telegraph+chain', evidence: ['treasury'] }];
}

function chainFindings(facts: TokenFacts): Finding[] {
  const out: Finding[] = [];
  if (facts.proxy) {
    out.push({ rule: 'chain.upgradeable', severity: 'info', title: 'Upgradeable proxy', detail: `${facts.proxy.standard} implementation ${facts.proxy.implementation}${facts.proxy.admin ? `, admin ${facts.proxy.admin}` : ''}: whoever controls the proxy can replace the token's code.`, source: 'chain', evidence: [] });
  }
  if (facts.owner) out.push({ rule: 'chain.owner', severity: 'info', title: 'Contract has an owner', detail: `owner() is ${facts.owner}.`, source: 'chain', evidence: [] });
  return out;
}

/**
 * The decision from the evidence. Pure: the same facts and answers always
 * give the same findings and decision, so a memo can be re-derived.
 */
export function evaluate(
  req: PreflightRequest,
  facts: TokenFacts,
  purchases: Purchase[],
  treasuryRead: PreflightMemo['treasuryRead'],
): { findings: Finding[]; decision: Decision; decisionRule: string } {
  const by = (key: PurchaseKey) => purchases.find((p) => p.key === key);
  if (!facts.isContract) {
    return {
      findings: [{ rule: 'chain.not_a_contract', severity: 'block', title: 'Not a contract', detail: `${facts.address} has no contract code on ${facts.chainLabel} at block ${facts.block}${facts.delegatedTo ? ` (it is an account with an EIP-7702 delegation to ${facts.delegatedTo})` : ''}: it is not a token. Nothing was bought.`, source: 'chain', evidence: [] }],
      decision: 'REJECT',
      decisionRule: 'any blocking finding rejects',
    };
  }
  const security = securityFindings(by('security'));
  const depth = by('liquidity')?.ok ? num(by('liquidity')!.fields?.liquidity_usd) : null;
  for (const f of security) {
    if (f.rule === 'security.holder_concentration' && depth !== null && depth >= POLICY.concentrationDeepLiquidityUsd) {
      f.severity = 'info';
      f.detail += ` The pool holds ${usd(depth)}, at least the ${usd(POLICY.concentrationDeepLiquidityUsd)} that absorbs sales by large holders, so this is disclosed rather than held against the token.`;
      f.evidence = ['security', 'liquidity'];
    }
  }
  const findings = [
    ...chainFindings(facts),
    ...security,
    ...supplyFindings(by('supply'), facts),
    ...washFindings(by('wash')),
    ...liquidityFindings(by('liquidity'), req),
    ...(req.mode === 'listing' ? sanctionsFindings(by('sanctions'), req.issuer ?? '') : []),
    ...(req.mode === 'listing' ? treasuryFindings(by('treasury'), treasuryRead, req.treasury !== undefined) : []),
  ];
  if (findings.some((f) => f.severity === 'block')) return { findings, decision: 'REJECT', decisionRule: 'any blocking finding rejects' };
  if (findings.some((f) => f.severity === 'review')) return { findings, decision: 'REVIEW', decisionRule: 'no blocking finding, but at least one finding needs a person' };
  return { findings, decision: req.mode === 'trade' ? 'HOLD' : 'LIST', decisionRule: 'every check answered and none raised a finding' };
}

// ---------------------------------------------------------------------------
// Purchases: one routed request per fact, reused while fresh
// ---------------------------------------------------------------------------

/** Escrow the node holds per routed ask while it runs (it bills about $0.01 of it). */
const HOLD_PER_ASK_USD = 0.26;
const REUSE_TTL_MS = Number(process.env.SHIELD_REUSE_TTL_MS) > 0 ? Number(process.env.SHIELD_REUSE_TTL_MS) : 10 * 60_000;

function budgetUsd(): number {
  const n = Number(process.env.SHIELD_PREFLIGHT_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.1;
}

const fresh = new Map<string, { at: number; answer: Promise<TypedAnswer> }>();

function cacheKey(intent: string, params: Record<string, unknown>): string {
  return `${intent} ${JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))}`;
}

/** Ask once; a request already answered (or in flight) in the last REUSE_TTL_MS is reused. */
async function buy(key: PurchaseKey, intent: string, params: Record<string, unknown>, question: string): Promise<Purchase> {
  const ck = cacheKey(intent, params);
  const now = Date.now();
  const hit = fresh.get(ck);
  const reused = hit !== undefined && now - hit.at < REUSE_TTL_MS;
  let entry = hit;
  if (!reused) {
    entry = { at: now, answer: askTypedIntent(intent, params, question) };
    fresh.set(ck, entry);
  }
  const answer = await entry!.answer;
  if (!answer.ok && fresh.get(ck) === entry) fresh.delete(ck); // never reuse a failure
  const out: Purchase = {
    key, intent, params, ok: answer.ok, fields: answer.fields, fieldStatus: answer.fieldStatus,
    costUsd: reused ? 0 : answer.costUsd ?? 0,
    latencyMs: reused ? 0 : answer.latencyMs,
    reused,
    boughtAt: new Date(entry!.at).toISOString(),
  };
  if (answer.minerId) out.minerId = answer.minerId;
  if (answer.minerName) out.minerName = answer.minerName;
  if (answer.signalHash) out.signalHash = answer.signalHash;
  if (answer.receipt) out.receipt = answer.receipt;
  if (answer.servedRank !== undefined) out.servedRank = answer.servedRank;
  if (answer.error) out.error = answer.error;
  return out;
}

/** Run tasks with at most `limit` in flight. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number, onDone: (r: T) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
      onDone(results[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Chains ONCHAIN_METRIC_VERIFY_GENERAL reads (its `chain` enum, 2026-11-20). */
const METRIC_CHAINS = new Set<SupportedChain>(['ethereum', 'polygon', 'arbitrum']);

export interface PreflightEvents {
  onChainRead?: (facts: TokenFacts) => void;
  onPlan?: (plan: Array<{ key: PurchaseKey; intent: string }>, escrowUsd: number | null) => void;
  onPurchase?: (p: Purchase) => void;
}

export async function runPreflight(req: PreflightRequest, events: PreflightEvents = {}): Promise<PreflightMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const facts = await readTokenFacts(req.chain, req.token);
  events.onChainRead?.(facts);

  const label = facts.chainLabel;
  const name = facts.symbol ?? 'token';
  type Planned = { key: PurchaseKey; intent: string; params: Record<string, unknown>; question: string };
  const plan: Planned[] = [];
  let treasuryRead: PreflightMemo['treasuryRead'] = null;
  if (facts.isContract) {
    plan.push({ key: 'security', intent: 'SECURITY_REVIEW_GENERAL', params: { target: `${req.token} (${name} token contract) on ${label}` }, question: `Security review of the ${name} token contract ${req.token} on ${label}.` });
    if (facts.totalSupply !== null) plan.push({ key: 'supply', intent: 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', params: { token: `${name} (${req.token}) on ${label}` }, question: `What is the current total supply of ${name} (${req.token}) on ${label}, in whole tokens?` });
    plan.push({ key: 'wash', intent: 'WASH_TRADING_DETECTION_GENERAL', params: { subject: req.pool ? `${name} pool ${req.pool} on ${label}` : `${name} (${req.token}) on ${label}` }, question: `Is there wash trading in ${name} on ${label}?` });
    if (req.pool) plan.push({ key: 'liquidity', intent: 'LIQUIDITY_DEPTH_VERIFY_GENERAL', params: { pool: req.pool, chain: req.chain }, question: `What is the liquidity in USD of the DEX pool ${req.pool} on ${label}?` });
    if (req.mode === 'listing' && req.issuer) plan.push({ key: 'sanctions', intent: 'SANCTIONS_SCREENING_MATCH_GENERAL', params: { name: req.issuer }, question: `Is ${req.issuer} on a sanctions list?` });
    if (req.mode === 'listing' && req.treasury) {
      const block = BigInt(facts.block) - 10n; // a few blocks back, so every provider's node has it
      try {
        treasuryRead = { address: req.treasury, block: block.toString(), balanceGwei: await readBalanceGwei(req.chain, req.treasury, block), source: `${label} JSON-RPC eth_getBalance (Truvian chain registry, not Telegraph)` };
      } catch {
        treasuryRead = null;
      }
      if (METRIC_CHAINS.has(req.chain)) {
        plan.push({ key: 'treasury', intent: 'ONCHAIN_METRIC_VERIFY_GENERAL', params: { address: req.treasury, block: Number(block), chain: req.chain, metric: 'balance' }, question: `What is the native-coin balance, in Gwei, of address ${req.treasury} on ${req.chain} at block ${block}?` });
      }
    }
  }

  // Spending limits before anything is bought.
  const budget = budgetUsd();
  const escrow = plan.length > 0 ? await apiKeyBalanceUsd() : null;
  events.onPlan?.(plan.map(({ key, intent }) => ({ key, intent })), escrow);
  let purchases: Purchase[] = [];
  const policyFindings: Finding[] = [];
  const expected = plan.length * 0.01;
  if (plan.length > 0 && expected > budget) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `This review would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per decision. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0 && escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds for each ask while it runs. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0) {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    purchases = await pooled(plan.map((p) => () => buy(p.key, p.intent, p.params, p.question)), parallel, (p) => events.onPurchase?.(p));
  }

  const judged = evaluate(req, facts, purchases, treasuryRead);
  const findings = [...policyFindings, ...judged.findings];
  let decision = judged.decision;
  let decisionRule = judged.decisionRule;
  if (policyFindings.length > 0 && decision !== 'REJECT') {
    decision = 'REVIEW';
    decisionRule = 'the checks could not be bought, so nothing can clear the token';
  }

  const telegraphUsd = Number(purchases.reduce((s, p) => s + p.costUsd, 0).toFixed(6));
  return {
    version: 'truvian-shield-memo/1',
    kind: req.mode === 'trade' ? 'token-preflight' : 'listing-review',
    createdAt,
    input: {
      mode: req.mode, chain: req.chain, token: req.token, pool: req.pool ?? null,
      tradeUsd: req.tradeUsd ?? null, issuer: req.issuer ?? null, treasury: req.treasury ?? null,
    },
    network: {
      telegraphNode: process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com',
      routing: 'one routed ask per fact (POST /engine/ask with intent and params, paid from escrow); the node picks its ranked miner and returns a payment receipt',
      settlement: 'Anjoman escrow, test USDC on Ethereum Sepolia (testnet)',
      note: 'Telegraph Season II runs on testnet settlement; the facts checked are about the mainnet chain named in input.chain.',
    },
    chainReads: { ...facts, source: `${label} JSON-RPC at block ${facts.block} (Truvian chain registry, not Telegraph)` },
    treasuryRead,
    purchases,
    findings,
    decision,
    decisionRule,
    action: req.mode === 'trade'
      ? {
        simulated: true,
        description: decision === 'HOLD'
          ? `simulated buy of $${req.tradeUsd} of ${name} through pool ${req.pool}: allowed`
          : `simulated buy of $${req.tradeUsd} of ${name}: not placed (${decision})`,
        executed: false,
      }
      : null,
    cost: {
      telegraphUsd,
      paidRequests: purchases.filter((p) => !p.reused && p.ok).length,
      reusedRequests: purchases.filter((p) => p.reused).length,
      failedRequests: purchases.filter((p) => !p.ok).length,
      budgetUsd: budget,
      escrowBeforeUsd: escrow,
    },
    latencyMs: Date.now() - started,
    policy: POLICY,
  };
}
