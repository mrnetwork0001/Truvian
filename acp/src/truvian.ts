/**
 * Truvian on Virtuals ACP. One agent, one wallet, two jobs:
 *
 * SELLER of "Counterparty due diligence" (Virtuals "Autonomous Intelligence
 * Businesses"). A buyer sends {entity, jurisdiction, wallets?}. Truvian sets
 * the price, and once the job is funded it runs the report on Shield (the
 * sanctions screening and the registry record bought from Telegraph's ranked
 * miners with receipts, wallet balances read from the chain) and delivers the
 * report: recommendation, claims, and the signed memo. When the job settles
 * it books the sale in Shield's ledger: what the buyer paid, what the
 * Telegraph answers cost, and the margin.
 *
 * EVALUATOR of other agents' work (Virtuals "Independent Agent Commerce
 * Evaluation"). When a job names Truvian as its evaluator, Truvian checks the
 * delivery on Shield's verifier: each claim is bought fresh from Telegraph or
 * read from the chain, the job's requirement says what had to be covered, and
 * the job is completed only if the work is ACCEPTED. A contradicted claim,
 * a missing item, or a claim nobody could verify rejects it, with the reason
 * and the signed memo. Truvian never evaluates a job it is the provider of.
 *
 *   npm run truvian      (from acp/)
 */
import { AssetToken, type JobRoomEntry, type JobSession } from '@virtuals-protocol/acp-node-v2';
import { createAgent, log } from './agent.js';
import { diligencePriceUsd, DILIGENCE_OFFERING, network, settlementNetwork } from './config.js';
import { book, diligence, memoUrl, ShieldError, verifyWork } from './shield.js';

const ROLE = 'truvian';
const done = new Set<string>();
const once = (key: string) => (done.has(key) ? false : (done.add(key), true));

/** The buyer's requirement: the first requirement message in the job room. */
export function requirementOf(session: JobSession): Record<string, unknown> | null {
  const m = session.entries.find((e) => e.kind === 'message' && e.contentType === 'requirement');
  if (!m || m.kind !== 'message') return null;
  try {
    const v = JSON.parse(m.content) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { text: String(v) };
  } catch {
    return { text: m.content };
  }
}

/** The report's memo id, from what Truvian delivered. */
function deliveredMemo(session: JobSession): string | null {
  const sub = session.entries.find((e) => e.kind === 'system' && e.event.type === 'job.submitted');
  const raw = sub && sub.kind === 'system' && sub.event.type === 'job.submitted' ? sub.event.deliverable : session.job?.deliverable ?? null;
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { memoId?: unknown };
    return typeof d.memoId === 'string' ? d.memoId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

function subjectOf(req: Record<string, unknown> | null): { entity: string; jurisdiction: string; wallets?: unknown[] } | string {
  if (!req) return 'no requirement was sent';
  const entity = typeof req.entity === 'string' ? req.entity.trim() : '';
  const jurisdiction = typeof req.jurisdiction === 'string' ? req.jurisdiction.trim() : '';
  if (entity.length < 2) return 'the requirement must name the counterparty: {"entity": "<legal name>", "jurisdiction": "<country>"}';
  if (jurisdiction.length < 2) return 'the requirement must say where the counterparty is registered: "jurisdiction"';
  return { entity, jurisdiction, ...(Array.isArray(req.wallets) ? { wallets: req.wallets.slice(0, 3) } : {}) };
}

async function asSeller(session: JobSession, entry: JobRoomEntry): Promise<void> {
  if (entry.kind === 'message' && entry.contentType === 'requirement' && session.status === 'open' && once(`${session.jobId}:budget`)) {
    const subject = subjectOf(requirementOf(session));
    if (typeof subject === 'string') {
      log(ROLE, `job ${session.jobId}: cannot quote: ${subject}`);
      await session.sendMessage(`Truvian cannot take this job: ${subject}.`);
      return;
    }
    const price = diligencePriceUsd();
    log(ROLE, `job ${session.jobId}: quoting $${price} for ${subject.entity} (${subject.jurisdiction})`);
    await session.setBudget(AssetToken.usdc(price, session.chainId));
    return;
  }
  if (entry.kind !== 'system') return;
  const t = entry.event.type;
  if (t === 'job.funded' && session.status === 'funded' && once(`${session.jobId}:submit`)) {
    const subject = subjectOf(requirementOf(session));
    if (typeof subject === 'string') return; // never quoted
    log(ROLE, `job ${session.jobId}: funded; running due diligence on ${subject.entity}`);
    const w = await diligence({ ...subject, purpose: `ACP job ${session.jobId} (${network()})` });
    const deliverable = {
      product: DILIGENCE_OFFERING,
      subject: `${subject.entity} (${subject.jurisdiction})`,
      recommendation: w.memo.recommendation,
      rule: w.memo.recommendationRule,
      summary: w.memo.report.summary,
      claims: w.memo.report.claims,
      evidence: { memoId: w.id, url: memoUrl(w.id), sha256: w.sha256, signature: w.signature, signer: w.signer, telegraphAnswers: w.memo.cost.paidRequests },
      memoId: w.id,
    };
    await session.submit(JSON.stringify(deliverable));
    log(ROLE, `job ${session.jobId}: delivered ${w.memo.recommendation} (memo ${w.id}, Telegraph $${w.memo.cost.telegraphUsd})`);
    return;
  }
  if ((t === 'job.completed' || t === 'job.rejected') && once(`${session.jobId}:book`)) {
    const memoId = deliveredMemo(session);
    if (!memoId) return;
    const job = session.job ?? (await session.fetchJob().catch(() => null));
    const price = t === 'job.completed' ? (job ? job.budget.amount : diligencePriceUsd()) : 0;
    try {
      await book(memoId, price, session.jobId, settlementNetwork());
      log(ROLE, `job ${session.jobId}: ${t === 'job.completed' ? `paid $${price}` : 'rejected, nothing paid'}; booked memo ${memoId}`);
    } catch (err) {
      log(ROLE, `job ${session.jobId}: booking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** What the job had to cover, from its requirement: the counterparty's sanctions status and registry record, and any wallets named. */
export function requirementsOf(req: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!req) return [];
  if (Array.isArray(req.verify)) return req.verify.slice(0, 8) as Array<Record<string, unknown>>; // explicit: the buyer listed what to check
  const out: Array<Record<string, unknown>> = [];
  if (typeof req.entity === 'string' && req.entity.trim()) {
    out.push({ kind: 'sanctions', entity: req.entity.trim() }, { kind: 'registry', entity: req.entity.trim() });
  }
  if (Array.isArray(req.wallets)) {
    for (const w of req.wallets.slice(0, 3) as Array<Record<string, unknown>>) {
      if (w && typeof w.address === 'string') out.push({ kind: 'token_balance', ...(typeof w.chain === 'string' ? { chain: w.chain } : {}), wallet: w.address, ...(typeof w.token === 'string' ? { token: w.token } : {}) });
    }
  }
  return out;
}

/** The delivery as the verifier takes it: structured claims when it has them, its text otherwise. */
export function deliveryOf(raw: string): { claims: unknown[] } | { text: string } {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(d.claims)) return { claims: d.claims };
    return { text: JSON.stringify(d) };
  } catch {
    return { text: raw };
  }
}

async function asEvaluator(session: JobSession, entry: JobRoomEntry): Promise<void> {
  if (entry.kind !== 'system' || entry.event.type !== 'job.submitted') return;
  if (session.roles.includes('provider')) return; // never judge its own delivery
  if (session.status !== 'submitted' || !once(`${session.jobId}:evaluate`)) return;
  const req = requirementOf(session);
  const description = session.job?.description ?? 'an ACP job';
  const task = `ACP job ${session.jobId} on ${network()}: "${description}". Requirement: ${req ? JSON.stringify(req).slice(0, 1500) : '(none sent)'}`;
  const requirements = requirementsOf(req);
  log(ROLE, `job ${session.jobId}: evaluating the delivery of ${entry.event.provider} against ${requirements.length} requirement(s)`);
  let w;
  try {
    w = await verifyWork({ task, requirements, deliverable: deliveryOf(entry.event.deliverable), worker: `acp:${entry.event.provider}` });
  } catch (err) {
    // Not judged is not approved: the buyer's funds stay protected
    const why = err instanceof ShieldError ? err.message : err instanceof Error ? err.message : String(err);
    log(ROLE, `job ${session.jobId}: verification failed (${why}); rejecting`);
    await session.reject(`Truvian could not verify this delivery (${why.slice(0, 200)}), so it is not approved.`);
    return;
  }
  const m = w.memo;
  const lines = m.checks.filter((c) => c.status !== 'confirmed').map((c) => `${c.status}: ${c.title}`).slice(0, 4);
  const missing = m.missing.length ? `missing: ${m.missing.map((r) => `${r.kind}${r.entity ? ` (${r.entity})` : ''}`).join(', ')}` : '';
  const reason = `${m.verdict}: ${m.verdictRule}.${lines.length ? ` ${lines.join('; ')}.` : ''}${missing ? ` ${missing}.` : ''} Signed memo ${memoUrl(w.id)}`.slice(0, 900);
  if (m.verdict === 'ACCEPTED') await session.complete(reason);
  else await session.reject(reason);
  log(ROLE, `job ${session.jobId}: ${m.verdict} (memo ${w.id}, Telegraph $${m.cost.telegraphUsd})`);
  try {
    await book(w.id, 0, session.jobId, settlementNetwork()); // evaluation is booked at its cost; ACP pays the evaluator nothing here
  } catch (err) {
    log(ROLE, `job ${session.jobId}: booking the evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const agent = await createAgent('TRUVIAN');
  agent.on('entry', async (session, entry) => {
    try {
      if (session.roles.includes('provider')) await asSeller(session, entry);
      if (session.roles.includes('evaluator')) await asEvaluator(session, entry);
    } catch (err) {
      log(ROLE, `job ${session.jobId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  });
  await agent.start(() => log(ROLE, `listening on ACP ${network()} as ${'0x'}…${(process.env.ACP_TRUVIAN_WALLET_ADDRESS ?? '').slice(-6)}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
