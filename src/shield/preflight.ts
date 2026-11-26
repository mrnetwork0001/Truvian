/**
 * Truvian Shield preflight: decide about a token before acting on it, from
 * intelligence bought through Telegraph and checked against the chain.
 *
 * Three desks share one engine:
 *  - trade   (Mission 14, Web3 Native & DeFi, route 1 "token-risk preflight"):
 *            an agent about to buy a token gets HOLD / REVIEW / REJECT, and the
 *            trade is only simulated, never sent.
 *  - listing (Mission 01, Exchange, route 1 "autonomous listing review"):
 *            a listings desk gets LIST / REVIEW / REJECT for a token contract,
 *            its issuer and its treasury wallet.
 *  - holdings (Mission 13, Asset Management, "daily holdings proof"): an
 *            investor agent gets VERIFIED / REVIEW / REJECT for what a fund
 *            or index says a custody wallet holds (holdings.ts).
 *
 * How a decision is reached:
 *  1. Free direct chain reads at one block (tokenFacts.ts). An address with no
 *     contract code is rejected here and nothing is bought.
 *  2. One routed Telegraph request per fact, answered by the node's ranked
 *     miner and paid from escrow. When that answer is no evidence (it did
 *     not answer, carried no figure, examined nothing, or is not about this
 *     token), one more ask goes to the next-best miner on the node's
 *     leaderboard, pinned by id, and its answer is used only if it is
 *     evidence: at most one extra answer per fact, within the budget. A fact
 *     bought in the last few minutes is reused instead of bought again.
 *  3. Fixed rules over the scored fields (`evaluate`, a pure function). Any
 *     blocking finding rejects; any finding that needs a person makes it
 *     REVIEW; only a clean run clears. A check that did not answer can never
 *     clear a token: it is a REVIEW finding, not a pass.
 */
import type { SupportedChain } from '../config/chains.js';
import { apiKeyBalanceUsd, askPinnedIntent, askTypedIntent, intentRanking, type IntentRanking, type PaymentReceipt, type RankedMiner, type TypedAnswer } from './telegraph.js';
import { parseAddress, parseChain, readBalanceGwei, readTokenFacts, TokenFactsError, type TokenFacts } from './tokenFacts.js';
import type { SolanaNetwork } from './solana.js';
import type { SettlementSection } from './settlement.js';

export type PreflightMode = 'trade' | 'listing' | 'holdings' | 'settlement';
export type Decision = 'HOLD' | 'LIST' | 'VERIFIED' | 'RELEASE' | 'REVIEW' | 'REJECT';
export type Severity = 'block' | 'review' | 'info' | 'pass';
export type PurchaseKey = 'security' | 'supply' | 'wash' | 'liquidity' | 'sanctions' | 'treasury' | 'balance' | 'registry';

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

/**
 * One fact asked of Telegraph and the answer the decision rests on, kept as
 * evidence. When a second opinion was taken, the answer fields here are the
 * one used, and `secondOpinion` keeps both answers.
 */
export interface Purchase {
  key: PurchaseKey;
  /** Holdings proof: which holding (0-based, in input order) this fact is about */
  holding?: number;
  intent: string;
  params: Record<string, unknown>;
  ok: boolean;
  fields: Record<string, unknown> | null;
  fieldStatus: Record<string, string>;
  minerId?: string;
  minerName?: string;
  /** Billed for this fact in this memo, a second opinion included: 0 when the answer was reused */
  costUsd: number;
  signalHash?: string;
  /** The escrow payment for this answer (engine route); on a reused answer, the original payment */
  receipt?: PaymentReceipt;
  /** Ranked position of the miner that answered, when the node reports it (a routed answer only) */
  servedRank?: number;
  /** Time spent on this fact, a second opinion included */
  latencyMs: number;
  error?: string;
  /** Set when the first answer was no evidence and one more answer was asked for */
  secondOpinion?: SecondOpinion;
  /** True when a fresh earlier answer to the same request was reused instead of bought again */
  reused: boolean;
  /** When the reused answer was bought */
  boughtAt: string;
}

/** One ask's answer, as it was returned and billed. */
export type Answer = Pick<Purchase, 'ok' | 'fields' | 'fieldStatus' | 'minerId' | 'minerName' | 'costUsd' | 'signalHash' | 'receipt' | 'servedRank' | 'latencyMs' | 'error'>;

/**
 * The record of a second opinion: why the routed answer was no evidence, the
 * next-best ranked miner the one extra ask was pinned to, and both answers
 * with their signal hashes and receipts.
 */
export interface SecondOpinion {
  /** Why the first answer was no evidence: the finding it gives */
  reason: string;
  /** That finding's rule, e.g. wash.not_examined */
  reasonRule: string;
  /** The miner asked, and where it stands on the node's leaderboard; null when none could be asked */
  miner: { id: string; slug: string; name: string; rank: number; score: number; epoch: number; priceUsd: number } | null;
  /** True when the decision rests on the second answer */
  used: boolean;
  /** What happened, in words */
  outcome: string;
  /** The routed answer */
  first: Answer;
  /** The pinned answer; null when it was not asked */
  second: Answer | null;
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

/** The holdings proof's own thresholds (Mission 13), written into its memos. */
export const HOLDINGS_POLICY = {
  /** At most this many holdings per proof, so one proof fits the budget per decision */
  maxHoldings: 3,
  /** The chain read may fall short of a claimed amount by at most this much and still cover it */
  claimShortfallToleranceBps: 10,
  /** Telegraph's wallet balance vs the chain read; the two are read seconds apart */
  balanceToleranceBps: 50,
} as const;

/** One holding as the chain shows it at the proof's block (Mission 13). */
export interface HoldingRead {
  token: `0x${string}`;
  /** The amount the fund states, in whole tokens, as given */
  claimed: string;
  /** DEX pool the holding is rebalanced through, when given */
  pool: `0x${string}` | null;
  facts: TokenFacts;
  /** balanceOf(wallet) at facts.block, exact integer; null when the contract did not answer */
  balanceRaw: string | null;
  /** The same in whole tokens, exact decimal text */
  balance: string | null;
}

export interface PreflightMemo {
  version: 'truvian-shield-memo/1';
  kind: 'token-preflight' | 'listing-review' | 'holdings-proof' | 'settlement-assurance';
  createdAt: string;
  input: {
    mode: PreflightMode;
    /** An EVM chain, or solana / solana-devnet for the Solana desks */
    chain: SupportedChain | SolanaNetwork;
    token: string;
    pool: string | null;
    tradeUsd: number | null;
    issuer: string | null;
    treasury: string | null;
    /** Holdings proof: the custody wallet, and what it is said to hold */
    wallet?: string;
    holdings?: Array<{ token: string; claimed: string; pool: string | null }>;
  };
  network: {
    telegraphNode: string;
    routing: string;
    settlement: string;
    note: string;
  };
  chainReads: (TokenFacts & { source: string }) | null;
  treasuryRead: { address: string; block: string; balanceGwei: string; source: string } | null;
  /** Holdings proof: each holding read from the chain at one block */
  holdingReads?: Array<HoldingRead & { source: string }>;
  purchases: Purchase[];
  findings: Finding[];
  decision: Decision;
  decisionRule: string;
  /** What the agent does with the decision (trade mode); always simulated */
  /** What the agent does with the decision: simulated for a trade, a real devnet payment for a settlement */
  action: { simulated: boolean; description: string; executed: boolean } | null;
  cost: {
    telegraphUsd: number;
    /** Asks answered with response fields, second opinions included */
    paidRequests: number;
    /** Facts whose earlier answer was reused at $0 */
    reusedRequests: number;
    /** Asks that returned no response fields (a raw answer may still have been billed: see telegraphUsd) */
    failedRequests: number;
    /** Second opinions asked: one extra pinned ask each, at most one per fact */
    secondOpinions: number;
    budgetUsd: number;
    escrowBeforeUsd: number | null;
  };
  latencyMs: number;
  policy: typeof POLICY;
  holdingsPolicy?: typeof HOLDINGS_POLICY;
  /** Settlement assurance (Solana): the mint, the payer, the recipient and the transfer, read and verified on Solana */
  settlement?: SettlementSection;
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

export function relDiffBps(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return (Math.abs(a - b) / Math.abs(b)) * 10_000;
}

export function unavailable(p: Purchase | undefined, key: PurchaseKey, what: string): Finding {
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
 *
 * The same reviewer worded it differently for USDC (memo WOYbyG3x): "Secure.
 * The input is merely a token contract address query with no executable code,
 * configuration, or data handling to assess". The phrasings that say the
 * request itself is only a query or an address are anchored to the request
 * ("the input", "the request", ...), because real scan text says "only" and
 * "address" about the contract all the time ("only the owner address can
 * pause"). The tests hold the live GoPlus and NVD answers against every
 * alternative.
 */
const REQUEST = String.raw`\b(?:input|request|query|prompt|target|submission|message)\b[^.]{0,80}?`;
const NOT_EXAMINED = new RegExp([
  // "No code, configuration, or system description was provided";
  // "No executable code, configuration files, or system descriptions were supplied for review" (TxLens, 2026-11-21 09:35)
  String.raw`\bno (?:(?:executable|source|smart contract|contract|actual|transaction|trade) )?(?:code|contract|configuration|system description|data|trade records|transaction data|information|details|files)\b[^.]{0,80}?\b(?:was|were|is|are|has been|have been)?\s*(?:provided|given|available|supplied|submitted|included)\b`,
  String.raw`\binsufficient (?:data|information)\b`,
  String.raw`\bwithout (?:actual|any) (?:transaction|trade|code|data|information)\b`,
  String.raw`\b(?:cannot|can ?not|could not|unable to) (?:evaluate|assess|analy[sz]e|perform)\b`,
  String.raw`\b(?:cannot|can ?not|could not) be (?:evaluated|assessed|analy[sz]ed|reviewed|audited)\b`,
  String.raw`\bnot enough (?:data|information)\b`,
  String.raw`\bno assessment\b[^.]{0,40}\bcan be made\b`,
  // "The input is merely a token contract address query"; "The input is purely informational data"
  String.raw`${REQUEST}\b(?:is|was)\s+(?:merely|just|simply|only|purely)\s+(?:an?\b)?[^.]{0,60}?\b(?:query|question|lookup|prompt|request|string|data|text)\b`,
  // "The request only contains a query string", "the input only contains a contract address"
  String.raw`${REQUEST}\b(?:merely|just|simply|only)\s+(?:contains?|includes?|consists? of|provides?|gives?|has|holds)\s+an?\b[^.]{0,60}?\b(?:query|question|string|address|prompt|identifier)\b`,
  // "with no executable code, configuration, or data handling to assess"
  String.raw`\bno (?:executable |source |smart contract |contract )?(?:code|configuration|data|information|details|logic|implementation)\b[^.;]{0,80}?\bto (?:assess|evaluate|review|analy[sz]e|audit|examine|inspect)\b`,
  // "there is nothing to assess"
  String.raw`\bnothing (?:to|that can be|could be) (?:assess|evaluat|review|analy[sz]|audit|examin|inspect)\w*`,
].join('|'), 'i');

export function notExamined(...texts: unknown[]): string | null {
  return firstMatch(NOT_EXAMINED, texts);
}

function firstMatch(re: RegExp, texts: unknown[]): string | null {
  for (const t of texts) {
    const s = typeof t === 'string' ? t : Array.isArray(t) ? t.map(String).join(' ') : '';
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * A figure the answer itself says it did not measure. Seen live on
 * 2026-11-21 (signal 0xecc4810d…): VerifyWire read 104 swaps in the pool and
 * answered wash_volume_pct null, wash_volume_status "not_measured", "wash
 * volume is not measured". The node's shaping still returned
 * wash_volume_pct 0 with field status ok, which the rules would have passed
 * as "Wash trading 0% of volume".
 */
const NOT_MEASURED = /\b(?:is|was|were|are) not (?:measured|quantified)\b/i;

export function notMeasured(...texts: unknown[]): string | null {
  return firstMatch(NOT_MEASURED, texts);
}

/**
 * Words any review uses whatever it is about. A token's deployer picks its
 * symbol and name, so a token called "Secure" or "Token" is not mentioned by
 * a generic answer that begins "Secure." or talks about "the token contract".
 */
const REVIEW_WORDS = new Set(['secure', 'insecure', 'needs changes', 'token', 'contract', 'coin', 'address', 'input', 'query', 'request', 'the', 'no', 'none']);

/**
 * How a security answer shows it is about this token: it names the token's
 * address, or its symbol or name as a whole word, spelled as the contract
 * reports it, or it reports scan facts (honeypot, taxes, holders), which come
 * only from scanning a deployed contract. Returns what it found, or null.
 *
 * Seen live (memo WOYbyG3x): "Secure. ... there are no injection vectors,
 * authentication, or exposure concerns present. No further issues
 * identified." That answer names no token at all. A generic answer like it
 * could pass for any token, so a "Secure" verdict or a clean scan clears a
 * token only when the answer refers to that token.
 */
export function mentionsToken(texts: unknown[], token: Pick<TokenFacts, 'address' | 'symbol' | 'name'>): string | null {
  const parts = texts.flatMap((t) => (typeof t === 'string' ? [t] : Array.isArray(t) ? t.map(String) : []));
  const all = parts.join('\n');
  if (all.toLowerCase().includes(token.address.toLowerCase())) return `its address ${token.address}`;
  for (const [what, word] of [['symbol', token.symbol], ['name', token.name]] as const) {
    const w = word?.trim();
    if (!w || w.length < 2 || REVIEW_WORDS.has(w.toLowerCase())) continue;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(all)) return `its ${what} "${w}"`;
  }
  for (const part of parts) {
    const f = summaryFacts(part);
    if (f.honeypot !== null || f.buyTax !== null || f.sellTax !== null || f.top10 !== null) return 'scan facts (honeypot, taxes, holders)';
  }
  return null;
}

function securityFindings(p: Purchase | undefined, token: TokenFacts): Finding[] {
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'security', 'Security review')];
  const examined = notExamined(p.fields.summary, p.fields.issues);
  if (examined) {
    // A blocking fact stated in the same answer (a honeypot, a 100% tax) still blocks.
    const blocking = securityFindingsFrom(p, p.fields, token).filter((x) => x.severity === 'block');
    return [...blocking, {
      rule: 'security.not_examined', severity: 'review', title: 'Security review did not examine the contract',
      detail: `The answer says "${examined}"${str(p.fields.verdict) ? ` yet gives the verdict "${str(p.fields.verdict)}"` : ''}, so it is no evidence about this contract either way.`,
      source: 'telegraph', evidence: ['security'],
    }];
  }
  return securityFindingsFrom(p, p.fields, token);
}

function securityFindingsFrom(p: Purchase, f: Record<string, unknown>, token: TokenFacts): Finding[] {
  const out: Finding[] = [];
  const verdict = str(f.verdict);
  const count = num(f.vulnerability_count);
  const summary = str(f.summary);
  const facts = summaryFacts(summary);
  const ev: PurchaseKey[] = ['security'];
  const about = mentionsToken([summary, f.issues], token);
  const notAbout = (claim: string): Finding => {
    const names = [token.symbol, token.name ? `"${token.name}"` : null, `the address ${token.address}`].filter((x): x is string => Boolean(x));
    const named = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
    return {
      rule: 'security.not_about_token', severity: 'review', title: 'The security review does not mention this token',
      detail: `The answer ${claim} but does not name ${named}, and reports no scan facts (honeypot, taxes, holders). An answer that could be about any contract is no evidence that this one is safe.`,
      source: 'telegraph', evidence: ev,
    };
  };

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

  // Clearing needs a positive basis about this token: a Secure verdict, or no
  // verdict but every scan fact present and clean, in an answer that refers to it.
  if (verdict === 'Secure') {
    out.push(about
      ? { rule: 'security.secure', severity: 'pass', title: 'Security review: secure', detail: summary ?? 'The security review judged the contract secure.', source: 'telegraph', evidence: ev }
      : notAbout('gives the verdict "Secure"'));
  } else if (verdict === null) {
    const complete = facts.honeypot !== null && facts.buyTax !== null && facts.sellTax !== null && facts.top10 !== null;
    if (!complete) {
      out.push({
        rule: 'security.no_verdict', severity: 'review', title: 'Security review gave no verdict',
        detail: `The review returned no verdict (field status: ${JSON.stringify(p.fieldStatus)}) and did not report every scan fact this desk needs (honeypot, buy and sell tax, holder concentration), so it cannot clear the token.`,
        source: 'telegraph', evidence: ev,
      });
    } else if (!out.some((x) => (x.severity === 'block' || x.severity === 'review') && x.rule !== 'security.holder_concentration')) {
      out.push(about
        ? {
          rule: 'security.scan_clean', severity: 'pass', title: 'Contract scan clean',
          detail: `No verdict field (status ${JSON.stringify(p.fieldStatus)}), so the decision rests on the scan facts reported: honeypot ${facts.honeypot}, buy tax ${pct(facts.buyTax!)}, sell tax ${pct(facts.sellTax!)}, top 10 holders ${pct(facts.top10!)}.`,
          source: 'telegraph', evidence: ev,
        }
        : notAbout('reports a clean scan'));
    }
  }
  return out;
}

export function supplyFindings(p: Purchase | undefined, facts: TokenFacts): Finding[] {
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
  const unmeasured = notMeasured(p.fields.summary);
  if (unmeasured) return [{ rule: 'wash.not_measured', severity: 'review', title: 'Wash-trading figure was not measured', detail: `The answer reports ${pct(share)}${verdict ? ` ("${verdict}")` : ''} but says "${unmeasured}", so the figure is not the provider's measurement and is no evidence either way.`, source: 'telegraph', evidence: ['wash'] }];
  if (share >= POLICY.washBlockPct) return [{ rule: 'wash.block', severity: 'block', title: `${pct(share)} of volume is wash trading`, detail: context, source: 'telegraph', evidence: ['wash'] }];
  if (share >= POLICY.washReviewPct) return [{ rule: 'wash.review', severity: 'review', title: `${pct(share)} of volume is wash trading`, detail: context, source: 'telegraph', evidence: ['wash'] }];
  return [{ rule: 'wash.ok', severity: 'pass', title: `Wash trading ${pct(share)} of volume`, detail: context, source: 'telegraph', evidence: ['wash'] }];
}

export function liquidityFindings(p: Purchase | undefined, req: PreflightRequest): Finding[] {
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

/** What the findings for one fact need besides its answer. */
export interface FactContext {
  req: PreflightRequest;
  facts: TokenFacts;
  treasuryRead: PreflightMemo['treasuryRead'];
  /** The findings for a fact this file has no rule for (a holding's balance, holdings.ts) */
  judge?: (p: Purchase) => Finding[];
  /** A desk with its own rules for every fact (settlement.ts): used instead of this file's */
  judgeAll?: (p: Purchase) => Finding[];
}

/** The findings one answer gives for its own fact. */
function factFindings(p: Purchase, ctx: FactContext): Finding[] {
  if (ctx.judgeAll) return ctx.judgeAll(p);
  switch (p.key) {
    case 'security': return securityFindings(p, ctx.facts);
    case 'supply': return supplyFindings(p, ctx.facts);
    case 'wash': return washFindings(p);
    case 'liquidity': return liquidityFindings(p, ctx.req);
    case 'sanctions': return sanctionsFindings(p, ctx.req.issuer ?? '');
    case 'treasury': return treasuryFindings(p, ctx.treasuryRead, ctx.req.treasury !== undefined);
    case 'balance': return ctx.judge ? ctx.judge(p) : [unavailable(p, 'balance', 'Wallet balance')];
    case 'registry': return [unavailable(p, 'registry', 'Corporate registry')];
  }
}

/** Findings that say an answer is no evidence about its fact: not answered, no figure, nothing examined, not about this token. */
const NO_EVIDENCE: ReadonlySet<string> = new Set([
  'security.unavailable', 'security.not_examined', 'security.not_about_token', 'security.no_verdict',
  'supply.unavailable', 'supply.missing',
  'wash.unavailable', 'wash.missing', 'wash.not_examined', 'wash.not_measured',
  'liquidity.unavailable', 'liquidity.missing',
  'sanctions.unavailable', 'sanctions.uncertain',
  'treasury.unavailable', 'treasury.missing',
  'balance.unavailable', 'balance.missing', 'balance.not_about_wallet',
  'registry.unavailable', 'registry.missing', 'registry.other_entity',
]);

/**
 * The finding that makes an answer no evidence about its fact, or null when
 * it is evidence. An answer is no evidence only when all it gives is of that
 * kind. One that also holds the token back in its own right (a honeypot, a
 * blocking issue, a tax) is evidence, so it is never set aside for another.
 */
export function noEvidence(p: Purchase, ctx: FactContext): Finding | null {
  const own = factFindings(p, ctx);
  if (own.some((f) => f.severity !== 'info' && !NO_EVIDENCE.has(f.rule))) return null;
  return own.find((f) => NO_EVIDENCE.has(f.rule)) ?? null;
}

/** An info finding per second opinion: from whom, why, and what came of it. Never changes the decision. */
function secondOpinionFindings(p: Purchase | undefined): Finding[] {
  const so = p?.secondOpinion;
  if (!p || !so) return [];
  const first = so.first.minerId ? `miner ${so.first.minerId}${so.first.minerName ? ` (${so.first.minerName})` : ''}` : 'the routed ask';
  const pinned = so.miner ? ` from the next-best ranked miner, ${so.miner.id} (${so.miner.name}), ranked ${so.miner.rank} with score ${so.miner.score} in epoch ${so.miner.epoch}` : '';
  const hashes = [so.first.signalHash ? `first ${so.first.signalHash}` : null, so.second?.signalHash ? `second ${so.second.signalHash}` : null].filter(Boolean).join(', ');
  return [{
    rule: `${p.key}.second_opinion`,
    severity: 'info',
    title: so.used ? `Second opinion used: ${so.miner?.name ?? '-'}` : so.second ? `Second opinion not used: ${so.miner?.name ?? '-'}` : 'No second opinion could be asked',
    detail: `The first answer, from ${first}, was no evidence. ${so.reason} Second opinion${pinned}: ${so.outcome}.${hashes ? ` Signals: ${hashes}.` : ''}`,
    source: 'telegraph',
    evidence: [p.key],
  }];
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
  const security = securityFindings(by('security'), facts);
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
    ...purchases.flatMap((p) => secondOpinionFindings(p)),
  ];
  if (findings.some((f) => f.severity === 'block')) return { findings, decision: 'REJECT', decisionRule: 'any blocking finding rejects' };
  if (findings.some((f) => f.severity === 'review')) return { findings, decision: 'REVIEW', decisionRule: 'no blocking finding, but at least one finding needs a person' };
  return { findings, decision: req.mode === 'trade' ? 'HOLD' : 'LIST', decisionRule: 'every check answered and none raised a finding' };
}

// ---------------------------------------------------------------------------
// Purchases: one routed request per fact, a second opinion when it is no
// evidence, reused while fresh
// ---------------------------------------------------------------------------

/** Escrow the node holds per routed ask while it runs (it bills about $0.01 of it). */
export const HOLD_PER_ASK_USD = 0.26;
/** What a routed ask is billed: the one miner call it routes (engine route, 2026-11-21) */
export const ROUTED_ASK_USD = 0.01;
const REUSE_TTL_MS = Number(process.env.SHIELD_REUSE_TTL_MS) > 0 ? Number(process.env.SHIELD_REUSE_TTL_MS) : 10 * 60_000;

export function budgetUsd(): number {
  const n = Number(process.env.SHIELD_PREFLIGHT_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.1;
}

/** The decision's budget: what is committed so far, and room for a second opinion. */
export class Spend {
  constructor(readonly budgetUsd: number, public committedUsd = 0) {}
  /** Commit `usd` if it fits in the budget. */
  take(usd: number): boolean {
    if (this.committedUsd + usd > this.budgetUsd + 1e-9) return false;
    this.committedUsd += usd;
    return true;
  }
  /** Correct an estimate by what was really billed. */
  adjust(deltaUsd: number): void {
    this.committedUsd += deltaUsd;
  }
  /**
   * Settle an ask committed at `estimateUsd`. A reply says what was billed (its
   * receipt, or the envelope's cost). An ask that ended without one, at Shield's
   * timeout or a gateway 504, keeps its estimate: the node can still answer and
   * bill it (2026-11-21: $0.26 left the escrow while the receipts showed $0.09).
   * A refused request was never charged.
   */
  settle(estimateUsd: number, a: Pick<TypedAnswer, 'ok' | 'costUsd' | 'receipt' | 'refused'>): void {
    if (a.receipt || a.ok || a.costUsd !== undefined) this.adjust((a.costUsd ?? 0) - estimateUsd);
    else if (a.refused) this.adjust(-estimateUsd);
  }
}

/** What a second opinion is asked through: the live node, or stubs in tests. */
export interface OpinionDeps {
  ranking(intent: string): Promise<IntentRanking>;
  askPinned(minerId: string, intent: string, params: Record<string, unknown>): Promise<TypedAnswer>;
}

const LIVE_OPINION: OpinionDeps = { ranking: intentRanking, askPinned: askPinnedIntent };

const roundUsd = (n: number): number => Number(n.toFixed(6));

export function answerOf(a: TypedAnswer): Answer {
  const out: Answer = { ok: a.ok, fields: a.fields, fieldStatus: a.fieldStatus, costUsd: a.costUsd ?? 0, latencyMs: a.latencyMs };
  if (a.minerId) out.minerId = a.minerId;
  if (a.minerName) out.minerName = a.minerName;
  if (a.signalHash) out.signalHash = a.signalHash;
  if (a.receipt) out.receipt = a.receipt;
  if (a.servedRank !== undefined) out.servedRank = a.servedRank;
  if (a.error) out.error = a.error;
  return out;
}

/**
 * The next-best miner for a second opinion: the best-ranked one, other than
 * the miner that gave the first answer, whose answers scored above 0 in the
 * epoch. A score of 0 means the node's evaluation found nothing right in its
 * answers that epoch, which is no better opinion.
 */
export function nextBestMiner(ranking: IntentRanking, answeredBy: string | undefined): { miner: RankedMiner } | { miner: null; why: string } {
  if (ranking.epoch === null) return { miner: null, why: ranking.error ?? `the node ranks no miner for ${ranking.intent}` };
  const other = ranking.miners.filter((m) => m.minerId !== answeredBy && m.slug !== answeredBy);
  const best = other.find((m) => m.score > 0);
  if (!best) return { miner: null, why: `no other active miner scored above 0 for ${ranking.intent} in epoch ${ranking.epoch}` };
  return { miner: best };
}

export type Planned = { key: PurchaseKey; intent: string; params: Record<string, unknown>; question: string; holding?: number };
/** A fact as bought, before it is marked reused or not. */
type Resolved = Omit<Purchase, 'reused' | 'boughtAt'>;

/**
 * The first answer to a fact, or a second opinion in its place. When the
 * routed answer is no evidence (it did not answer, carried no figure,
 * examined nothing, or is not about this token), one more ask goes to the
 * next-best miner on the node's leaderboard for the intent, pinned so the
 * node cannot route it back to the same miner. Its answer is used only if it
 * is evidence. Never more than one extra answer per fact, only within the
 * decision's budget, and never when the request itself was refused.
 */
export async function withSecondOpinion(plan: Omit<Planned, 'question'>, firstAsk: TypedAnswer, ctx: FactContext & { spend: Spend }, deps: OpinionDeps = LIVE_OPINION): Promise<Resolved> {
  const { key, intent, params } = plan;
  const first = answerOf(firstAsk);
  const resolved = (a: Answer, extra?: Pick<Resolved, 'secondOpinion' | 'costUsd' | 'latencyMs'>): Resolved => ({ key, intent, params, ...a, ...extra });
  const lacking = firstAsk.refused ? null : noEvidence({ ...resolved(first), reused: false, boughtAt: '' }, ctx);
  if (!lacking) return resolved(first);

  const so: SecondOpinion = { reason: lacking.detail, reasonRule: lacking.rule, miner: null, used: false, outcome: '', first, second: null };
  const done = (): Resolved => {
    const second = so.second;
    const used = so.used && second ? second : first;
    return resolved(used, { secondOpinion: so, costUsd: roundUsd(first.costUsd + (second?.costUsd ?? 0)), latencyMs: first.latencyMs + (second?.latencyMs ?? 0) });
  };

  let ranking: IntentRanking;
  try {
    ranking = await deps.ranking(intent);
  } catch (err) {
    ranking = { intent, epoch: null, miners: [], error: `could not read the ranking: ${err instanceof Error ? err.message : String(err)}` };
  }
  const pick = nextBestMiner(ranking, first.minerId);
  if (!pick.miner) {
    so.outcome = `not asked: ${pick.why}`;
    return done();
  }
  const m = pick.miner;
  so.miner = { id: m.minerId, slug: m.slug, name: m.name, rank: m.rank, score: m.score, epoch: ranking.epoch!, priceUsd: m.priceUsd };
  if (!ctx.spend.take(m.priceUsd)) {
    so.outcome = `not asked: its price, $${m.priceUsd}, does not fit in what is left of the $${ctx.spend.budgetUsd.toFixed(2)} budget per decision`;
    return done();
  }
  let pinned: TypedAnswer;
  try {
    pinned = await deps.askPinned(m.minerId, intent, params);
  } catch (err) {
    pinned = { intent, params, ok: false, fields: null, fieldStatus: {}, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const second = answerOf(pinned);
  ctx.spend.settle(m.priceUsd, pinned);
  so.second = second;
  const secondLacking = noEvidence({ ...resolved(second), reused: false, boughtAt: '' }, ctx);
  // A second opinion may make a decision stricter, never clear a token by itself:
  // when the ranked miner did answer (but gave no evidence), a clean pinned answer
  // is recorded and not used. It is used when the first ask got no answer at all,
  // or when it holds the token back in its own right.
  const secondHolds = factFindings({ ...resolved(second), reused: false, boughtAt: '' }, ctx).some((f) => f.severity === 'review' || f.severity === 'block');
  const firstAnswered = firstAsk.ok;
  so.used = secondLacking === null && (!firstAnswered || secondHolds);
  if (secondLacking === null && !so.used) {
    so.outcome = 'not used: a second opinion may hold a token back but never clear one whose ranked answer examined nothing';
    return done();
  }
  if (so.used) {
    const gives = factFindings({ ...resolved(second), reused: false, boughtAt: '' }, ctx).filter((f) => f.severity !== 'info').map((f) => f.title);
    so.outcome = `used: it is evidence (${gives.join('; ')})`;
  } else {
    so.outcome = `not used: it is no evidence either (${secondLacking!.title}${second.error ? `; ${second.error}` : ''})`;
  }
  return done();
}

const fresh = new Map<string, { at: number; fact: Promise<Resolved> }>();

function cacheKey(intent: string, params: Record<string, unknown>): string {
  return `${intent} ${JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))}`;
}

/**
 * Ask once, with a second opinion when the answer is no evidence. A fact
 * already bought (or in flight) in the last REUSE_TTL_MS is reused whole,
 * second opinion and all, so a repeat never pays for either again.
 */
export async function buy(plan: Planned, ctx: FactContext & { spend: Spend }, opts: { noReuse?: boolean } = {}): Promise<Purchase> {
  const ck = cacheKey(plan.intent, plan.params);
  const now = Date.now();
  const hit = fresh.get(ck);
  // An independent check (work verification) buys its own answer instead of reusing the one being checked
  const reused = !opts.noReuse && hit !== undefined && now - hit.at < REUSE_TTL_MS;
  let entry = hit;
  if (reused) {
    ctx.spend.adjust(-ROUTED_ASK_USD); // nothing is bought for this fact in this decision
  } else {
    entry = {
      at: now,
      fact: (async () => {
        const first = await askTypedIntent(plan.intent, plan.params, plan.question);
        ctx.spend.settle(ROUTED_ASK_USD, first);
        return withSecondOpinion(plan, first, ctx);
      })(),
    };
    fresh.set(ck, entry);
  }
  const fact = await entry!.fact;
  if (!fact.ok && fresh.get(ck) === entry) fresh.delete(ck); // never reuse a failure
  const out: Purchase = { ...fact, costUsd: reused ? 0 : fact.costUsd, latencyMs: reused ? 0 : fact.latencyMs, reused, boughtAt: new Date(entry!.at).toISOString() };
  if (plan.holding !== undefined) out.holding = plan.holding;
  return out;
}

/**
 * What a decision cost and how many asks it made. A fact with a second
 * opinion counts both asks; a reused fact counts none.
 */
export function memoCost(purchases: Purchase[]): Pick<PreflightMemo['cost'], 'telegraphUsd' | 'paidRequests' | 'reusedRequests' | 'failedRequests' | 'secondOpinions'> {
  const bought = purchases.filter((p) => !p.reused);
  const asks: Answer[] = bought.flatMap((p) => (p.secondOpinion ? [p.secondOpinion.first, ...(p.secondOpinion.second ? [p.secondOpinion.second] : [])] : [p]));
  return {
    telegraphUsd: roundUsd(purchases.reduce((s, p) => s + p.costUsd, 0)),
    paidRequests: asks.filter((a) => a.ok).length,
    reusedRequests: purchases.length - bought.length,
    failedRequests: asks.filter((a) => !a.ok).length,
    secondOpinions: bought.filter((p) => p.secondOpinion?.second).length,
  };
}

/** Run tasks with at most `limit` in flight. */
export async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number, onDone: (r: T) => void): Promise<T[]> {
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
  const expected = plan.length * ROUTED_ASK_USD;
  if (plan.length > 0 && expected > budget) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `This review would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per decision. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0 && escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds for each ask while it runs. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0) {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    // The routed asks are committed up front; second opinions take what is left of the budget.
    const ctx = { req, facts, treasuryRead, spend: new Spend(budget, expected) };
    purchases = await pooled(plan.map((p) => () => buy(p, ctx)), parallel, (p) => events.onPurchase?.(p));
  }

  const judged = evaluate(req, facts, purchases, treasuryRead);
  const findings = [...policyFindings, ...judged.findings];
  let decision = judged.decision;
  let decisionRule = judged.decisionRule;
  if (policyFindings.length > 0 && decision !== 'REJECT') {
    decision = 'REVIEW';
    decisionRule = 'the checks could not be bought, so nothing can clear the token';
  }

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
      routing: 'one routed ask per fact (POST /engine/ask with intent and params, paid from escrow); the node picks its ranked miner and returns a payment receipt. When that answer is no evidence, at most one more ask per fact, pinned to the next-best miner on the node leaderboard (POST /engine/ask/{minerId}), within the budget',
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
      ...memoCost(purchases),
      budgetUsd: budget,
      escrowBeforeUsd: escrow,
    },
    latencyMs: Date.now() - started,
    policy: POLICY,
  };
}
