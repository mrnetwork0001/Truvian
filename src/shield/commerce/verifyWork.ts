/**
 * Independent work verification (Tencent "Independent Enterprise Agent
 * Verification" and Virtuals "Independent Agent Commerce Evaluation").
 *
 * An agent's deliverable is reduced to claims (claims.ts). For each claim,
 * Truvian buys its own evidence: the fact from Telegraph's ranked miners,
 * with a receipt, and for on-chain claims a direct read of the chain. It never
 * reuses an answer bought for the work being checked (buy(..., {noReuse})).
 * Fixed rules then say ACCEPTED, REJECTED (a claim is contradicted),
 * INCOMPLETE (a required item is not covered, or a claim is malformed) or
 * REVIEW (a claim could not be verified). The memo is signed like every desk's.
 *
 * Claims come either as structured JSON or, for a free-text deliverable, are
 * extracted by the agent model (llm.ts). Extracted claims are recorded with
 * the model that extracted them; the verdict still rests only on evidence.
 */
import { formatUnits, parseAbi } from 'viem';
import { getClient, type SupportedChain } from '../../config/chains.js';
import {
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
  type PurchaseKey,
} from '../preflight.js';
import { registryJudge, sanctionsJudge } from '../settlement.js';
import { readBalance, readMint, SOLANA_LABEL } from '../solana.js';
import { apiKeyBalanceUsd } from '../telegraph.js';
import { anchorBlock, readTokenFacts } from '../tokenFacts.js';
import {
  ClaimInputError,
  claimLabel,
  isSolanaChain,
  judgeBalance,
  judgeRegistry,
  judgeSanctions,
  judgeSupply,
  normalizeClaim,
  normalizeRequirement,
  satisfies,
  VERIFY_POLICY,
  workVerdict,
  type AmountRead,
  type Claim,
  type ClaimCheck,
  type Requirement,
  type WorkVerdict,
} from './claims.js';
import { extractClaims, type LlmUse } from './llm.js';

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface VerifyWorkRequest {
  /** What the agent was asked to do */
  task: string;
  /** What the task had to cover */
  requirements: Requirement[];
  /** Claims as given (structured), or null when the deliverable is text */
  claims: unknown[] | null;
  /** A free-text deliverable, when claims are not given */
  text: string | null;
  /** Who did the work, as the caller names it (an agent id, a job id) */
  worker: string | null;
}

export class VerifyInputError extends Error {}

export function verifyBudgetUsd(): number {
  const n = Number(process.env.SHIELD_VERIFY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.2;
}

export function normalizeVerifyRequest(raw: unknown): VerifyWorkRequest {
  if (typeof raw !== 'object' || raw === null) throw new VerifyInputError('body must be a JSON object');
  const b = raw as Record<string, unknown>;
  const task = typeof b.task === 'string' ? b.task.trim() : '';
  if (task.length < 3 || task.length > 2000) throw new VerifyInputError('task must say what the agent was asked to do (3 to 2000 characters)');
  const reqs = b.requirements === undefined ? [] : b.requirements;
  if (!Array.isArray(reqs) || reqs.length > VERIFY_POLICY.maxRequirements) throw new VerifyInputError(`requirements must be a list of at most ${VERIFY_POLICY.maxRequirements}`);
  let requirements: Requirement[];
  try {
    requirements = reqs.map(normalizeRequirement);
  } catch (err) {
    if (err instanceof ClaimInputError) throw new VerifyInputError(err.message);
    throw err;
  }
  const d = (typeof b.deliverable === 'object' && b.deliverable !== null ? b.deliverable : b) as Record<string, unknown>;
  const claims = Array.isArray(d.claims) ? d.claims : null;
  const text = typeof d.text === 'string' && d.text.trim() ? d.text.trim().slice(0, 20_000) : typeof b.deliverable === 'string' && b.deliverable.trim() ? b.deliverable.trim().slice(0, 20_000) : null;
  if (claims === null && text === null) throw new VerifyInputError('deliverable must carry claims (a list) or text');
  if (claims !== null && claims.length > 64) throw new VerifyInputError('at most 64 claims');
  const worker = typeof b.worker === 'string' && b.worker.trim() ? b.worker.trim().slice(0, 120) : null;
  return { task, requirements, claims, text, worker };
}

export interface ChainReadRecord { claim: number; kind: 'balance' | 'supply'; chain: string; whole: string | null; at: string; source: string; error?: string }

export interface WorkMemo {
  version: 'truvian-work-memo/1';
  kind: 'work-verification';
  createdAt: string;
  task: string;
  worker: string | null;
  requirements: Requirement[];
  /** How the claims were obtained */
  claimsFrom: 'structured' | 'extracted';
  /** Set when claims were extracted from text: the model, its raw output, and its usage */
  extraction: (LlmUse & { text: string; raw: string }) | null;
  claims: Claim[];
  /** Claims that were not well formed, with why; they count against completeness */
  malformed: Array<{ index: number; error: string }>;
  /** Claims beyond the limit, not checked */
  skipped: number;
  checks: ClaimCheck[];
  /** Requirements no claim covers */
  missing: Requirement[];
  chainReads: ChainReadRecord[];
  purchases: Purchase[];
  policyFindings: Finding[];
  verdict: WorkVerdict;
  verdictRule: string;
  network: { telegraphNode: string; settlement: string; independence: string };
  cost: ReturnType<typeof memoCost> & { budgetUsd: number; escrowBeforeUsd: number | null; llmTokens: number | null };
  latencyMs: number;
  policy: typeof VERIFY_POLICY;
}

export interface VerifyEvents {
  onClaims?: (claims: Claim[], malformed: Array<{ index: number; error: string }>, extraction: WorkMemo['extraction']) => void;
  onPlan?: (plan: Array<{ claim: number; intent: string }>, escrowUsd: number | null) => void;
  onPurchase?: (p: Purchase) => void;
  onCheck?: (c: ClaimCheck) => void;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export async function readClaimAmount(claim: Claim & { kind: 'token_balance' | 'token_supply' }): Promise<AmountRead & { symbol: string | null; label: string }> {
  try {
    if (isSolanaChain(claim.chain)) {
      const label = SOLANA_LABEL[claim.chain];
      const mint = await readMint(claim.chain, claim.token);
      if (!mint.isMint || mint.decimals === null) return { whole: null, decimals: null, at: '-', source: `${label} getAccountInfo`, error: `${claim.token} is not a token mint on ${label}`, symbol: null, label };
      if (claim.kind === 'token_supply') return { whole: mint.supply, decimals: mint.decimals, at: `slot ${mint.slot}`, source: `${label} mint account (${mint.sources.join('; ')})`, symbol: null, label };
      const bal = await readBalance(claim.chain, claim.wallet, claim.token, mint.decimals);
      return { whole: bal.whole, decimals: mint.decimals, at: `slot ${bal.slot}`, source: `${label} token accounts (${bal.sources.join('; ')})`, symbol: null, label };
    }
    const chain = claim.chain as SupportedChain;
    const anchor = await anchorBlock(chain);
    const facts = await readTokenFacts(chain, claim.token as `0x${string}`, anchor);
    const label = facts.chainLabel;
    const at = `block ${facts.block}`;
    if (!facts.isContract || facts.decimals === null) return { whole: null, decimals: null, at, source: `${label} JSON-RPC`, error: `${claim.token} has no ERC-20 contract on ${label} at ${at}`, symbol: facts.symbol, label };
    if (claim.kind === 'token_supply') return { whole: facts.totalSupply, decimals: facts.decimals, at, source: `${label} JSON-RPC totalSupply() (Truvian chain registry, not Telegraph)`, symbol: facts.symbol, label };
    const raw = await getClient(chain).readContract({ address: claim.token as `0x${string}`, abi: ERC20, functionName: 'balanceOf', args: [claim.wallet as `0x${string}`], blockNumber: anchor.number });
    return { whole: formatUnits(raw, facts.decimals), decimals: facts.decimals, at, source: `${label} JSON-RPC balanceOf() (Truvian chain registry, not Telegraph)`, symbol: facts.symbol, label };
  } catch (err) {
    return { whole: null, decimals: null, at: '-', source: `${claim.chain} RPC`, error: err instanceof Error ? err.message.slice(0, 200) : String(err), symbol: null, label: claim.chain };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Turn the request into claims: structured, or extracted from text by the agent model. */
async function claimsOf(req: VerifyWorkRequest): Promise<{ claims: Claim[]; malformed: Array<{ index: number; error: string }>; skipped: number; from: WorkMemo['claimsFrom']; extraction: WorkMemo['extraction'] }> {
  let rawClaims: unknown[];
  let from: WorkMemo['claimsFrom'] = 'structured';
  let extraction: WorkMemo['extraction'] = null;
  if (req.claims !== null) rawClaims = req.claims;
  else {
    const ex = await extractClaims(req.task, req.text!);
    rawClaims = ex.claims;
    from = 'extracted';
    extraction = { ...ex.use, text: req.text!, raw: ex.raw };
  }
  const claims: Claim[] = [];
  const malformed: Array<{ index: number; error: string }> = [];
  rawClaims.forEach((c, index) => {
    try {
      claims.push(normalizeClaim(c));
    } catch (err) {
      if (!(err instanceof ClaimInputError)) throw err;
      malformed.push({ index, error: err.message });
    }
  });
  const skipped = Math.max(0, claims.length - VERIFY_POLICY.maxClaims);
  return { claims: claims.slice(0, VERIFY_POLICY.maxClaims), malformed, skipped, from, extraction };
}

export async function runVerifyWork(req: VerifyWorkRequest, events: VerifyEvents = {}): Promise<WorkMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const { claims, malformed, skipped, from, extraction } = await claimsOf(req);
  events.onClaims?.(claims, malformed, extraction);

  // Chain reads first: they are free, and they name the token for the Telegraph question.
  const reads = new Map<number, Awaited<ReturnType<typeof readClaimAmount>>>();
  await Promise.all(claims.map(async (c, i) => {
    if (c.kind === 'token_balance' || c.kind === 'token_supply') reads.set(i, await readClaimAmount(c));
  }));

  const plan: Planned[] = [];
  claims.forEach((c, i) => {
    switch (c.kind) {
      case 'sanctions':
        plan.push({ key: 'sanctions', holding: i, intent: 'SANCTIONS_SCREENING_MATCH_GENERAL', params: { name: c.entity }, question: `Is ${c.entity} on a sanctions list?` });
        break;
      case 'registry':
        plan.push({ key: 'registry', holding: i, intent: 'CORPORATE_REGISTRY_LOOKUP_GENERAL', params: { company: c.entity, jurisdiction: c.jurisdiction }, question: `Corporate registry record of ${c.entity} (${c.jurisdiction}): legal name, registration id, active or not, jurisdiction.` });
        break;
      case 'token_balance': {
        const r = reads.get(i)!;
        plan.push({ key: 'balance', holding: i, intent: 'WALLET_BALANCE_CHECK_GENERAL', params: { address: c.wallet, chain: c.chain, token: c.token }, question: `What is the ${r.symbol ?? 'token'} (${c.token}) balance of ${c.wallet} on ${r.label}, in whole tokens?` });
        break;
      }
      case 'token_supply': {
        const r = reads.get(i)!;
        plan.push({ key: 'supply', holding: i, intent: 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', params: { token: `${r.symbol ?? 'token'} (${c.token}) on ${r.label}` }, question: `What is the current total supply of ${r.symbol ?? 'token'} (${c.token}) on ${r.label}, in whole tokens?` });
        break;
      }
    }
  });

  const budget = verifyBudgetUsd();
  const escrow = plan.length ? await apiKeyBalanceUsd() : null;
  events.onPlan?.(plan.map((p) => ({ claim: p.holding!, intent: p.intent })), escrow);
  const policyFindings: Finding[] = [];
  let purchases: Purchase[] = [];
  const expected = plan.length * ROUTED_ASK_USD;
  if (plan.length && expected > budget + 1e-9) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `The checks would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per verification. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length && escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds per ask. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length) {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    const spend = new Spend(budget, expected);
    // The shared buy() path decides second opinions from a fact's own findings; give it this claim's.
    // Bound to its claim: the second-opinion path judges an answer before buy() sets its index
    const evidenceOf = (i: number) => (p: Purchase): Finding[] => {
      const c = claims[i]!;
      if (c.kind === 'sanctions') return sanctionsJudge(p, c.entity);
      if (c.kind === 'registry') return registryJudge(p, c.entity, c.jurisdiction);
      if (!p.ok || !p.fields) return [unavailable(p, p.key as PurchaseKey, p.key === 'balance' ? 'Wallet balance' : 'Total supply')];
      const field = p.key === 'balance' ? 'balance' : 'total_supply';
      const v = p.fields[field];
      if (v === null || v === undefined || v === '') return [{ rule: `${p.key}.missing`, severity: 'review', title: 'No figure', detail: `The answer carried no ${field}.`, source: 'telegraph', evidence: [p.key as PurchaseKey] }];
      if (p.key === 'balance' && c.kind === 'token_balance' && typeof p.fields.address === 'string' && p.fields.address.trim() && p.fields.address.trim().toLowerCase() !== c.wallet.toLowerCase()) {
        return [{ rule: 'balance.not_about_wallet', severity: 'review', title: 'About another address', detail: `The answer is about ${p.fields.address}, not ${c.wallet}.`, source: 'telegraph', evidence: ['balance'] }];
      }
      return [{ rule: `${p.key}.answered`, severity: 'info', title: 'Answered', detail: '', source: 'telegraph', evidence: [p.key as PurchaseKey] }];
    };
    const ctx = (i: number) => ({ req: { mode: 'listing', chain: 'ethereum', token: '0x0000000000000000000000000000000000000000' } as unknown as PreflightRequest, facts: null as unknown as FactContext['facts'], treasuryRead: null, judgeAll: evidenceOf(i), spend });
    purchases = await pooled(plan.map((p) => () => buy(p, ctx(p.holding!), { noReuse: true })), parallel, (p) => events.onPurchase?.(p));
  }

  const chainReads: ChainReadRecord[] = [];
  const checks: ClaimCheck[] = claims.map((c, i) => {
    const p = purchases.find((x) => x.holding === i);
    let out: ClaimCheck;
    if (c.kind === 'sanctions') out = judgeSanctions(i, c, p);
    else if (c.kind === 'registry') out = judgeRegistry(i, c, p);
    else {
      const r = reads.get(i)!;
      chainReads.push({ claim: i, kind: c.kind === 'token_balance' ? 'balance' : 'supply', chain: c.chain, whole: r.whole, at: r.at, source: r.source, ...(r.error ? { error: r.error } : {}) });
      out = c.kind === 'token_balance' ? judgeBalance(i, c, r, p) : judgeSupply(i, c, r, p);
    }
    events.onCheck?.(out);
    return out;
  });

  const missing = req.requirements.filter((r) => !claims.some((c) => satisfies(c, r)));
  // A policy hold (nothing could be bought) leaves the Telegraph-backed claims unverified, so the work goes to a person
  const held = policyFindings.length > 0;
  const { verdict, rule } = workVerdict(checks, missing.length, malformed.length + skipped, held);

  return {
    version: 'truvian-work-memo/1',
    kind: 'work-verification',
    createdAt,
    task: req.task,
    worker: req.worker,
    requirements: req.requirements,
    claimsFrom: from,
    extraction,
    claims,
    malformed,
    skipped,
    checks,
    missing,
    chainReads,
    purchases,
    policyFindings,
    verdict,
    verdictRule: rule,
    network: {
      telegraphNode: process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com',
      settlement: 'Telegraph answers: Anjoman escrow, test USDC on Ethereum Sepolia (testnet). Chain reads: the chain named in each claim.',
      independence: 'Every fact is bought fresh for this verification (no answer bought for the work under review is reused), and on-chain claims are decided by Truvian\'s own chain reads, with Telegraph as a cross-check.',
    },
    cost: { ...memoCost(purchases), budgetUsd: budget, escrowBeforeUsd: escrow, llmTokens: extraction?.totalTokens ?? null },
    latencyMs: Date.now() - started,
    policy: VERIFY_POLICY,
  };
}

export { claimLabel };
