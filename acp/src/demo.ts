/**
 * The ACP demonstration, end to end on the configured network (testnet by
 * default). Two demo agents run in this process; the Truvian agent
 * (truvian.ts) must be running separately, as it is on the server.
 *
 * 1. Independent evaluation (Virtuals "Independent Agent Commerce Evaluation").
 *    The demo BUYER buys "Counterparty due diligence (demo)" three times from
 *    the DEMO PROVIDER, naming Truvian as the evaluator. The demo provider is a
 *    TEST FIXTURE: it fetches a real report from Shield, then delivers it
 *      correct      as it is,
 *      incorrect    with the sanctions claim flipped (a fabricated "not sanctioned"),
 *      incomplete   with the registry claim left out,
 *    and says which in its delivery. Truvian's evaluator never reads that label:
 *    it checks the claims against fresh Telegraph answers and the job's
 *    requirement, and completes or rejects the job on chain.
 *
 * 2. A paid job (Virtuals "Autonomous Intelligence Businesses"). The BUYER
 *    buys Truvian's own "Counterparty due diligence", evaluates it itself by
 *    checking the memo's signature on Shield, and completes it, which pays
 *    Truvian. Truvian books the sale in its ledger (GET /api/business).
 *
 * Every job id, outcome, reason and memo is written to acp/runs/<time>.json.
 *
 *   npm run demo                       all four jobs
 *   npm run demo -- --only=evaluation  the three evaluation jobs
 *   npm run demo -- --only=sale        the paid job
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { AssetToken, type AcpAgent, type JobRoomEntry, type JobSession } from '@virtuals-protocol/acp-node-v2';
import { createAgent, log } from './agent.js';
import { chain, DILIGENCE_OFFERING, network, shieldUrl, wallet } from './config.js';
import { diligence } from './shield.js';

export const DEMO_OFFERING = process.env.ACP_DEMO_OFFERING?.trim() || 'Counterparty due diligence (demo)';
const DEMO_PRICE_USD = 0.01;

type Mode = 'correct' | 'incorrect' | 'incomplete';

interface Outcome { scenario: string; jobId: string; provider: string; evaluator: string; status: 'completed' | 'rejected' | 'expired' | 'timeout'; reason: string | null; deliverable: unknown }

const outcomes = new Map<string, Outcome>();
const waiters = new Map<string, (o: Outcome) => void>();

function finish(jobId: string, status: Outcome['status'], reason: string | null) {
  const o = outcomes.get(jobId);
  if (!o || o.status !== 'timeout') return;
  o.status = status;
  o.reason = reason;
  waiters.get(jobId)?.(o);
}

// ---------------------------------------------------------------------------
// The demo provider (a test fixture)
// ---------------------------------------------------------------------------

function demoProvider(agent: AcpAgent) {
  const done = new Set<string>();
  agent.on('entry', async (session: JobSession, entry: JobRoomEntry) => {
    try {
      if (!session.roles.includes('provider')) return;
      if (entry.kind === 'message' && entry.contentType === 'requirement' && session.status === 'open' && !done.has(`${session.jobId}:b`)) {
        done.add(`${session.jobId}:b`);
        await session.setBudget(AssetToken.usdc(DEMO_PRICE_USD, session.chainId));
        return;
      }
      if (entry.kind === 'system' && entry.event.type === 'job.funded' && session.status === 'funded' && !done.has(`${session.jobId}:s`)) {
        done.add(`${session.jobId}:s`);
        const m = session.entries.find((e) => e.kind === 'message' && e.contentType === 'requirement');
        const req = m && m.kind === 'message' ? (JSON.parse(m.content) as { entity: string; jurisdiction: string; mode: Mode }) : null;
        if (!req) return;
        const w = await diligence({ entity: req.entity, jurisdiction: req.jurisdiction, purpose: `ACP demo provider, job ${session.jobId}` });
        let claims = w.memo.report.claims;
        if (req.mode === 'incorrect') claims = claims.map((c) => (c.kind === 'sanctions' ? { ...c, listed: !c.listed } : c));
        if (req.mode === 'incomplete') claims = claims.filter((c) => c.kind !== 'registry');
        await session.submit(JSON.stringify({ demoFixture: true, demoMode: req.mode, note: 'Test fixture: built from a real Truvian report, then altered as demoMode says.', subject: `${req.entity} (${req.jurisdiction})`, claims, source: `${shieldUrl()}/api/work/${w.id}` }));
        log('demo-provider', `job ${session.jobId}: delivered the ${req.mode} version`);
      }
    } catch (err) {
      log('demo-provider', `job ${session.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

function buyer(agent: AcpAgent) {
  const funded = new Set<string>();
  const judged = new Set<string>();
  agent.on('entry', async (session: JobSession, entry: JobRoomEntry) => {
    try {
      if (!session.roles.includes('client')) return;
      if (entry.kind !== 'system') return;
      const ev = entry.event;
      if (ev.type === 'budget.set' && !funded.has(session.jobId)) {
        funded.add(session.jobId);
        await session.fund();
        log('buyer', `job ${session.jobId}: funded`);
      } else if (ev.type === 'job.submitted') {
        const o = outcomes.get(session.jobId);
        if (o) try { o.deliverable = JSON.parse(ev.deliverable); } catch { o.deliverable = ev.deliverable; }
        // The paid job: the buyer is its own evaluator and checks the memo's signature on Shield
        if (session.roles.includes('evaluator') && !judged.has(session.jobId)) {
          judged.add(session.jobId);
          const d = JSON.parse(ev.deliverable) as { evidence?: { memoId?: string } };
          const id = d.evidence?.memoId;
          const stored = id ? await (await fetch(`${shieldUrl()}/api/work/${id}`)).json() as { memo?: unknown; signature?: string } : null;
          const v = stored?.memo ? await (await fetch(`${shieldUrl()}/api/memo/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memo: stored.memo, signature: stored.signature }) })).json() as { signedByThisShield?: boolean } : null;
          if (v?.signedByThisShield) await session.complete(`Report received; memo ${id} is signed by Truvian Shield.`);
          else await session.reject('The report\'s memo could not be verified.');
        }
      } else if (ev.type === 'job.completed') finish(session.jobId, 'completed', ev.reason);
      else if (ev.type === 'job.rejected') finish(session.jobId, 'rejected', ev.reason);
      else if (ev.type === 'job.expired') finish(session.jobId, 'expired', null);
    } catch (err) {
      log('buyer', `job ${session.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function run(agent: AcpAgent, scenario: string, offering: string, provider: string, requirement: Record<string, unknown>, evaluator: string, timeoutMs = 15 * 60_000): Promise<Outcome> {
  const jobId = String(await agent.createJobByOfferingName(chain().id, offering, provider, requirement, { evaluatorAddress: evaluator }));
  log('buyer', `${scenario}: job ${jobId} created (provider ${provider.slice(0, 8)}…, evaluator ${evaluator.slice(0, 8)}…)`);
  const o: Outcome = { scenario, jobId, provider, evaluator, status: 'timeout', reason: null, deliverable: null };
  outcomes.set(jobId, o);
  return new Promise((resolve) => {
    waiters.set(jobId, resolve);
    setTimeout(() => resolve(o), timeoutMs);
  });
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const truvian = wallet('TRUVIAN').walletAddress;
  const b = await createAgent('BUYER');
  buyer(b);
  await b.start(() => log('buyer', `connected on ACP ${network()}`));
  const buyerAddress = await b.getAddress();
  const results: Outcome[] = [];

  if (only !== 'sale') {
    const p = await createAgent('DEMO_PROVIDER');
    demoProvider(p);
    await p.start(() => log('demo-provider', 'connected'));
    const provider = wallet('DEMO_PROVIDER').walletAddress;
    const subject = { entity: 'Garantex Europe OU', jurisdiction: 'Estonia' };
    for (const mode of ['correct', 'incorrect', 'incomplete'] as const) {
      results.push(await run(b, `evaluation: ${mode} delivery`, DEMO_OFFERING, provider, { ...subject, mode }, truvian));
    }
    await p.stop();
  }
  if (only !== 'evaluation') {
    results.push(await run(b, 'sale: Truvian due diligence', DILIGENCE_OFFERING, truvian, { entity: 'Coinbase, Inc.', jurisdiction: 'US-DE' }, buyerAddress));
  }
  await b.stop();

  mkdirSync(new URL('../runs/', import.meta.url), { recursive: true });
  const file = new URL(`../runs/${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ network: network(), chainId: chain().id, buyer: buyerAddress, truvian, results }, null, 1));
  for (const r of results) console.log(`${r.scenario.padEnd(32)} job ${r.jobId.padEnd(10)} ${r.status.toUpperCase()}${r.reason ? `: ${r.reason.slice(0, 140)}` : ''}`);
  console.log(`\nrecord: ${file.pathname}\nbooks: ${shieldUrl()}/api/business`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
