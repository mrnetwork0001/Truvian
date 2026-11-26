/**
 * Counterparty due diligence: the report Truvian sells (Virtuals "Autonomous
 * Intelligence Business") and the evidence base of the investigation agent
 * (Tencent "Enterprise Decision Assurance").
 *
 * For one counterparty (legal name, jurisdiction, and up to three wallets with
 * the token each should hold), it buys the sanctions screening and the
 * corporate registry record from Telegraph's ranked miners, reads each wallet's
 * balance from the chain (with Telegraph's balance as a cross-check), and
 * recommends PROCEED, REVIEW or DECLINE under fixed rules (the settlement
 * desk's sanctions and registry rules).
 *
 * The report states its facts as claims in the verifier's format
 * (claims.ts), so any buyer can have the report checked independently by
 * POST /api/verify-work, or by an ACP evaluator, before paying for it.
 */
import {
  budgetUsd,
  buy,
  HOLD_PER_ASK_USD,
  memoCost,
  pooled,
  ROUTED_ASK_USD,
  Spend,
  unavailable,
  type FactContext,
  type Finding,
  type Planned,
  type PreflightRequest,
  type Purchase,
} from '../preflight.js';
import { registryJudge, sanctionsJudge, normName } from '../settlement.js';
import { apiKeyBalanceUsd } from '../telegraph.js';
import { ClaimInputError, normalizeClaim, type BalanceClaim, type Claim, type ClaimChain } from './claims.js';
import { readClaimAmount } from './verifyWork.js';

export type Recommendation = 'PROCEED' | 'REVIEW' | 'DECLINE';

export interface DiligenceRequest {
  entity: string;
  jurisdiction: string;
  wallets: Array<{ chain: ClaimChain; address: string; token: string }>;
  /** Optional: the decision this report serves, in the client's words */
  purpose: string | null;
}

export class DiligenceInputError extends Error {}

export function normalizeDiligenceRequest(raw: unknown): DiligenceRequest {
  if (typeof raw !== 'object' || raw === null) throw new DiligenceInputError('body must be a JSON object');
  const b = raw as Record<string, unknown>;
  const entity = typeof b.entity === 'string' ? b.entity.trim() : typeof b.counterparty === 'string' ? b.counterparty.trim() : '';
  if (entity.length < 2 || entity.length > 160) throw new DiligenceInputError('entity must be the counterparty\'s legal name');
  const jurisdiction = typeof b.jurisdiction === 'string' ? b.jurisdiction.trim() : '';
  if (jurisdiction.length < 2 || jurisdiction.length > 60) throw new DiligenceInputError('jurisdiction must name the country (or state) the counterparty is registered in');
  const ws = b.wallets === undefined ? [] : b.wallets;
  if (!Array.isArray(ws) || ws.length > 3) throw new DiligenceInputError('wallets must be a list of at most 3 {chain, address, token}');
  const wallets = ws.map((w, i) => {
    const o = (w ?? {}) as Record<string, unknown>;
    try {
      // A zero balance claim only borrows the claim parser's address and chain checks
      const c = normalizeClaim({ kind: 'token_balance', chain: o.chain, wallet: o.address ?? o.wallet, token: o.token, balance: '0' }) as BalanceClaim;
      return { chain: c.chain, address: c.wallet, token: c.token };
    } catch (err) {
      if (err instanceof ClaimInputError) throw new DiligenceInputError(`wallet ${i + 1}: ${err.message}`);
      throw err;
    }
  });
  const purpose = typeof b.purpose === 'string' && b.purpose.trim() ? b.purpose.trim().slice(0, 500) : null;
  return { entity, jurisdiction, wallets, purpose };
}

export interface DiligenceMemo {
  version: 'truvian-work-memo/1';
  kind: 'due-diligence';
  createdAt: string;
  subject: DiligenceRequest;
  purchases: Purchase[];
  walletReads: Array<{ chain: string; address: string; token: string; symbol: string | null; whole: string | null; at: string; source: string; error?: string }>;
  findings: Finding[];
  recommendation: Recommendation;
  recommendationRule: string;
  /** The report's facts as checkable claims (claims.ts); only facts the evidence supports */
  report: { summary: string; claims: Claim[] };
  network: { telegraphNode: string; settlement: string };
  cost: ReturnType<typeof memoCost> & { budgetUsd: number; escrowBeforeUsd: number | null };
  latencyMs: number;
}

export interface DiligenceEvents {
  onPlan?: (plan: Array<{ key: string; intent: string }>, escrowUsd: number | null) => void;
  onPurchase?: (p: Purchase) => void;
}

export function recommend(findings: Finding[]): { recommendation: Recommendation; rule: string } {
  if (findings.some((f) => f.severity === 'block')) return { recommendation: 'DECLINE', rule: 'at least one finding rules the counterparty out' };
  if (findings.some((f) => f.severity === 'review')) return { recommendation: 'REVIEW', rule: 'nothing rules the counterparty out, but at least one finding needs a person' };
  return { recommendation: 'PROCEED', rule: 'every check was answered and none holds the counterparty back' };
}

/** The claims the evidence supports. A fact the evidence does not settle is left out, not guessed. */
export function reportClaims(req: DiligenceRequest, purchases: Purchase[], reads: DiligenceMemo['walletReads']): Claim[] {
  const out: Claim[] = [];
  const s = purchases.find((p) => p.key === 'sanctions');
  if (s?.ok && s.fields && typeof s.fields.matched === 'boolean') {
    const score = typeof s.fields.match_score === 'number' ? s.fields.match_score : Number(s.fields.match_score);
    const near = s.fields.matched === false && Number.isFinite(score) && score >= 0.85;
    if (!near) out.push({ kind: 'sanctions', entity: req.entity, listed: s.fields.matched });
  }
  const r = purchases.find((p) => p.key === 'registry');
  if (r?.ok && r.fields) {
    const f = r.fields;
    const legal = typeof f.legal_name === 'string' && f.legal_name.trim() ? f.legal_name.trim() : undefined;
    const sameEntity = !legal || (() => { const a = normName(legal), b = normName(req.entity); return a === b || a.includes(b) || b.includes(a); })();
    if (sameEntity) {
      const c: Claim = { kind: 'registry', entity: req.entity, jurisdiction: typeof f.jurisdiction === 'string' && f.jurisdiction.trim() ? f.jurisdiction.trim() : req.jurisdiction };
      if (typeof f.active === 'boolean') c.active = f.active;
      if (typeof f.registration_id === 'string' && f.registration_id.trim()) c.registrationId = f.registration_id.trim();
      if (legal) c.legalName = legal;
      if (c.active !== undefined || c.registrationId !== undefined || c.legalName !== undefined) out.push(c);
    }
  }
  for (const w of reads) if (w.whole !== null) out.push({ kind: 'token_balance', chain: w.chain as ClaimChain, wallet: w.address, token: w.token, balance: w.whole });
  return out;
}

function summaryOf(req: DiligenceRequest, rec: Recommendation, findings: Finding[]): string {
  const holds = findings.filter((f) => f.severity === 'block' || f.severity === 'review').map((f) => f.title);
  const passes = findings.filter((f) => f.severity === 'pass').map((f) => f.title);
  return `${req.entity} (${req.jurisdiction}): ${rec}. ${holds.length ? `Held back by: ${holds.join('; ')}.` : ''}${passes.length ? ` Cleared: ${passes.join('; ')}.` : ''}`.trim();
}

export async function runDiligence(req: DiligenceRequest, events: DiligenceEvents = {}): Promise<DiligenceMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();

  const reads = await Promise.all(req.wallets.map(async (w) => {
    const r = await readClaimAmount({ kind: 'token_balance', chain: w.chain, wallet: w.address, token: w.token, balance: '0' });
    return { chain: w.chain, address: w.address, token: w.token, symbol: r.symbol, whole: r.whole, at: r.at, source: r.source, ...(r.error ? { error: r.error } : {}), label: r.label };
  }));

  const plan: Planned[] = [
    { key: 'sanctions', intent: 'SANCTIONS_SCREENING_MATCH_GENERAL', params: { name: req.entity }, question: `Is ${req.entity} on a sanctions list?` },
    { key: 'registry', intent: 'CORPORATE_REGISTRY_LOOKUP_GENERAL', params: { company: req.entity, jurisdiction: req.jurisdiction }, question: `Corporate registry record of ${req.entity} (${req.jurisdiction}): legal name, registration id, active or not, jurisdiction.` },
    ...reads.map((r, i): Planned => ({ key: 'balance', holding: i, intent: 'WALLET_BALANCE_CHECK_GENERAL', params: { address: r.address, chain: r.chain, token: r.token }, question: `What is the ${r.symbol ?? 'token'} (${r.token}) balance of ${r.address} on ${r.label}, in whole tokens?` })),
  ];

  // Bound to its wallet: the second-opinion path judges an answer before buy() sets its index
  const balanceJudge = (i: number) => (p: Purchase): Finding[] => {
    const r = reads[i]!;
    if (!p.ok || !p.fields) return [{ ...unavailable(p, 'balance', 'Wallet balance (Telegraph)'), severity: 'info' }];
    const about = typeof p.fields.address === 'string' ? p.fields.address.trim() : '';
    if (about && about.toLowerCase() !== r.address.toLowerCase()) return [{ rule: 'balance.not_about_wallet', severity: 'review', title: `Telegraph's balance is about another address`, detail: `Asked about ${r.address}, the answer is about ${about}.`, source: 'telegraph', evidence: ['balance'] }];
    const told = Number(p.fields.balance);
    if (!Number.isFinite(told)) return [{ rule: 'balance.missing', severity: 'review', title: 'Telegraph gave no balance', detail: `Field status ${JSON.stringify(p.fieldStatus)}.`, source: 'telegraph', evidence: ['balance'] }];
    if (r.whole === null) return [{ rule: 'balance.chain_unread', severity: 'info', title: `Telegraph says ${told}`, detail: 'The chain read failed, so there is nothing to compare it with.', source: 'telegraph', evidence: ['balance'] }];
    const chain = Number(r.whole);
    const bps = chain === told ? 0 : (Math.abs(told - chain) / Math.max(Math.abs(chain), 1e-18)) * 10_000;
    return bps <= 50
      ? [{ rule: 'balance.agrees', severity: 'pass', title: `Wallet ${r.address.slice(0, 8)}… holds ${r.whole} (Telegraph agrees)`, detail: `${told} vs ${r.whole} at ${r.at}.`, source: 'telegraph+chain', evidence: ['balance'] }]
      : [{ rule: 'balance.conflict', severity: 'review', title: `Telegraph's balance conflicts with the chain`, detail: `Telegraph says ${told}, the chain says ${r.whole} at ${r.at}.`, source: 'telegraph+chain', evidence: ['balance'] }];
  };
  const judgeOf = (i: number | undefined) => (p: Purchase): Finding[] => (p.key === 'sanctions' ? sanctionsJudge(p, req.entity) : p.key === 'registry' ? registryJudge(p, req.entity, req.jurisdiction) : balanceJudge(i ?? 0)(p));

  const budget = budgetUsd();
  const escrow = await apiKeyBalanceUsd();
  events.onPlan?.(plan.map(({ key, intent }) => ({ key, intent })), escrow);
  const policyFindings: Finding[] = [];
  let purchases: Purchase[] = [];
  const expected = plan.length * ROUTED_ASK_USD;
  if (expected > budget + 1e-9) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `The checks would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per report. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds per ask. Nothing was bought.`, source: 'policy', evidence: [] });
  } else {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    const spend = new Spend(budget, expected);
    const ctx = (i: number | undefined) => ({ req: { mode: 'listing', chain: 'ethereum', token: '0x0000000000000000000000000000000000000000', issuer: req.entity } as unknown as PreflightRequest, facts: null as unknown as FactContext['facts'], treasuryRead: null, judgeAll: judgeOf(i), spend });
    purchases = await pooled(plan.map((p) => () => buy(p, ctx(p.holding))), parallel, (p) => events.onPurchase?.(p));
  }

  const chainFindings: Finding[] = reads.flatMap((r): Finding[] => (r.whole === null
    ? [{ rule: 'wallet.unreadable', severity: 'review', title: `Wallet ${r.address.slice(0, 8)}… unreadable`, detail: `${r.error ?? 'No read'} (${r.source}).`, source: 'chain', evidence: [] }]
    : [{ rule: 'wallet.read', severity: 'info', title: `Wallet ${r.address.slice(0, 8)}… holds ${r.whole} ${r.symbol ?? ''}`.trim(), detail: `At ${r.at} (${r.source}).`, source: 'chain', evidence: [] }]));
  const order = { block: 0, review: 1, info: 2, pass: 3 } as const;
  const findings = [...policyFindings, ...purchases.flatMap((p) => judgeOf(p.holding)(p)), ...chainFindings].sort((a, b) => order[a.severity] - order[b.severity]);
  const { recommendation, rule } = recommend(findings);
  const walletReads = reads.map(({ label: _l, ...r }) => r);

  return {
    version: 'truvian-work-memo/1',
    kind: 'due-diligence',
    createdAt,
    subject: req,
    purchases,
    walletReads,
    findings,
    recommendation,
    recommendationRule: rule,
    report: { summary: summaryOf(req, recommendation, findings), claims: reportClaims(req, purchases, walletReads) },
    network: {
      telegraphNode: process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com',
      settlement: 'Telegraph answers: Anjoman escrow, test USDC on Ethereum Sepolia (testnet). Wallet balances: read from the chain named in each wallet.',
    },
    cost: { ...memoCost(purchases), budgetUsd: budget, escrowBeforeUsd: escrow },
    latencyMs: Date.now() - started,
  };
}
