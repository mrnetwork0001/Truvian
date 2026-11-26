/**
 * A rehearsal of the ACP evaluation WITHOUT ACP: no wallets, no jobs, no
 * chain. It builds the demo provider's three deliveries the same way demo.ts
 * does (a real report from Shield, then correct / incorrect / incomplete),
 * and passes each through the same functions the Truvian agent uses on a
 * submitted job (requirementOf's input, requirementsOf, deliveryOf), then to
 * Shield's verifier. It shows what Truvian will decide on ACP; it is not an
 * ACP run, and its memos say "rehearsal" in their task.
 *
 *   SHIELD_URL=http://127.0.0.1:8790 npx tsx src/rehearse.ts
 */
import { diligence, verifyWork, memoUrl } from './shield.js';
import { deliveryOf, requirementsOf } from './truvian.js';

const subject = { entity: process.argv[2] ?? 'Garantex Europe OU', jurisdiction: process.argv[3] ?? 'Estonia' };

const report = await diligence({ ...subject, purpose: 'ACP rehearsal (no ACP job)' });
console.log(`report ${report.id}: ${report.memo.recommendation}, ${report.memo.report.claims.length} claims, Telegraph $${report.memo.cost.telegraphUsd}`);

for (const mode of ['correct', 'incorrect', 'incomplete'] as const) {
  let claims = report.memo.report.claims;
  if (mode === 'incorrect') claims = claims.map((c) => (c.kind === 'sanctions' ? { ...c, listed: !c.listed } : c));
  if (mode === 'incomplete') claims = claims.filter((c) => c.kind !== 'registry');
  const delivered = JSON.stringify({ demoFixture: true, demoMode: mode, subject: `${subject.entity} (${subject.jurisdiction})`, claims });
  const requirement = { ...subject, mode };
  const w = await verifyWork({
    task: `Rehearsal, not an ACP job: "Counterparty due diligence (demo)". Requirement: ${JSON.stringify(requirement)}`,
    requirements: requirementsOf(requirement),
    deliverable: deliveryOf(delivered),
    worker: `rehearsal:${mode}`,
  });
  const notes = w.memo.checks.filter((c) => c.status !== 'confirmed').map((c) => `${c.status}: ${c.title}`);
  console.log(`${mode.padEnd(11)} ${w.memo.verdict.padEnd(10)} ${w.memo.verdictRule}${notes.length ? ` | ${notes.join('; ')}` : ''}${w.memo.missing.length ? ` | missing ${w.memo.missing.map((r) => r.kind).join(', ')}` : ''} | ${memoUrl(w.id)} ($${w.memo.cost.telegraphUsd})`);
}
