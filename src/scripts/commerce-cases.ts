/**
 * Independent verification across several enterprise tasks (Tencent
 * "Independent Enterprise Agent Verification"), run on a live Shield.
 *
 * Each case is an agent's deliverable for a business task, sent to
 * POST /api/verify-work. The deliverables are TEST INPUTS written for this
 * run (their task text says so), except where noted: case 2 quotes a real
 * model answer recorded in docs/frontier-comparison/2026-11-23-may-decline.json.
 * The evidence and the verdicts are real: every fact is bought from Telegraph
 * or read from the chain at run time.
 *
 *   SHIELD_URL=https://truvian.xyz npx tsx src/scripts/commerce-cases.ts
 *
 * Writes docs/commerce/verification-cases-<date>.json.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';

const SHIELD = (process.env.SHIELD_URL ?? 'https://truvian.xyz').replace(/\/$/, '');
const KEY = process.env.SHIELD_INTERNAL_KEY;
if (!KEY) throw new Error('set SHIELD_INTERNAL_KEY');

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ENS_TIMELOCK = '0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7';

const cases = [
  {
    name: 'Vendor onboarding: a due diligence summary in prose',
    expect: 'REJECTED',
    body: {
      task: 'Test deliverable (written for this run): vendor onboarding due diligence on Garantex Europe OU (Estonia): sanctions status and registry status, before the first payment.',
      requirements: [{ kind: 'sanctions', entity: 'Garantex Europe OU' }, { kind: 'registry', entity: 'Garantex Europe OU' }],
      deliverable: { text: 'Due diligence summary. Garantex Europe OU is a crypto exchange operator incorporated in Estonia. Our screening found no matches on OFAC or UN sanctions lists, so the entity is not sanctioned. The Estonian business register lists the company as active and in good standing. We recommend onboarding.' },
      worker: 'test:vendor-onboarding-agent',
    },
  },
  {
    name: 'Market research: a model\'s USDC supply figure',
    expect: 'REJECTED',
    body: {
      task: 'Market research for a stablecoin listing memo: the total supply of USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum. The deliverable is gemini-3.1-pro-preview\'s answer recorded on 2026-11-23 (docs/frontier-comparison/2026-11-23-may-decline.json, case supply-usdc).',
      requirements: [{ kind: 'token_supply', chain: 'ethereum', token: USDC }],
      deliverable: { claims: [{ kind: 'token_supply', chain: 'ethereum', token: USDC, totalSupply: '33246830704' }] },
      worker: 'model:gemini-3.1-pro-preview',
    },
  },
  {
    name: 'Treasury proof: a DAO treasury\'s USDC holding',
    expect: 'ACCEPTED',
    body: {
      task: 'Test deliverable (written for this run from a chain read at block 26499026): confirm the USDC held by the ENS DAO timelock treasury (0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7) on Ethereum for a grant committee.',
      requirements: [{ kind: 'token_balance', chain: 'ethereum', wallet: ENS_TIMELOCK, token: USDC }],
      deliverable: { claims: [{ kind: 'token_balance', chain: 'ethereum', wallet: ENS_TIMELOCK, token: USDC, balance: '2435008.157713' }] },
      worker: 'test:treasury-agent',
    },
  },
  {
    name: 'Supplier KYB: a check that skipped the registry',
    expect: 'INCOMPLETE',
    body: {
      task: 'Test deliverable (written for this run): know-your-business check on Coinbase (US, Delaware) before a custody contract: sanctions status AND registry record are both required.',
      requirements: [{ kind: 'sanctions', entity: 'Coinbase' }, { kind: 'registry', entity: 'Coinbase' }],
      deliverable: { claims: [{ kind: 'sanctions', entity: 'Coinbase', listed: false }] },
      worker: 'test:kyb-agent',
    },
  },
];

const out: unknown[] = [];
for (const c of cases) {
  const res = await fetch(`${SHIELD}/api/verify-work`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(c.body) });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`${c.name}: HTTP ${res.status} ${JSON.stringify(j)}`);
  const m = j.memo;
  const row = {
    case: c.name, expected: c.expect, verdict: m.verdict, rule: m.verdictRule, memo: `${SHIELD}/api/work/${j.id}`, id: j.id, sha256: j.sha256,
    claimsFrom: m.claimsFrom, extractedBy: m.extraction ? `${m.extraction.provider}/${m.extraction.model}` : null,
    checks: m.checks.map((x: any) => `${x.status}: ${x.title}`), missing: m.missing, telegraphUsd: m.cost.telegraphUsd, paidRequests: m.cost.paidRequests,
  };
  out.push(row);
  console.log(`${row.verdict === c.expect ? 'as expected' : 'UNEXPECTED '} ${row.verdict.padEnd(10)} ${c.name} | ${row.checks.join('; ')} | ${row.memo} ($${row.telegraphUsd})`);
}
const date = new Date().toISOString().slice(0, 10);
mkdirSync('docs/commerce', { recursive: true });
writeFileSync(`docs/commerce/verification-cases-${date}.json`, JSON.stringify({ ranAt: new Date().toISOString(), shield: SHIELD, cases: out }, null, 1));
console.log(`\nwritten docs/commerce/verification-cases-${date}.json`);
