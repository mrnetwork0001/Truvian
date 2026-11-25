/**
 * Truvian Resolve: independent prediction-market resolution.
 *
 * A market (a Kalshi ticker, a Polymarket market id, or a question with its
 * resolution rule and close time) is read from its venue's free public API.
 * Its outcome is then bought from up to three independent Telegraph miners
 * serving EVENT_OUTCOME_RESOLUTION_GENERAL: the node's routed pick, plus up to
 * two specialists pinned by id. Miners that read the same venue's own result
 * are left out, since they would only echo the market. Each answer is judged
 * on what it shows (an outcome, a settlement date, sources), the answers are
 * compared with each other and with the venue's settlement, and the decision
 * is one of:
 *
 *   TOO_EARLY  the market has not closed and is not settled: nothing is bought
 *   RESOLVED   at least two independent sourced answers agree, and they agree
 *              with the venue's settlement when there is one
 *   DISPUTED   sourced answers disagree with each other, or with the venue's
 *              settlement
 *   REVIEW     fewer than two sourced answers: no decision either way
 *
 * The decision is written in a memo signed like every Shield memo (EIP-191 over
 * sha256 of canonical JSON) and its digest is anchored on Solana devnet with
 * the SPL Memo program (./solanaAnchor.ts).
 *
 * Node format, read 2026-11-25 (GET /engine/v1/intents/EVENT_OUTCOME_RESOLUTION):
 * request {event: string, max 256 bytes}; response {event, outcome: yes|no|
 * unresolved, resolved_yes: bool (the scored field), winner, resolved_at,
 * sources: list}.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { askPinnedIntent, askTypedIntent, intentRanking, type IntentRanking, type PaymentReceipt, type TypedAnswer } from './telegraph.js';
import { signAnyMemo } from './memo.js';
import { anchorDigest, type SolanaAnchor } from './solanaAnchor.js';

export const RESOLVE_INTENT = 'EVENT_OUTCOME_RESOLUTION_GENERAL';
const NODE_URL = (process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com').replace(/\/+$/, '');
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 20_000;

export const RESOLVE_POLICY = {
  /** Readable answers wanted per decision: the routed one and two pinned */
  maxAnswers: 3,
  /** Sourced answers that must agree before RESOLVED */
  minAgreeing: 2,
  /** Highest price per pinned answer, USD */
  maxPinnedPriceUsd: 0.02,
  /** Most pinned asks tried, counting ones the node could not build */
  maxPinnedAttempts: 8,
  /** Most billed pinned asks, readable or not: with the routed one, at most $0.04 a decision */
  maxPinnedBilled: 3,
  /** Most pinned asks tried per operator, so one operator's many miners cannot use up the attempts */
  maxAttemptsPerOperator: 3,
  /** The node's limit on the event string */
  maxEventBytes: 256,
} as const;

export type MarketSource = 'kalshi' | 'polymarket' | 'manual';
export type ResolveDecision = 'RESOLVED' | 'DISPUTED' | 'TOO_EARLY' | 'REVIEW';
export type Outcome = 'yes' | 'no';

export class ResolveInputError extends Error {}
export class MarketReadError extends Error {}

export interface ResolveRequest {
  source: MarketSource;
  /** Kalshi market ticker or Polymarket market id/slug (not for manual) */
  market?: string;
  /** Manual only: the question, its resolution rule and close time */
  question?: string;
  rules?: string;
  closeTime?: string;
  /** Optional override for the event text sent to miners */
  event?: string;
}

export interface MarketRead {
  source: MarketSource;
  id: string;
  url: string | null;
  question: string;
  rules: string;
  closeTime: string | null;
  /** The venue's own status word, as it reports it */
  status: string;
  /** The venue's settled outcome, when it has settled */
  settled: Outcome | null;
  settledAt: string | null;
  /** The text sent to miners as `event` */
  event: string;
}

export type AnswerVerdict = 'decisive' | 'unsupported' | 'abstained' | 'inconsistent' | 'failed' | 'duplicate';

export interface ResolveAnswer {
  route: 'routed' | 'pinned';
  minerId: string | null;
  minerName: string | null;
  /** The node's rank and score for this miner on the intent, in `epoch` */
  rank: number | null;
  score: number | null;
  ok: boolean;
  outcome: string | null;
  resolvedYes: boolean | null;
  resolvedAt: string | null;
  winner: string | null;
  sources: string[];
  verdict: AnswerVerdict;
  why: string;
  costUsd: number;
  latencyMs: number;
  signalHash: string | null;
  receipt: PaymentReceipt | null;
  error: string | null;
}

export interface ResolveFinding {
  rule: string;
  severity: 'block' | 'review' | 'info' | 'pass';
  title: string;
  detail: string;
}

export interface ResolveMemo {
  version: 1;
  kind: 'market-resolution';
  createdAt: string;
  input: ResolveRequest;
  market: MarketRead;
  intent: string;
  /** Which miners were asked and why (the node's epoch, exclusions) */
  selection: { epoch: number | null; routedTop: Selection['routedTop']; attempts: PinnedAttempt[]; excluded: { slug: string; why: string }[]; note: string | null };
  answers: ResolveAnswer[];
  findings: ResolveFinding[];
  decision: ResolveDecision;
  decisionRule: string;
  /** The outcome Resolve stands behind, only when RESOLVED */
  outcome: Outcome | null;
  policy: typeof RESOLVE_POLICY;
  cost: { telegraphUsd: number; paidRequests: number; failedRequests: number };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function normalizeResolveRequest(raw: Record<string, unknown>): ResolveRequest {
  const source = String(raw.source ?? '').trim().toLowerCase();
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const event = str(raw.event);
  if (event && Buffer.byteLength(event, 'utf8') > RESOLVE_POLICY.maxEventBytes) throw new ResolveInputError(`event must be at most ${RESOLVE_POLICY.maxEventBytes} bytes`);
  if (source === 'kalshi' || source === 'polymarket') {
    const market = str(raw.market);
    if (!market) throw new ResolveInputError(`market is required: a ${source === 'kalshi' ? 'Kalshi market ticker, e.g. KXNBAGAME-26NOV24DALDEN-DAL' : 'Polymarket market id or slug'}`);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(market)) throw new ResolveInputError('market must be a ticker, id or slug (letters, digits, . _ -)');
    return { source, market, ...(event ? { event } : {}) };
  }
  if (source === 'manual') {
    const question = str(raw.question);
    const closeTime = str(raw.closeTime);
    if (!question) throw new ResolveInputError('question is required for a manual market');
    if (!closeTime || Number.isNaN(Date.parse(closeTime))) throw new ResolveInputError('closeTime is required for a manual market, as an ISO 8601 date or time');
    const rules = str(raw.rules);
    return { source, question, closeTime: new Date(closeTime).toISOString(), ...(rules ? { rules } : {}), ...(event ? { event } : {}) };
  }
  throw new ResolveInputError('source must be "kalshi", "polymarket" or "manual"');
}

/** Cut text to the node's byte limit at a word boundary. */
export function fitEvent(text: string, maxBytes: number = RESOLVE_POLICY.maxEventBytes): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean;
  let out = '';
  for (const word of clean.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (Buffer.byteLength(`${next}…`, 'utf8') > maxBytes) break;
    out = next;
  }
  return `${out}…`;
}

/**
 * The proposition a market resolves on, asked as a settled question, which is
 * how the resolvers on the node take it (TradeWire's: "Winner questions and
 * explicit Did X win questions are supported"; on 2026-11-25 two of them
 * refused "Donald J. Trump wins the 2024 US Presidential Election?" and
 * answered "Did Donald Trump win the 2024 US Presidential Election?"):
 *  - a "Will X ...?" question becomes "Did X ...?";
 *  - else the venue's "resolves to Yes if <X>" clause, with "<A> wins <B>"
 *    turned into "Did <A> win <B>";
 *  - else the question as written.
 * A proposition without a year carries the market's close date.
 */
export function eventFromRules(question: string, rules: string, closeTime: string | null = null): string {
  const q = question.trim().replace(/\?\s*$/, '');
  let text: string;
  const will = /^Will\s+(.+)$/i.exec(q);
  if (will) {
    text = `Did ${will[1]}`;
  } else {
    const kalshi = /^If (.+?),? then the market resolves to Yes\.?/i.exec(rules.trim());
    // A sentence ends at a period that does not close an initial ("Donald J. Trump").
    const poly = /resolve to ["“”]?Yes["“”]? if (.+?)(?<!\b[A-Z])\.(\s|$)/i.exec(rules);
    const found = kalshi?.[1] ?? poly?.[1];
    const clause = found && found.trim().split(/\s+/).length >= 3 ? found.trim() : undefined;
    const wins = clause ? /^(.+?)\s+wins?\s+(.+)$/i.exec(clause) : null;
    text = wins ? `Did ${wins[1]} win ${wins[2]}` : clause ? `${clause.charAt(0).toUpperCase()}${clause.slice(1)}` : q;
  }
  // Resolvers match an event by its year (2026-11-25: three refused "The
  // Philadelphia Eagles win Super Bowl LIX?" and one answered once the date was
  // added), so a proposition without a year carries the market's close date.
  const dated = /\b(19|20)\d{2}\b/.test(text) || !closeTime || Number.isNaN(Date.parse(closeTime)) ? text : `${text} (${longDate(closeTime)})`;
  return fitEvent(`${dated}?`);
}

/** "February 9, 2025", in UTC. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Market reads (free public APIs)
// ---------------------------------------------------------------------------

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status === 404) throw new MarketReadError(`no such market (404 from ${new URL(url).host})`);
  if (!res.ok) throw new MarketReadError(`http ${res.status} from ${url}`);
  return res.json();
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function kalshiMarketRead(market: Record<string, unknown>, event: Record<string, unknown> | null, override?: string): MarketRead {
  const ticker = s(market.ticker);
  const rules = [s(market.rules_primary), s(market.rules_secondary)].filter(Boolean).join(' ');
  const eventTitle = s(event?.title);
  const question = eventTitle ? `${eventTitle}: ${s(market.title)}` : s(market.title);
  const result = s(market.result).toLowerCase();
  const settled: Outcome | null = result === 'yes' || result === 'no' ? result : null;
  return {
    source: 'kalshi',
    id: ticker,
    url: `${KALSHI_API}/markets/${ticker}`,
    question,
    rules,
    closeTime: s(market.close_time) || null,
    status: s(market.status) || 'unknown',
    settled,
    settledAt: settled ? s(market.settlement_ts) || null : null,
    // The market's own title ("Will the Federal Reserve ...?", "Dallas wins"),
    // not the event's prefix, decides the phrasing.
    event: override ?? eventFromRules(s(market.title), s(market.rules_primary), s(market.close_time) || null),
  };
}

export function polymarketMarketRead(m: Record<string, unknown>, override?: string): MarketRead {
  const parse = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(s(v)); return Array.isArray(p) ? p : []; } catch { return []; }
  };
  const outcomes = parse(m.outcomes).map((x) => String(x).toLowerCase());
  const prices = parse(m.outcomePrices).map((x) => String(x));
  if (!(outcomes.length === 2 && outcomes[0] === 'yes' && outcomes[1] === 'no')) {
    throw new MarketReadError(`only Yes/No markets can be resolved; this one's outcomes are ${JSON.stringify(outcomes)}`);
  }
  const uma = s(m.umaResolutionStatus);
  const closed = m.closed === true;
  let settled: Outcome | null = null;
  if (closed && uma === 'resolved') settled = prices[0] === '1' ? 'yes' : prices[1] === '1' ? 'no' : null;
  const question = s(m.question);
  const rules = s(m.description);
  const end = s(m.endDate);
  return {
    source: 'polymarket',
    id: String(m.id ?? ''),
    url: `${POLYMARKET_API}/markets/${String(m.id ?? '')}`,
    question,
    rules,
    closeTime: end || null,
    status: `${closed ? 'closed' : 'open'}${uma ? `, UMA ${uma}` : ''}`,
    settled,
    settledAt: settled ? s(m.closedTime) || null : null,
    event: override ?? eventFromRules(question, rules, end || null),
  };
}

export async function readMarket(req: ResolveRequest): Promise<MarketRead> {
  if (req.source === 'kalshi') {
    const body = asObj(await getJson(`${KALSHI_API}/markets/${encodeURIComponent(req.market!)}`));
    const market = asObj(body.market);
    if (!s(market.ticker)) throw new MarketReadError('Kalshi returned no market for that ticker');
    let event: Record<string, unknown> | null = null;
    if (s(market.event_ticker)) {
      try { event = asObj(asObj(await getJson(`${KALSHI_API}/events/${encodeURIComponent(s(market.event_ticker))}`)).event); } catch { event = null; }
    }
    return kalshiMarketRead(market, event, req.event);
  }
  if (req.source === 'polymarket') {
    const byId = /^\d+$/.test(req.market!);
    const body = await getJson(byId ? `${POLYMARKET_API}/markets/${req.market}` : `${POLYMARKET_API}/markets?slug=${encodeURIComponent(req.market!)}`);
    const m = Array.isArray(body) ? asObj(body[0]) : asObj(body);
    if (!s(m.question)) throw new MarketReadError('Polymarket returned no market for that id or slug');
    return polymarketMarketRead(m, req.event);
  }
  const question = req.question!;
  const rules = req.rules ?? '';
  return {
    source: 'manual', id: 'manual', url: null, question, rules, closeTime: req.closeTime ?? null,
    status: 'manual: no venue settlement', settled: null, settledAt: null,
    event: req.event ?? eventFromRules(question, rules, req.closeTime ?? null),
  };
}

// ---------------------------------------------------------------------------
// Miner selection
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  wallet_address?: unknown;
  activation_status?: unknown;
  min_price_usdc?: unknown;
  input_schema?: unknown;
  signal_mapping?: unknown;
}

/**
 * How a pinned ask with {event} can reach a miner: its own input names
 * `event` ("explicit"), or it declares no input at all, so the node may pass
 * the event through ("open", tried after the explicit ones). Any other input
 * (a ticker, dates, an id) cannot be built from an event: "no".
 */
export function takesEvent(entry: CatalogEntry | undefined): 'explicit' | 'open' | 'no' {
  const props = asObj(asObj(entry?.input_schema).properties);
  if ('event' in props) return 'explicit';
  return Object.keys(props).length === 0 ? 'open' : 'no';
}

const STOP = new Set(['will', 'with', 'that', 'this', 'from', 'have', 'their', 'there', 'what', 'when', 'which', 'market', 'resolves', 'resolve', 'originally', 'scheduled', 'game', 'between', 'before', 'after', 'does']);

/**
 * Words of the event a miner's description also uses, plus 2 when it says it
 * resolves events, minus 2 for a generalist that describes itself by how many
 * intents it serves: a specialist is asked first.
 */
export function relevance(event: string, description: string): number {
  const d = description.toLowerCase();
  const words = new Set(event.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []);
  let n = 0;
  for (const w of words) if (!STOP.has(w) && d.includes(w)) n++;
  const generalist = /\b(serving|covering|across|for) \d+ (telegraph )?intents\b/.test(d);
  return n + (/resolv|outcome/.test(d) ? 2 : 0) - (generalist ? 2 : 0);
}

/** A miner that reads the market's own venue only echoes its settlement. */
export function readsVenue(slug: string, source: MarketSource): boolean {
  if (source === 'kalshi') return /kalshi/i.test(slug);
  if (source === 'polymarket') return /(^|-)poly/i.test(slug);
  return false;
}

export interface Candidate { minerId: string; slug: string; name: string; operator: string; rank: number; score: number; priceUsd: number; input: 'explicit' | 'open'; relevance: number }

export interface PinnedAttempt { minerId: string; slug: string; outcome: string }

export interface Selection {
  epoch: number | null;
  /** The node's top-ranked miner, which the routed ask is expected to reach, and its operator */
  routedTop: { slug: string; operator: string } | null;
  /** Pinned candidates in the order they are tried */
  candidates: Candidate[];
  excluded: { slug: string; why: string }[];
  note: string | null;
}

/**
 * The pinned candidates, in the order to try them. Independence first: a
 * miner run by the same operator (catalog wallet) as the node's top-ranked
 * miner, which the routed ask reaches, is not a second opinion, and miners
 * that read the market's own venue only echo it; both are left out. Then
 * miners whose input names `event`, then the most relevant to the event by
 * their own description, then score, then rank. runResolve takes at most one
 * answer per operator.
 */
export function selectPinned(ranking: IntentRanking, catalog: CatalogEntry[], source: MarketSource, event: string): Selection {
  const sel: Selection = { epoch: ranking.epoch, routedTop: null, candidates: [], excluded: [], note: null };
  if (ranking.epoch === null || ranking.miners.length === 0) {
    sel.note = ranking.error ?? `the node ranks no miner for ${RESOLVE_INTENT}`;
    return sel;
  }
  const byId = new Map<string, CatalogEntry>();
  for (const c of catalog) if (typeof c.id === 'string') byId.set(c.id, c);
  const operatorOf = (id: string) => s(byId.get(id)?.wallet_address).toLowerCase() || `miner:${id}`;
  const [top, ...rest] = ranking.miners;
  if (top) sel.routedTop = { slug: top.slug, operator: operatorOf(top.minerId) };
  for (const m of rest) {
    const entry = byId.get(m.minerId);
    const operator = operatorOf(m.minerId);
    if (readsVenue(m.slug, source)) { sel.excluded.push({ slug: m.slug, why: `reads ${source} itself, so it would echo the market` }); continue; }
    if (sel.routedTop && operator === sel.routedTop.operator) { sel.excluded.push({ slug: m.slug, why: `same operator as ${sel.routedTop.slug}, which the routed ask reaches` }); continue; }
    const input = takesEvent(entry);
    if (input === 'no') continue;
    // A pass-through of a public API that labels its signal by a raw `events`
    // list returns that list, not a resolved outcome (2026-11-25:
    // event-openligadb-bl1 was billed three times for answer_unreadable).
    if (input === 'open' && s(asObj(entry?.signal_mapping).label_field) === 'events') { sel.excluded.push({ slug: m.slug, why: 'takes no event and returns a raw list of events, not an outcome' }); continue; }
    if (m.priceUsd > RESOLVE_POLICY.maxPinnedPriceUsd) continue;
    sel.candidates.push({ minerId: m.minerId, slug: m.slug, name: m.name, operator, rank: m.rank, score: m.score, priceUsd: m.priceUsd, input, relevance: relevance(event, s(entry?.description)) });
  }
  sel.candidates.sort((a, b) => (a.input === b.input ? 0 : a.input === 'explicit' ? -1 : 1) || b.relevance - a.relevance || b.score - a.score || a.rank - b.rank);
  return sel;
}

// ---------------------------------------------------------------------------
// Judging answers and deciding
// ---------------------------------------------------------------------------

function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  return [];
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const t = v.trim().toLowerCase(); if (['true', 'yes', '1'].includes(t)) return true; if (['false', 'no', '0'].includes(t)) return false; }
  return null;
}

/**
 * For a "<X> wins ..." event with no negation: an answer naming X the winner
 * cannot also say NO (2026-11-25: the node's top-ranked miner answered NO to
 * "Donald J. Trump wins the 2024 US Presidential Election?" with winner
 * "Donald J. Trump", citing a 2026 midterm page).
 */
export function winnerContradicts(event: string, winner: string, outcome: 'yes' | 'no'): boolean {
  if (outcome !== 'no') return false;
  const e = event.toLowerCase();
  if (!/\b(wins?|won)\b/.test(e) || /\bnot\b|n't\b|\bfail/.test(e)) return false;
  const subject = e.split(/\b(?:wins?|won)\b/)[0]!;
  const tokens = winner.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
  const last = tokens[tokens.length - 1];
  return last !== undefined && new RegExp(`\\b${last}\\b`).test(subject);
}

/**
 * What one answer is worth as evidence:
 *  failed        no answer the node could read
 *  abstained     outcome "unresolved" (or none): the miner declined, fairly
 *  inconsistent  outcome and resolved_yes say opposite things, or the answer
 *                names the event's own subject as winner and still says NO
 *  unsupported   a yes/no with no source, or none whose link names the event
 *  decisive      a yes/no with at least one source on the event
 * (resolved_at is reported, not required: correct answers with good sources
 * leave it out, 2026-11-25.)
 */
export function judgeAnswer(a: TypedAnswer, route: 'routed' | 'pinned', rankInfo: { rank: number | null; score: number | null }): ResolveAnswer {
  const f = a.fields ?? {};
  const outcomeRaw = typeof f.outcome === 'string' ? f.outcome.trim().toLowerCase() : null;
  const resolvedYes = boolOf(f.resolved_yes);
  const resolvedAt = typeof f.resolved_at === 'string' && f.resolved_at.trim() !== '' ? f.resolved_at.trim() : null;
  const winner = typeof f.winner === 'string' && f.winner.trim() !== '' ? f.winner.trim() : null;
  const sources = listOf(f.sources);
  const base: ResolveAnswer = {
    route, minerId: a.minerId ?? null, minerName: a.minerName ?? null, rank: rankInfo.rank, score: rankInfo.score,
    ok: a.ok, outcome: outcomeRaw, resolvedYes, resolvedAt, winner, sources, verdict: 'failed', why: '',
    costUsd: a.costUsd ?? 0, latencyMs: a.latencyMs, signalHash: a.signalHash ?? null, receipt: a.receipt ?? null, error: a.error ?? null,
  };
  if (!a.ok) return { ...base, verdict: 'failed', why: a.error ?? 'no answer' };
  if (outcomeRaw !== 'yes' && outcomeRaw !== 'no') return { ...base, verdict: 'abstained', why: `outcome ${outcomeRaw ?? 'missing'}: the miner did not resolve it` };
  if (resolvedYes !== null && resolvedYes !== (outcomeRaw === 'yes')) return { ...base, verdict: 'inconsistent', why: `outcome ${outcomeRaw} but resolved_yes ${resolvedYes}` };
  const event = typeof a.params.event === 'string' ? a.params.event : '';
  if (winner && winnerContradicts(event, winner, outcomeRaw)) {
    return { ...base, verdict: 'inconsistent', why: `names ${winner}, the event's own subject, as the winner, yet answers ${outcomeRaw.toUpperCase()}` };
  }
  if (sources.length === 0) return { ...base, verdict: 'unsupported', why: `${outcomeRaw.toUpperCase()} with no source` };
  const relevant = sources.filter((src) => sourceMentions(src, event));
  if (event && relevant.length === 0) return { ...base, verdict: 'unsupported', why: `${outcomeRaw.toUpperCase()}, but none of its ${sources.length} source${sources.length === 1 ? '' : 's'} names the event (no word or year of it in the link)` };
  return { ...base, verdict: 'decisive', why: `${outcomeRaw.toUpperCase()}${resolvedAt ? `, settled ${resolvedAt}` : ''}, ${relevant.length} source${relevant.length === 1 ? '' : 's'} on the event` };
}

const SOURCE_STOP = new Set([...STOP, 'agree', 'wins', 'win', 'won', 'did', 'any', 'deal', 'the', 'and', 'explicitly', 'involves', 'rates', 'their']);

/**
 * Whether a cited source is about the event: its link or text contains a word
 * of the event (4+ letters) or one of its years. A link like
 * tavily.com/knowledge/company/UAwbVtzGSBVy, cited for an NBA game, is not.
 */
export function sourceMentions(source: string, event: string): boolean {
  const text = decodeURIComponentSafe(source).toLowerCase().replace(/[_\-+/.%]/g, ' ');
  const words = (event.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !SOURCE_STOP.has(w));
  const years = event.match(/\b(19|20)\d{2}\b/g) ?? [];
  return words.some((w) => new RegExp(`\\b${w}`).test(text)) || years.some((y) => text.includes(y));
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The same miner answering twice (routed and pinned) counts once. */
export function markDuplicates(answers: ResolveAnswer[]): ResolveAnswer[] {
  const seen = new Set<string>();
  return answers.map((a) => {
    if (!a.minerId || a.verdict === 'failed') return a;
    if (seen.has(a.minerId)) return { ...a, verdict: 'duplicate', why: `the same miner (${a.minerId}) already answered` };
    seen.add(a.minerId);
    return a;
  });
}

export function isTooEarly(market: MarketRead, now: Date): boolean {
  if (market.settled) return false;
  if (!market.closeTime) return false;
  const t = Date.parse(market.closeTime);
  return Number.isFinite(t) && t > now.getTime();
}

const label = (a: ResolveAnswer) => `${a.minerName ?? a.minerId ?? 'unknown miner'}${a.rank ? ` (rank ${a.rank})` : ''}`;

export function decide(market: MarketRead, answers: ResolveAnswer[], now: Date): { decision: ResolveDecision; decisionRule: string; outcome: Outcome | null; findings: ResolveFinding[] } {
  const findings: ResolveFinding[] = [];
  if (isTooEarly(market, now)) {
    findings.push({ rule: 'market.open', severity: 'info', title: 'The market has not closed', detail: `It closes ${market.closeTime}; status ${market.status}. Nothing was bought: an outcome asked for before the event is a guess.` });
    return { decision: 'TOO_EARLY', decisionRule: 'the market closes in the future and has not settled', outcome: null, findings };
  }
  if (market.settled) findings.push({ rule: 'market.settled', severity: 'info', title: `${market.source} settled ${market.settled.toUpperCase()}`, detail: `status ${market.status}${market.settledAt ? `, settled ${market.settledAt}` : ''}. Checked against the answers below, not taken on trust.` });
  else findings.push({ rule: 'market.unsettled', severity: 'info', title: 'No venue settlement yet', detail: `status ${market.status}. The answers below are the only evidence.` });

  for (const a of answers) {
    if (a.verdict === 'decisive') continue;
    const sev: ResolveFinding['severity'] = a.verdict === 'inconsistent' ? 'review' : 'info';
    let detail = a.why;
    if (market.settled && (a.outcome === 'yes' || a.outcome === 'no') && a.outcome !== market.settled) {
      detail += `; it says ${a.outcome.toUpperCase()} against the venue's ${market.settled.toUpperCase()}, without the evidence to count`;
    }
    findings.push({ rule: `answer.${a.verdict}`, severity: sev, title: `${label(a)}: ${a.verdict}`, detail });
  }

  const decisive = answers.filter((a) => a.verdict === 'decisive');
  const yes = decisive.filter((a) => a.outcome === 'yes');
  const no = decisive.filter((a) => a.outcome === 'no');
  for (const a of decisive) findings.push({ rule: 'answer.decisive', severity: 'pass', title: `${label(a)}: ${a.outcome!.toUpperCase()}`, detail: a.why });

  if (yes.length > 0 && no.length > 0) {
    findings.push({ rule: 'answers.disagree', severity: 'block', title: 'Sourced answers disagree', detail: `YES: ${yes.map(label).join(', ')}. NO: ${no.map(label).join(', ')}.` });
    return { decision: 'DISPUTED', decisionRule: 'two sourced answers disagree', outcome: null, findings };
  }
  const agreed: Outcome | null = yes.length > 0 ? 'yes' : no.length > 0 ? 'no' : null;
  if (agreed && market.settled && agreed !== market.settled) {
    findings.push({ rule: 'market.contradicted', severity: 'block', title: `Independent evidence says ${agreed.toUpperCase()}; the venue settled ${market.settled.toUpperCase()}`, detail: `${decisive.map(label).join(', ')} answered ${agreed.toUpperCase()} with sources and a settlement date.` });
    return { decision: 'DISPUTED', decisionRule: 'sourced answers contradict the venue\'s settlement', outcome: null, findings };
  }
  if (agreed && decisive.length >= RESOLVE_POLICY.minAgreeing) {
    return { decision: 'RESOLVED', decisionRule: market.settled ? `${decisive.length} sourced answers agree with each other and with the venue's settlement` : `${decisive.length} sourced answers agree`, outcome: agreed, findings };
  }
  findings.push({ rule: 'evidence.insufficient', severity: 'review', title: `${decisive.length} sourced answer${decisive.length === 1 ? '' : 's'}; ${RESOLVE_POLICY.minAgreeing} needed`, detail: 'No decision either way: the outcome needs a person or a later retry.' });
  return { decision: 'REVIEW', decisionRule: `fewer than ${RESOLVE_POLICY.minAgreeing} sourced answers`, outcome: null, findings };
}

// ---------------------------------------------------------------------------
// Running a resolution
// ---------------------------------------------------------------------------

export interface ResolveDeps {
  now(): Date;
  readMarket(req: ResolveRequest): Promise<MarketRead>;
  ranking(intent: string): Promise<IntentRanking>;
  catalog(intent: string): Promise<CatalogEntry[]>;
  askRouted(intent: string, params: Record<string, unknown>, question: string): Promise<TypedAnswer>;
  askPinned(minerId: string, intent: string, params: Record<string, unknown>): Promise<TypedAnswer>;
}

async function liveCatalog(intent: string): Promise<CatalogEntry[]> {
  const res = await fetch(`${NODE_URL}/api/miners?intent=${encodeURIComponent(intent)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http ${res.status} from the catalog`);
  const body = await res.json();
  return Array.isArray(body) ? (body as CatalogEntry[]) : [];
}

export const LIVE_RESOLVE: ResolveDeps = {
  now: () => new Date(),
  readMarket,
  ranking: intentRanking,
  catalog: liveCatalog,
  askRouted: askTypedIntent,
  askPinned: askPinnedIntent,
};

export interface ResolveHooks {
  onMarket?(market: MarketRead): void;
  onPlan?(plan: { event: string; routedTop: Selection['routedTop']; candidates: Pick<Candidate, 'minerId' | 'slug' | 'rank' | 'input' | 'relevance'>[]; excluded: Selection['excluded'] }): void;
  onAnswer?(answer: ResolveAnswer): void;
}

export async function runResolve(req: ResolveRequest, hooks: ResolveHooks = {}, deps: ResolveDeps = LIVE_RESOLVE): Promise<ResolveMemo> {
  const market = await deps.readMarket(req);
  hooks.onMarket?.(market);
  const now = deps.now();
  const memoBase = { version: 1 as const, kind: 'market-resolution' as const, input: req, market, intent: RESOLVE_INTENT, policy: RESOLVE_POLICY };

  if (isTooEarly(market, now)) {
    const d = decide(market, [], now);
    return { ...memoBase, createdAt: now.toISOString(), selection: { epoch: null, routedTop: null, attempts: [], excluded: [], note: 'nothing asked: the market has not closed' }, answers: [], ...d, cost: { telegraphUsd: 0, paidRequests: 0, failedRequests: 0 } };
  }

  let ranking: IntentRanking;
  let catalog: CatalogEntry[] = [];
  try { ranking = await deps.ranking(RESOLVE_INTENT); } catch (err) { ranking = { intent: RESOLVE_INTENT, epoch: null, miners: [], error: String(err) }; }
  try { catalog = await deps.catalog(RESOLVE_INTENT); } catch { catalog = []; }
  const sel = selectPinned(ranking, catalog, market.source, market.event);
  hooks.onPlan?.({ event: market.event, routedTop: sel.routedTop, candidates: sel.candidates.map(({ minerId, slug, rank, input, relevance: r }) => ({ minerId, slug, rank, input, relevance: r })), excluded: sel.excluded });

  const rankOf = (minerId: string | undefined) => {
    const m = ranking.miners.find((x) => x.minerId === minerId);
    return { rank: m?.rank ?? null, score: m?.score ?? null };
  };
  const params = { event: market.event };
  const routed = deps.askRouted(RESOLVE_INTENT, params, market.event).then((a) => {
    const j = judgeAnswer(a, 'routed', a.servedRank ? { rank: a.servedRank, score: rankOf(a.minerId).score } : rankOf(a.minerId));
    hooks.onAnswer?.(j);
    return j;
  });
  // Pinned answers, at most one usable answer per operator, walking the
  // candidates in order until two answers the node could read are in, at most
  // maxPinnedBilled billed asks, or maxPinnedAttempts asks. An ask that ends
  // unbilled with no answer (the node could not build it from the event, or the
  // miner's upstream refused it) moves on to the next candidate.
  const attempts: PinnedAttempt[] = [];
  const pinnedWalk = (async (): Promise<ResolveAnswer[]> => {
    const got: ResolveAnswer[] = [];
    const usedOperators = new Set<string>();
    const triedPerOperator = new Map<string, number>();
    for (const c of sel.candidates) {
      if (got.filter((g) => g.ok).length >= RESOLVE_POLICY.maxAnswers - 1) break;
      if (got.length >= RESOLVE_POLICY.maxPinnedBilled || attempts.length >= RESOLVE_POLICY.maxPinnedAttempts) break;
      if (usedOperators.has(c.operator)) continue;
      const tried = triedPerOperator.get(c.operator) ?? 0;
      if (tried >= RESOLVE_POLICY.maxAttemptsPerOperator) continue;
      triedPerOperator.set(c.operator, tried + 1);
      const a = await deps.askPinned(c.minerId, RESOLVE_INTENT, params);
      // Not billed and no answer: the node could not build the request, or the
      // miner's upstream refused the event. Neither is an opinion, so the next
      // candidate (even from the same operator) is tried.
      const unbilledMiss = !a.ok && !a.receipt && !(a.costUsd && a.costUsd > 0);
      const unbuildable = unbilledMiss && /no_compatible_miner|no request built/i.test(a.error ?? '');
      attempts.push({
        minerId: c.minerId, slug: c.slug,
        outcome: unbuildable ? 'skipped: the node could not build a request for it from the event (not billed)'
          : unbilledMiss ? `skipped: no answer, not billed (${(a.error ?? '').slice(0, 140)})`
            : a.ok ? 'answered' : `failed: ${(a.error ?? '').slice(0, 160)}`,
      });
      if (unbilledMiss) continue;
      usedOperators.add(c.operator);
      const j = judgeAnswer({ ...a, minerId: a.minerId ?? c.minerId, minerName: a.minerName ?? c.name }, 'pinned', { rank: c.rank, score: c.score });
      hooks.onAnswer?.(j);
      got.push(j);
    }
    return got;
  })();
  const [routedAnswer, pinnedAnswers] = await Promise.all([routed, pinnedWalk]);
  const answers = markDuplicates([routedAnswer, ...pinnedAnswers]);
  const d = decide(market, answers, now);
  const paid = answers.filter((a) => a.ok || a.receipt || a.costUsd > 0);
  return {
    ...memoBase,
    createdAt: deps.now().toISOString(),
    selection: { epoch: sel.epoch, routedTop: sel.routedTop, attempts, excluded: sel.excluded, note: sel.note },
    answers,
    ...d,
    cost: {
      telegraphUsd: Number(answers.reduce((t, a) => t + a.costUsd, 0).toFixed(6)),
      paidRequests: paid.length,
      failedRequests: answers.length - paid.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Signing, anchoring and storing
// ---------------------------------------------------------------------------

export interface StoredResolution {
  id: string;
  memo: ResolveMemo;
  sha256: string;
  message: string;
  signature: `0x${string}` | null;
  signer: `0x${string}` | null;
  /** The memo digest anchored on Solana devnet; outside the signed memo */
  anchor: SolanaAnchor;
}

export interface ResolveStore {
  add(entry: Omit<StoredResolution, 'id'>): StoredResolution;
  get(id: string): StoredResolution | undefined;
  recent(limit?: number): { id: string; createdAt: string; decision: ResolveDecision; outcome: Outcome | null; source: MarketSource; market: string; question: string; costUsd: number; anchored: boolean }[];
}

export function createResolveStore(file: string | null, max = 100): ResolveStore {
  let items: StoredResolution[] = [];
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) items = (parsed as StoredResolution[]).filter((m) => typeof m?.id === 'string').slice(-max);
    } catch { /* first run */ }
  }
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    if (!file) return;
    const snapshot = JSON.stringify(items);
    writing = writing.then(() => writeFile(file, snapshot, 'utf8')).catch(() => {});
  };
  return {
    add(entry) {
      const stored: StoredResolution = { id: randomBytes(6).toString('base64url'), ...entry };
      items.push(stored);
      if (items.length > max) items = items.slice(-max);
      persist();
      return stored;
    },
    get(id) { return items.find((m) => m.id === id); },
    recent(limit = 12) {
      return items.slice(-limit).reverse().map((m) => ({
        id: m.id, createdAt: m.memo.createdAt, decision: m.memo.decision, outcome: m.memo.outcome, source: m.memo.market.source,
        market: m.memo.market.id, question: m.memo.market.question, costUsd: m.memo.cost.telegraphUsd, anchored: m.anchor.anchored,
      }));
    },
  };
}

/** Sign the memo, then anchor its digest on Solana devnet. */
export async function sealResolution(memo: ResolveMemo, anchor: (sha256: string) => Promise<SolanaAnchor> = anchorDigest): Promise<Omit<StoredResolution, 'id'>> {
  const signed = await signAnyMemo(memo);
  return { memo, ...signed, anchor: await anchor(signed.sha256) };
}
