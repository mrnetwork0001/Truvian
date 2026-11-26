/**
 * Run a commerce desk from the command line, without the server, and print
 * the memo's main lines. Spends from the Telegraph escrow like a desk run.
 *
 *   npx tsx src/scripts/commerce-run.ts investigate "<decision brief>"
 *   npx tsx src/scripts/commerce-run.ts diligence '{"entity":"...","jurisdiction":"..."}'
 *   npx tsx src/scripts/commerce-run.ts verify '{"task":"...","deliverable":{"claims":[...]}}'
 *
 * Add --json to print the whole memo.
 */
import 'dotenv/config';
import { normalizeDiligenceRequest, runDiligence } from '../shield/commerce/diligence.js';
import { normalizeInvestigateRequest, runInvestigation } from '../shield/commerce/investigate.js';
import { llmInfo } from '../shield/commerce/llm.js';
import { normalizeVerifyRequest, runVerifyWork } from '../shield/commerce/verifyWork.js';

const [cmd, arg] = process.argv.slice(2);
const full = process.argv.includes('--json');
const print = (summary: unknown, memo: unknown) => console.log(JSON.stringify(full ? memo : summary, null, 1));

async function main() {
  if (cmd === 'investigate') {
    console.log('agent model:', llmInfo());
    const m = await runInvestigation(normalizeInvestigateRequest({ brief: arg }));
    print({
      reading: { ...m.reading, raw: undefined }, subject: m.subject,
      followUps: m.followUps.map((f) => ({ asked: f.asked, reason: f.reason, used: f.used, outcome: f.outcome })),
      findings: m.findings.map((f) => `${f.severity} [${f.rule}] ${f.title}`),
      recommendation: m.recommendation, changesOutcome: m.changesOutcome, case: m.case,
      llm: m.llm, cost: m.cost, latencyMs: m.latencyMs,
    }, m);
  } else if (cmd === 'diligence') {
    const m = await runDiligence(normalizeDiligenceRequest(JSON.parse(arg!)));
    print({ findings: m.findings.map((f) => `${f.severity} [${f.rule}] ${f.title}`), recommendation: m.recommendation, report: m.report, cost: m.cost }, m);
  } else if (cmd === 'verify') {
    const m = await runVerifyWork(normalizeVerifyRequest(JSON.parse(arg!)));
    print({ claimsFrom: m.claimsFrom, checks: m.checks.map((c) => `${c.status} ${c.title} | ${c.detail} ${c.notes.join(' ')}`), missing: m.missing, malformed: m.malformed, verdict: m.verdict, rule: m.verdictRule, cost: m.cost }, m);
  } else {
    console.error('usage: commerce-run.ts investigate|diligence|verify <input> [--json]');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
