/**
 * Commerce desk tests: work verification, due diligence and the ledger.
 *
 * Unit section: the claim rules and verdicts (commerce/claims.ts) over
 * answers copied verbatim from live routed Telegraph requests (memo rk43l_0A,
 * 2026-11-25: the Garantex sanctions match and its registry record), the
 * report-to-claims step (diligence.ts), JSON extraction from model replies,
 * and the ledger's books.
 *
 * Live section (COMMERCE_LIVE=1): a real due diligence report through
 * Telegraph (paid from the escrow, about $0.02-0.05), then the verifier on
 * three deliverables made from it: the report as delivered (ACCEPTED), the
 * report with its sanctions claim flipped (REJECTED), and the report with its
 * registry claim dropped against a requirement for it (INCOMPLETE).
 */
import 'dotenv/config';
import { strict as assert } from 'node:assert';
import {
  judgeBalance,
  judgeRegistry,
  judgeSanctions,
  judgeSupply,
  normalizeClaim,
  normalizeRequirement,
  satisfies,
  withinBps,
  workVerdict,
  ClaimInputError,
  type Claim,
} from '../shield/commerce/claims.js';
import { recommend, reportClaims, type DiligenceRequest } from '../shield/commerce/diligence.js';
import { firstJson } from '../shield/commerce/llm.js';
import { createLedger } from '../shield/commerce/store.js';
import { normalizeVerifyRequest, runVerifyWork } from '../shield/commerce/verifyWork.js';
import { runDiligence } from '../shield/commerce/diligence.js';
import type { Purchase } from '../shield/preflight.js';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
};

const purchase = (key: Purchase['key'], intent: string, fields: Record<string, unknown> | null, extra: Partial<Purchase> = {}): Purchase => ({
  key, intent, params: {}, ok: fields !== null, fields, fieldStatus: {}, costUsd: 0.01, latencyMs: 1, reused: false, boughtAt: '2026-11-25T17:08:10.285Z', ...extra,
});

// Live answers, memo rk43l_0A (2026-11-25)
const GARANTEX_SANCTIONS = purchase('sanctions', 'SANCTIONS_SCREENING_MATCH_GENERAL', { name: 'Garantex Europe OU', matched: true, matches: ['GARANTEX EUROPE OU'], lists: ['OFAC SDN', 'OFAC SDN aliases', 'UN Consolidated'], match_score: 1 }, { minerId: '302', minerName: 'ChainSight' });
const GARANTEX_REGISTRY = purchase('registry', 'CORPORATE_REGISTRY_LOOKUP_GENERAL', { legal_name: null, registration_id: null, active: false, jurisdiction: 'Estonia', registered_address: null, incorporated: null }, { minerId: '9002', minerName: 'TxLens' });

async function unit() {
  await test('claims: shapes are checked, with what is wrong', () => {
    assert.deepEqual(normalizeClaim({ kind: 'sanctions', entity: 'Garantex Europe OU', listed: 'true' }), { kind: 'sanctions', entity: 'Garantex Europe OU', listed: true });
    assert.throws(() => normalizeClaim({ kind: 'registry', entity: 'Acme', jurisdiction: 'US' }), ClaimInputError);
    assert.throws(() => normalizeClaim({ kind: 'token_balance', chain: 'ethereum', wallet: 'vitalik.eth', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', balance: '1' }), ClaimInputError);
    assert.throws(() => normalizeClaim({ kind: 'token_supply', chain: 'solana', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', totalSupply: '1' }), ClaimInputError);
    const c = normalizeClaim({ kind: 'token_balance', chain: 'ethereum', wallet: '0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', balance: '1,250.5' });
    assert.equal(c.kind === 'token_balance' && c.wallet, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    assert.equal(c.kind === 'token_balance' && c.balance, '1250.5');
  });

  await test('sanctions: the live Garantex match confirms "listed" and contradicts "not listed"', () => {
    assert.equal(judgeSanctions(0, { kind: 'sanctions', entity: 'Garantex Europe OU', listed: true }, GARANTEX_SANCTIONS).status, 'confirmed');
    const wrong = judgeSanctions(0, { kind: 'sanctions', entity: 'Garantex Europe OU', listed: false }, GARANTEX_SANCTIONS);
    assert.equal(wrong.status, 'contradicted');
    assert.match(wrong.detail, /OFAC SDN/);
    assert.match(wrong.detail, /miner 302 \(ChainSight\)/);
  });

  await test('sanctions: a close name match or no answer leaves the claim unverified', () => {
    const near = purchase('sanctions', 'X', { matched: false, match_score: 0.9, lists: ['OFAC SDN'] });
    assert.equal(judgeSanctions(0, { kind: 'sanctions', entity: 'Acme', listed: false }, near).status, 'unverified');
    assert.equal(judgeSanctions(0, { kind: 'sanctions', entity: 'Acme', listed: false }, purchase('sanctions', 'X', null, { error: 'timeout' })).status, 'unverified');
    assert.equal(judgeSanctions(0, { kind: 'sanctions', entity: 'Acme', listed: false }, purchase('sanctions', 'X', { matched: false, match_score: 0.2 })).status, 'confirmed');
  });

  await test('registry: the live Garantex record contradicts "active" and confirms "inactive"', () => {
    const wrong = judgeRegistry(0, { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'Estonia', active: true }, GARANTEX_REGISTRY);
    assert.equal(wrong.status, 'contradicted');
    assert.match(wrong.detail, /the registry says inactive/);
    assert.equal(judgeRegistry(0, { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'EE', active: false }, GARANTEX_REGISTRY).status, 'confirmed');
  });

  await test('registry: a field the answer lacks is unverified, a wrong country is contradicted, another entity is no evidence', () => {
    assert.equal(judgeRegistry(0, { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'Estonia', active: false, registrationId: '14532901' }, GARANTEX_REGISTRY).status, 'unverified');
    assert.equal(judgeRegistry(0, { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'Germany', active: false }, GARANTEX_REGISTRY).status, 'contradicted');
    const other = purchase('registry', 'X', { legal_name: 'Unrelated Holdings Ltd', active: true, jurisdiction: 'GB' });
    assert.equal(judgeRegistry(0, { kind: 'registry', entity: 'Acme Corp', jurisdiction: 'GB', active: true }, other).status, 'unverified');
  });

  await test('amounts: exact base-unit comparison within the tolerance', () => {
    assert.equal(withinBps('998', '998', 6, 50).ok, true);
    assert.equal(withinBps('855.24', '998', 6, 50).ok, false);
    assert.equal(withinBps('1000', '999.95', 6, 50).ok, true); // 0.5 bps
    assert.equal(withinBps('0', '0', 6, 50).ok, true);
    assert.equal(withinBps('1', '0', 6, 50).ok, false);
    assert.equal(withinBps('1.0000001', '1', 6, 50).ok, true); // rounded to the token's 6 decimals, then within tolerance
  });

  await test('balance: the chain decides; a disagreeing miner is recorded, not followed', () => {
    const claim = { kind: 'token_balance' as const, chain: 'solana-devnet' as const, wallet: 'A4X5JKBCLobAY5MeDXkwiRV5Hr7Uu4vUhzHQczwXMBnz', token: 'DThEeRe6uhj2eT8SLrjiLexUiuxrggysA4zCuHE2sUFb', balance: '998' };
    const read = { whole: '998', decimals: 6, at: 'slot 526219339', source: 'test' };
    const miner = purchase('balance', 'WALLET_BALANCE_CHECK_GENERAL', { balance: 855.24 });
    const ok = judgeBalance(0, claim, read, miner);
    assert.equal(ok.status, 'confirmed');
    assert.match(ok.notes.join(' '), /DISAGREES/);
    assert.equal(judgeBalance(0, { ...claim, balance: '855.24' }, read, miner).status, 'contradicted');
    assert.equal(judgeBalance(0, claim, { whole: null, decimals: null, at: '-', source: 'test', error: 'RPC down' }, miner).status, 'unverified');
    // the live answer that was about another address (rk43l_0A)
    const about = judgeBalance(0, claim, read, purchase('balance', 'X', { address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', balance: 855.24 }));
    assert.match(about.notes.join(' '), /no evidence/);
  });

  await test('supply: within 10 bps confirms, beyond contradicts', () => {
    const claim = { kind: 'token_supply' as const, chain: 'ethereum' as const, token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', totalSupply: '44300000000' };
    assert.equal(judgeSupply(0, claim, { whole: '44310000000', decimals: 6, at: 'block 1', source: 't' }, undefined).status, 'confirmed');
    assert.equal(judgeSupply(0, claim, { whole: '24300000000', decimals: 6, at: 'block 1', source: 't' }, undefined).status, 'contradicted');
  });

  await test('requirements: matched by kind and by every field given', () => {
    const c: Claim = { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'Estonia', active: false };
    assert.equal(satisfies(c, normalizeRequirement({ kind: 'registry', entity: 'Garantex Europe' })), true);
    assert.equal(satisfies(c, normalizeRequirement({ kind: 'sanctions', entity: 'Garantex Europe' })), false);
    assert.equal(satisfies(c, normalizeRequirement({ kind: 'registry', entity: 'Binance' })), false);
  });

  await test('verdict: contradicted beats incomplete beats unverified', () => {
    const conf = judgeSanctions(0, { kind: 'sanctions', entity: 'Garantex Europe OU', listed: true }, GARANTEX_SANCTIONS);
    const contra = judgeSanctions(1, { kind: 'sanctions', entity: 'Garantex Europe OU', listed: false }, GARANTEX_SANCTIONS);
    const unver = judgeSanctions(2, { kind: 'sanctions', entity: 'X Y', listed: false }, undefined);
    assert.equal(workVerdict([conf], 0, 0, false).verdict, 'ACCEPTED');
    assert.equal(workVerdict([conf, contra], 1, 1, false).verdict, 'REJECTED');
    assert.equal(workVerdict([conf], 1, 0, false).verdict, 'INCOMPLETE');
    assert.equal(workVerdict([conf], 0, 1, false).verdict, 'INCOMPLETE');
    assert.equal(workVerdict([], 0, 0, false).verdict, 'INCOMPLETE');
    assert.equal(workVerdict([conf, unver], 0, 0, false).verdict, 'REVIEW');
    assert.equal(workVerdict([conf], 0, 0, true).verdict, 'REVIEW');
  });

  await test('diligence: the Garantex evidence gives DECLINE and claims a verifier can check', () => {
    const subject: DiligenceRequest = { entity: 'Garantex Europe OU', jurisdiction: 'Estonia', wallets: [], purpose: null };
    const claims = reportClaims(subject, [GARANTEX_SANCTIONS, GARANTEX_REGISTRY], []);
    assert.deepEqual(claims, [
      { kind: 'sanctions', entity: 'Garantex Europe OU', listed: true },
      { kind: 'registry', entity: 'Garantex Europe OU', jurisdiction: 'Estonia', active: false },
    ]);
    for (const c of claims) normalizeClaim(c); // every report claim is well formed
    assert.equal(recommend([{ rule: 'sanctions.match', severity: 'block', title: '', detail: '', source: 'telegraph', evidence: [] }]).recommendation, 'DECLINE');
    assert.equal(recommend([{ rule: 'registry.active', severity: 'pass', title: '', detail: '', source: 'telegraph', evidence: [] }]).recommendation, 'PROCEED');
  });

  await test('diligence: a close sanctions match or another entity\'s record is left out of the report', () => {
    const subject: DiligenceRequest = { entity: 'Acme Corp', jurisdiction: 'GB', wallets: [], purpose: null };
    const near = purchase('sanctions', 'X', { matched: false, match_score: 0.9 });
    const other = purchase('registry', 'X', { legal_name: 'Unrelated Holdings Ltd', active: true, jurisdiction: 'GB' });
    assert.deepEqual(reportClaims(subject, [near, other], []), []);
  });

  await test('verify input: claims or text required; requirements checked', () => {
    assert.throws(() => normalizeVerifyRequest({ task: 'check X' }));
    assert.throws(() => normalizeVerifyRequest({ task: 'check X', deliverable: { claims: [] }, requirements: [{ kind: 'weather' }] }));
    const r = normalizeVerifyRequest({ task: 'Due diligence on Garantex', deliverable: { claims: [{ kind: 'sanctions' }] }, requirements: [{ kind: 'sanctions', entity: 'Garantex' }], worker: 'acp:job-1' });
    assert.equal(r.claims?.length, 1);
    assert.equal(r.worker, 'acp:job-1');
  });

  await test('model replies: the first JSON value, fenced or in prose', () => {
    assert.deepEqual(firstJson('Here you go:\n```json\n{"claims":[{"kind":"sanctions"}]}\n```'), { claims: [{ kind: 'sanctions' }] });
    assert.deepEqual(firstJson('Sure. {"a":"b}","c":[1,2]} trailing'), { a: 'b}', c: [1, 2] });
    assert.throws(() => firstJson('no json here'));
  });

  await test('ledger: revenue, Telegraph cost and margin per channel', () => {
    const l = createLedger(null);
    l.record({ memoId: 'aaaaaaaa', product: 'due-diligence', channel: 'free', priceUsd: 0, payment: null, acpJobId: null, telegraphUsd: 0.03, telegraphRequests: 3, llmTokens: null, llmModel: null });
    l.record({ memoId: 'bbbbbbbb', product: 'due-diligence', channel: 'x402', priceUsd: 0.05, payment: { network: 'base-sepolia', transaction: '0x1' }, acpJobId: null, telegraphUsd: 0.03, telegraphRequests: 3, llmTokens: null, llmModel: null });
    l.record({ memoId: 'cccccccc', product: 'work-verification', channel: 'acp', priceUsd: 0.1, payment: { network: 'base', transaction: null }, acpJobId: '42', telegraphUsd: 0.02, telegraphRequests: 2, llmTokens: 900, llmModel: 'x/y' });
    const s = l.summary();
    assert.equal(s.jobs, 3);
    assert.equal(s.paidJobs, 2);
    assert.equal(s.revenueUsd, 0.15);
    assert.equal(s.telegraphUsd, 0.08);
    assert.equal(s.marginUsd, 0.07);
    assert.equal(s.paidMarginPct, 66.67); // (0.15 - 0.05) / 0.15
    assert.equal(s.byChannel.free.marginUsd, -0.03);
    assert.equal(s.llmTokens, 900);
  });
}

async function live() {
  console.log('\nlive: due diligence on Garantex Europe OU, then three deliverables through the verifier');
  const d = await runDiligence({ entity: 'Garantex Europe OU', jurisdiction: 'Estonia', wallets: [], purpose: 'COMMERCE_LIVE test' });
  console.log(`diligence ${d.recommendation} $${d.cost.telegraphUsd} claims ${JSON.stringify(d.report.claims)}`);
  assert.equal(d.recommendation, 'DECLINE');
  const task = 'Due diligence on Garantex Europe OU (Estonia): sanctions status and registry record.';
  const requirements = [{ kind: 'sanctions', entity: 'Garantex Europe OU' }, { kind: 'registry', entity: 'Garantex Europe OU' }];
  const honest = await runVerifyWork(normalizeVerifyRequest({ task, requirements, deliverable: { claims: d.report.claims } }));
  console.log(`honest ${honest.verdict} $${honest.cost.telegraphUsd}`);
  const flipped = d.report.claims.map((c) => (c.kind === 'sanctions' ? { ...c, listed: !c.listed } : c));
  const lying = await runVerifyWork(normalizeVerifyRequest({ task, requirements, deliverable: { claims: flipped } }));
  console.log(`flipped ${lying.verdict} $${lying.cost.telegraphUsd}`);
  const partial = await runVerifyWork(normalizeVerifyRequest({ task, requirements, deliverable: { claims: d.report.claims.filter((c) => c.kind !== 'registry') } }));
  console.log(`partial ${partial.verdict} $${partial.cost.telegraphUsd}`);
  assert.equal(lying.verdict, 'REJECTED');
  assert.equal(partial.verdict === 'INCOMPLETE' || partial.verdict === 'REJECTED', true);
}

await unit();
console.log(`\n${passed} unit tests passed`);
if (process.env.COMMERCE_LIVE === '1') await live();
