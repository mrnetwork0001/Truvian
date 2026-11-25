/**
 * Run live Truvian Resolve decisions (paid Telegraph asks, about $0.01 per
 * answer from the API key's escrow), sign them, anchor their digests on
 * Solana devnet, store them where the Shield server reads them
 * (.shield-resolve-memos.json), and record every input the decision used as a
 * replay fixture for `npm run test:resolve`.
 *
 *   npx tsx src/scripts/resolve-record.ts <fixture-name> '<request json>'
 *   e.g. resolve-record.ts eagles-sb-lix '{"source":"polymarket","market":"503322"}'
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TypedAnswer } from '../shield/telegraph.js';
import { LIVE_RESOLVE, createResolveStore, normalizeResolveRequest, runResolve, sealResolution, type CatalogEntry, type ResolveDeps } from '../shield/resolve.js';

const [name, raw] = process.argv.slice(2);
if (!name || !raw) {
  console.error('usage: resolve-record.ts <fixture-name> <request json>');
  process.exit(2);
}
const req = normalizeResolveRequest(JSON.parse(raw) as Record<string, unknown>);

const rec: { now: string[]; market?: unknown; ranking?: unknown; catalog?: unknown; routed?: TypedAnswer; pinned: Record<string, TypedAnswer> } = { now: [], pinned: {} };
const keep = (c: CatalogEntry) => ({ id: c.id, slug: c.slug, name: c.name, description: c.description, wallet_address: c.wallet_address, input_schema: c.input_schema });
const deps: ResolveDeps = {
  now: () => { const d = new Date(); rec.now.push(d.toISOString()); return d; },
  readMarket: async (r) => (rec.market = await LIVE_RESOLVE.readMarket(r)) as never,
  ranking: async (i) => (rec.ranking = await LIVE_RESOLVE.ranking(i)) as never,
  catalog: async (i) => { const c = await LIVE_RESOLVE.catalog(i); rec.catalog = c.map(keep); return c; },
  askRouted: async (i, p, q) => (rec.routed = await LIVE_RESOLVE.askRouted(i, p, q)),
  askPinned: async (m, i, p) => (rec.pinned[m] = await LIVE_RESOLVE.askPinned(m, i, p)),
};

const memo = await runResolve(req, {
  onPlan: (plan) => console.log('plan', JSON.stringify(plan)),
  onAnswer: (a) => console.log('answer', a.route, a.minerName, a.verdict, a.why, `$${a.costUsd}`, `${a.latencyMs} ms`),
}, deps);
const sealed = await sealResolution(memo);
const stored = createResolveStore(process.env.SHIELD_RESOLVE_MEMOS_FILE ?? resolve(process.cwd(), '.shield-resolve-memos.json')).add(sealed);
await new Promise((r) => setTimeout(r, 300)); // let the store's write finish

const dir = resolve(process.cwd(), 'src/scripts/fixtures/resolve');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, `${name}.json`), `${JSON.stringify({ request: req, recorded: rec, expected: { id: stored.id, sha256: stored.sha256, decision: memo.decision, outcome: memo.outcome, decisionRule: memo.decisionRule, anchor: stored.anchor } }, null, 2)}\n`);
console.log(JSON.stringify({ id: stored.id, decision: memo.decision, outcome: memo.outcome, rule: memo.decisionRule, cost: memo.cost, anchor: stored.anchor, signer: stored.signer }, null, 2));
