/**
 * Truvian Resolve tests. Free: nothing here asks Telegraph or a venue.
 *
 * Unit section: event phrasing, answer judging, the decision rules and miner
 * selection, over answers shaped like the live ones of 2026-11-25.
 *
 * Replay section: every fixture in src/scripts/fixtures/resolve/ was recorded
 * by src/scripts/resolve-record.ts from a live, paid run (the venue's market,
 * the node's ranking and catalog, and every Telegraph answer). Each is run
 * through runResolve again, twice, from the recording alone: the decision must
 * match the one recorded, and the two replays must produce the same memo
 * digest (determinism).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, memoDigest } from '../shield/memo.js';
import type { IntentRanking, TypedAnswer } from '../shield/telegraph.js';
import {
  decide,
  eventFromRules,
  fitEvent,
  isTooEarly,
  judgeAnswer,
  kalshiMarketRead,
  normalizeResolveRequest,
  polymarketMarketRead,
  ResolveInputError,
  runResolve,
  selectPinned,
  sourceMentions,
  winnerContradicts,
  type CatalogEntry,
  type MarketRead,
  type ResolveAnswer,
  type ResolveDeps,
} from '../shield/resolve.js';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------- unit: event phrasing ----------

check('Will X win -> Did X win', eventFromRules('Will Donald Trump win the 2024 US Presidential Election?', '') === 'Did Donald Trump win the 2024 US Presidential Election?');
check('Kalshi rule "If A wins B, then ... Yes" -> Did A win B',
  eventFromRules('Dallas wins', 'If Dallas wins the Dallas vs Denver Pro Basketball game originally scheduled for Nov 24, 2026, then the market resolves to Yes.') === 'Did Dallas win the Dallas vs Denver Pro Basketball game originally scheduled for Nov 24, 2026?');
check('a proposition without a year carries the close date',
  eventFromRules('Philadelphia Eagles champions?', 'This market will resolve to "Yes" if the Philadelphia Eagles win Super Bowl LIX. Otherwise No.', '2025-02-09T12:00:00Z') === 'Did the Philadelphia Eagles win Super Bowl LIX (February 9, 2025)?');
check('a period after an initial does not end the clause (Donald J. Trump)',
  eventFromRules('Trump?', 'This market will resolve to “Yes” if Donald J. Trump wins the 2024 US Presidential Election. Otherwise, No.') === 'Did Donald J. Trump win the 2024 US Presidential Election?');
const long = fitEvent('word '.repeat(80));
check('fitEvent keeps the node\'s 256-byte limit', Buffer.byteLength(long, 'utf8') <= 256 && long.endsWith('…'), `${Buffer.byteLength(long, 'utf8')} bytes`);

// ---------- unit: input ----------

const throws = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof ResolveInputError; } };
check('source is required', throws(() => normalizeResolveRequest({})));
check('a Kalshi request needs a ticker', throws(() => normalizeResolveRequest({ source: 'kalshi' })));
check('a ticker with a path in it is refused', throws(() => normalizeResolveRequest({ source: 'kalshi', market: '../markets' })));
check('a manual market needs a close time', throws(() => normalizeResolveRequest({ source: 'manual', question: 'Did it rain?' })));
check('an event over 256 bytes is refused', throws(() => normalizeResolveRequest({ source: 'polymarket', market: '1', event: 'x'.repeat(257) })));

// ---------- unit: venue reads ----------

const kalshi = kalshiMarketRead({ ticker: 'KXNBAGAME-26NOV24DALDEN-DAL', title: 'Dallas wins', result: 'yes', status: 'finalized', close_time: '2026-11-25T05:35:51Z', settlement_ts: '2026-11-25T05:39:54Z', rules_primary: 'If Dallas wins the Dallas vs Denver Pro Basketball game originally scheduled for Nov 24, 2026, then the market resolves to Yes.' }, { title: 'Dallas vs Denver' });
check('Kalshi: result yes is a YES settlement', kalshi.settled === 'yes' && kalshi.status === 'finalized');
const poly = polymarketMarketRead({ id: '253591', question: 'Will Donald Trump win the 2024 US Presidential Election?', outcomes: '["Yes", "No"]', outcomePrices: '["1", "0"]', closed: true, umaResolutionStatus: 'resolved', endDate: '2024-11-05T12:00:00Z', description: '' });
check('Polymarket: closed, UMA resolved, prices [1,0] is a YES settlement', poly.settled === 'yes');
const proposed = polymarketMarketRead({ id: '1', question: 'Will X?', outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', closed: true, umaResolutionStatus: 'proposed', endDate: '2024-01-01T00:00:00Z', description: '' });
check('Polymarket: a proposed (not final) resolution is no settlement', proposed.settled === null);
check('Polymarket: a market that is not Yes/No is refused', (() => { try { polymarketMarketRead({ id: '1', question: 'Who?', outcomes: '["A","B","C"]', outcomePrices: '["1","0","0"]' }); return false; } catch { return true; } })());

// ---------- unit: judging answers ----------

const ask = (fields: Record<string, unknown> | null, event: string, extra: Partial<TypedAnswer> = {}): TypedAnswer => ({
  intent: 'EVENT_OUTCOME_RESOLUTION_GENERAL', params: { event }, ok: fields !== null, fields, fieldStatus: {}, latencyMs: 1, costUsd: 0.01, minerId: 'm', ...extra,
});
const R = { rank: 1, score: 1 };
const ev = 'Did Donald Trump win the 2024 US Presidential Election?';
check('answer with a source on the event is decisive',
  judgeAnswer(ask({ outcome: 'yes', resolved_yes: true, sources: ['https://en.wikipedia.org/wiki/2024_United_States_presidential_election'] }, ev), 'routed', R).verdict === 'decisive');
check('outcome unresolved is an abstention', judgeAnswer(ask({ outcome: 'unresolved', resolved_yes: false, sources: [] }, ev), 'routed', R).verdict === 'abstained');
check('outcome yes with resolved_yes false is inconsistent', judgeAnswer(ask({ outcome: 'yes', resolved_yes: false, sources: ['https://x/2024'] }, ev), 'routed', R).verdict === 'inconsistent');
check('no source is unsupported', judgeAnswer(ask({ outcome: 'yes', resolved_yes: true, sources: [] }, ev), 'routed', R).verdict === 'unsupported');
// Live 2026-11-25, routed TxLens on the Dallas game: NO, citing a company page with no word of the game in it.
const dal = 'Did Dallas win the Dallas vs Denver Pro Basketball game originally scheduled for Nov 24, 2026?';
check('sources that do not name the event are unsupported (live TxLens answer)',
  judgeAnswer(ask({ outcome: 'no', resolved_yes: false, sources: ['https://tavily.com/knowledge/company/UAwbVtzGSBVy'] }, dal), 'routed', R).verdict === 'unsupported');
// Live 2026-11-25, routed TxLens: NO, winner "Donald J. Trump", citing a 2026 midterm page.
check('naming the event\'s own subject as winner while saying NO is inconsistent (live TxLens answer)',
  judgeAnswer(ask({ outcome: 'no', resolved_yes: false, winner: 'Donald J. Trump', sources: ['https://www.livemint.com/news/us-news/us-mid-term-election-result-2026'] }, 'Donald J. Trump wins the 2024 US Presidential Election?'), 'routed', R).verdict === 'inconsistent');
check('a winner other than the subject with NO is consistent', !winnerContradicts('Did Kamala Harris win the 2024 US Presidential Election?', 'Donald Trump', 'no'));
check('negated events are left alone', !winnerContradicts('Did Trump not win the 2024 election?', 'Donald Trump', 'no'));
check('sourceMentions decodes links (Ukraine–United States agreement)', sourceMentions('https://en.wikipedia.org/wiki/Ukraine%E2%80%93United_States_Mineral_Resources_Agreement', 'Did the United States and Ukraine sign a minerals deal before April 1, 2025?'));
check('a failed ask is failed', judgeAnswer(ask(null, ev, { error: 'http 504' }), 'routed', R).verdict === 'failed');

// ---------- unit: decisions ----------

const now = new Date('2026-11-25T12:00:00Z');
const market = (over: Partial<MarketRead>): MarketRead => ({ source: 'polymarket', id: '1', url: null, question: 'q', rules: '', closeTime: '2024-11-05T12:00:00Z', status: 'closed', settled: null, settledAt: null, event: ev, ...over });
const dec = (outcome: 'yes' | 'no', id: string): ResolveAnswer => ({ ...judgeAnswer(ask({ outcome, resolved_yes: outcome === 'yes', sources: ['https://en.wikipedia.org/wiki/2024_United_States_presidential_election'] }, ev, { minerId: id, minerName: id }), 'pinned', R) });
check('future close, not settled: TOO_EARLY', decide(market({ closeTime: '2026-12-09T18:59:00Z' }), [], now).decision === 'TOO_EARLY');
check('isTooEarly is false once the venue settled, even before its close time', !isTooEarly(market({ closeTime: '2026-12-09T18:59:00Z', settled: 'yes' }), now));
check('two agreeing sourced answers, venue agrees: RESOLVED', (() => { const d = decide(market({ settled: 'yes' }), [dec('yes', 'a'), dec('yes', 'b')], now); return d.decision === 'RESOLVED' && d.outcome === 'yes'; })());
check('two agreeing sourced answers, no venue settlement: RESOLVED', decide(market({}), [dec('no', 'a'), dec('no', 'b')], now).decision === 'RESOLVED');
check('sourced answers disagree: DISPUTED', decide(market({ settled: 'yes' }), [dec('yes', 'a'), dec('no', 'b')], now).decision === 'DISPUTED');
check('sourced answers contradict the venue: DISPUTED', decide(market({ settled: 'yes' }), [dec('no', 'a')], now).decision === 'DISPUTED');
check('one sourced answer: REVIEW, no outcome', (() => { const d = decide(market({ settled: 'yes' }), [dec('yes', 'a')], now); return d.decision === 'REVIEW' && d.outcome === null; })());

// ---------- unit: selection ----------

const ranking: IntentRanking = {
  intent: 'EVENT_OUTCOME_RESOLUTION_GENERAL', epoch: 54,
  miners: [
    { minerId: '9002', slug: 'txlens', name: 'TxLens', rank: 1, score: 0.99, priceUsd: 0.01 },
    { minerId: '29302', slug: 'event-kalshi-result', name: 'Kalshi', rank: 2, score: 0, priceUsd: 0.01 },
    { minerId: '59003', slug: 'event-poly-search', name: 'Poly', rank: 3, score: 0, priceUsd: 0.01 },
    { minerId: '190016', slug: 'event-openligadb-bl1', name: 'OLDB', rank: 4, score: 0, priceUsd: 0.01 },
    { minerId: '20261117', slug: 'takar-outcome', name: 'Takar', rank: 14, score: 0, priceUsd: 0.01 },
    { minerId: '7456', slug: 'tradewire-event-outcome-resolution', name: 'TradeWire', rank: 33, score: 0, priceUsd: 0.01 },
    { minerId: '9100', slug: 'txlens-twin', name: 'Twin', rank: 34, score: 0, priceUsd: 0.01 },
  ],
};
const catalog: CatalogEntry[] = [
  { id: '9002', wallet_address: '0xAAA', input_schema: { properties: { claim: {} } } },
  { id: '29302', wallet_address: '0xBBB', input_schema: { properties: { ticker: {} } } },
  { id: '59003', wallet_address: '0xBBB', input_schema: { properties: { q: {} } } },
  { id: '190016', wallet_address: '0xBBB', input_schema: {}, signal_mapping: { label_field: 'events' } },
  { id: '20261117', wallet_address: '0xCCC', input_schema: {}, description: 'Resolves whether a real-world event happened, from Wikipedia text' },
  { id: '7456', wallet_address: '0xDDD', input_schema: { properties: { event: {} } }, description: 'Resolve the settled outcome of a named public event' },
  { id: '9100', wallet_address: '0xaaa', input_schema: { properties: { event: {} } } },
];
const kSel = selectPinned(ranking, catalog, 'kalshi', ev);
check('selection: the Kalshi-reading miner is excluded for a Kalshi market', kSel.excluded.some((e) => e.slug === 'event-kalshi-result'));
check('selection: a miner of the routed top miner\'s operator is excluded', kSel.excluded.some((e) => e.slug === 'txlens-twin'));
check('selection: a raw events pass-through is excluded', kSel.excluded.some((e) => e.slug === 'event-openligadb-bl1'));
check('selection: explicit event input first, then open input', kSel.candidates.map((c) => c.slug).join(',') === 'tradewire-event-outcome-resolution,takar-outcome', kSel.candidates.map((c) => c.slug).join(','));
check('selection: Polymarket-reading miners are excluded for a Polymarket market', selectPinned(ranking, catalog, 'polymarket', ev).excluded.some((e) => e.slug === 'event-poly-search'));

// ---------- replay ----------

interface Fixture {
  request: Record<string, unknown>;
  recorded: { now: string[]; market: MarketRead; ranking: IntentRanking; catalog: CatalogEntry[]; routed?: TypedAnswer; pinned: Record<string, TypedAnswer> };
  expected: { id: string; decision: string; outcome: string | null };
}

const dir = resolve(process.cwd(), 'src/scripts/fixtures/resolve');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
check('replay fixtures are present', files.length >= 3, `${files.length}`);
for (const file of files) {
  const fx = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Fixture;
  const replayDeps = (): ResolveDeps => {
    const at = new Date(fx.recorded.now[0] ?? '2026-11-25T00:00:00Z');
    return {
      now: () => at,
      readMarket: async () => fx.recorded.market,
      ranking: async () => fx.recorded.ranking,
      catalog: async () => fx.recorded.catalog,
      askRouted: async (intent, params) => fx.recorded.routed ?? { intent, params, ok: false, fields: null, fieldStatus: {}, latencyMs: 0, error: 'not recorded' },
      // A miner the recording never asked answers like an unbuildable ask: unbilled, skipped.
      askPinned: async (minerId, intent, params) => fx.recorded.pinned[minerId] ?? { intent, params, ok: false, fields: null, fieldStatus: {}, latencyMs: 0, error: 'no_compatible_miner (not in the recording)' },
    };
  };
  const req = normalizeResolveRequest(fx.request);
  const a = await runResolve(req, {}, replayDeps());
  const b = await runResolve(req, {}, replayDeps());
  check(`replay ${file}: decision ${fx.expected.decision} (memo ${fx.expected.id})`, a.decision === fx.expected.decision && a.outcome === fx.expected.outcome, `${a.decision} ${a.outcome ?? ''} - ${a.decisionRule}`);
  check(`replay ${file}: deterministic`, memoDigest(a) === memoDigest(b) && canonicalJson(a) === canonicalJson(b));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
