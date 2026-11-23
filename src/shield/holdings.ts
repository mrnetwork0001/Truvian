/**
 * Truvian Shield holdings proof (Mission 13, Asset Management): "a daily
 * holdings proof an investor agent can verify without the issuer", with
 * receipts on liquidity and float for index rebalancing.
 *
 * A fund or index states what a custody wallet holds: up to three tokens,
 * each with the amount it claims and, optionally, the DEX pool it is
 * rebalanced through. Shield, not the issuer, checks each claim:
 *  1. Free direct chain reads at ONE block for every holding: the token's
 *     contract (code, symbol, decimals, totalSupply) and balanceOf(wallet).
 *  2. Through Telegraph, one routed ask per fact, paid from escrow with a
 *     receipt: the wallet's balance of the token (WALLET_BALANCE_CHECK), the
 *     token's total supply (TOKEN_TOTAL_SUPPLY_VERIFY), and the pool's USD
 *     liquidity (LIQUIDITY_DEPTH_VERIFY) when a pool is given. The same
 *     second-opinion and reuse rules as the other desks (preflight.ts).
 *  3. Fixed rules (`evaluateHoldings`, pure):
 *     - REJECT when the chain shows a holding short of its claim beyond the
 *       tolerance, or a claimed "token" that is not a contract;
 *     - REVIEW when a bought answer is missing, carries no figure, or
 *       disagrees with the chain read (conflicting sources need a person);
 *     - VERIFIED only when every claim is covered on the chain and every
 *       bought answer agrees with it.
 *     The holding's share of the token's float (balance / totalSupply) and
 *     the pool's depth are stated for rebalancing.
 * The memo is signed like the other desks' (memo.ts), with its cost line.
 */
import { formatUnits, getAddress, parseAbi, parseUnits } from 'viem';
import { getClient, type SupportedChain } from '../config/chains.js';
import { apiKeyBalanceUsd } from './telegraph.js';
import { anchorBlock, parseAddress, parseChain, readTokenFacts, TokenFactsError } from './tokenFacts.js';
import {
  budgetUsd,
  buy,
  HOLD_PER_ASK_USD,
  HOLDINGS_POLICY,
  liquidityFindings,
  memoCost,
  pooled,
  POLICY,
  PreflightInputError,
  relDiffBps,
  ROUTED_ASK_USD,
  Spend,
  supplyFindings,
  unavailable,
  type Decision,
  type Finding,
  type HoldingRead,
  type Planned,
  type PreflightMemo,
  type PreflightRequest,
  type Purchase,
} from './preflight.js';

export interface HoldingsRequest {
  mode: 'holdings';
  chain: SupportedChain;
  /** The custody wallet the fund says holds the tokens */
  wallet: `0x${string}`;
  holdings: Array<{ token: `0x${string}`; claimed: string; pool?: `0x${string}` }>;
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
/** A claimed amount in whole tokens: digits, an optional fraction, thousands commas allowed */
const AMOUNT = /^\d{1,30}(\.\d{1,30})?$/;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export function normalizeHoldingsRequest(raw: unknown): HoldingsRequest {
  if (typeof raw !== 'object' || raw === null) throw new PreflightInputError('body must be a JSON object');
  const body = raw as Record<string, unknown>;
  try {
    const chain = parseChain(body.chain ?? 'ethereum');
    const wallet = parseAddress(body.wallet, 'wallet');
    const list = Array.isArray(body.holdings) ? body.holdings : [];
    if (list.length === 0) throw new PreflightInputError('a holdings proof needs holdings: [{token, claimed, pool?}, ...]');
    if (list.length > HOLDINGS_POLICY.maxHoldings) throw new PreflightInputError(`at most ${HOLDINGS_POLICY.maxHoldings} holdings per proof`);
    const seen = new Set<string>();
    const holdings = list.map((h, i) => {
      if (typeof h !== 'object' || h === null) throw new PreflightInputError(`holding ${i + 1} must be {token, claimed, pool?}`);
      const item = h as Record<string, unknown>;
      const token = parseAddress(item.token, `holding ${i + 1} token`);
      if (seen.has(token)) throw new PreflightInputError(`holding ${i + 1} repeats ${token}`);
      seen.add(token);
      const claimed = String(item.claimed ?? '').trim().replace(/,/g, '');
      if (!AMOUNT.test(claimed) || /^0+(\.0+)?$/.test(claimed)) throw new PreflightInputError(`holding ${i + 1} claimed must be a positive amount in whole tokens, such as 2400000 or 1.5`);
      const out: HoldingsRequest['holdings'][number] = { token, claimed };
      if (item.pool !== undefined && item.pool !== null && String(item.pool).trim() !== '') out.pool = parseAddress(item.pool, `holding ${i + 1} pool`);
      return out;
    });
    return { mode: 'holdings', chain, wallet, holdings };
  } catch (err) {
    if (err instanceof TokenFactsError) throw new PreflightInputError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rules (pure)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const whole = (s: string) => Number(s).toLocaleString('en-US', { maximumFractionDigits: 6 });

function labelOf(read: HoldingRead): string {
  return read.facts.symbol ?? `${read.token.slice(0, 8)}…`;
}

/** A request shaped like the other desks', for the rules shared with them (liquidity, second opinions). */
export function asPreflightRequest(req: Pick<HoldingsRequest, 'chain'>, read: Pick<HoldingRead, 'token' | 'pool'>): PreflightRequest {
  const out: PreflightRequest = { mode: 'holdings', chain: req.chain, token: read.token };
  if (read.pool) out.pool = read.pool;
  return out;
}

/** The claim against the chain read: covered, short, or not readable. */
function claimFindings(read: HoldingRead, wallet: string): Finding[] {
  const sym = labelOf(read);
  const f = read.facts;
  if (!f.isContract) {
    return [{ rule: 'holding.not_a_contract', severity: 'block', title: `${sym}: not a token`, detail: `${read.token} has no contract code on ${f.chainLabel} at block ${f.block}, so the wallet cannot hold it as a token. The claim of ${read.claimed} is false as stated.`, source: 'chain', evidence: [] }];
  }
  if (f.decimals === null || read.balanceRaw === null || read.balance === null) {
    return [{ rule: 'holding.no_chain_read', severity: 'review', title: `${sym}: balance unreadable`, detail: `${read.token} did not answer decimals() and balanceOf(${wallet}) like an ERC-20 at block ${f.block}, so the claim cannot be checked against the chain.`, source: 'chain', evidence: [] }];
  }
  // parseUnits rounds a fraction longer than the token's decimals; a claim like that cannot be held exactly
  const fraction = read.claimed.split('.')[1] ?? '';
  let claimedRaw: bigint;
  try {
    if (fraction.length > f.decimals) throw new Error('too many decimals');
    claimedRaw = parseUnits(read.claimed, f.decimals);
  } catch {
    return [{ rule: 'holding.claim_unreadable', severity: 'review', title: `${sym}: claim has more decimals than the token`, detail: `${read.claimed} cannot be written with ${f.decimals} decimals.`, source: 'policy', evidence: [] }];
  }
  const raw = BigInt(read.balanceRaw);
  const tol = BigInt(HOLDINGS_POLICY.claimShortfallToleranceBps);
  if (raw * 10_000n >= claimedRaw * (10_000n - tol)) {
    const surplus = raw >= claimedRaw ? `${formatUnits(raw - claimedRaw, f.decimals)} above the claim` : `${formatUnits(claimedRaw - raw, f.decimals)} below it, within the ${HOLDINGS_POLICY.claimShortfallToleranceBps} bps tolerance`;
    return [{ rule: 'holding.covered', severity: 'pass', title: `${sym}: ${whole(read.balance)} held, ${whole(read.claimed)} claimed`, detail: `balanceOf(${wallet}) is ${read.balance} ${sym} at block ${f.block} on ${f.chainLabel}: ${surplus}.`, source: 'chain', evidence: [] }];
  }
  const shortBps = Number(((claimedRaw - raw) * 1_000_000n) / claimedRaw) / 100;
  return [{ rule: 'holding.short', severity: 'block', title: `${sym}: ${shortBps.toFixed(2)} bps short of the claim`, detail: `The fund claims ${read.claimed} ${sym}, but balanceOf(${wallet}) is ${read.balance} at block ${f.block} on ${f.chainLabel}: ${formatUnits(claimedRaw - raw, f.decimals)} missing (${(shortBps / 100).toFixed(4)}%), beyond the ${HOLDINGS_POLICY.claimShortfallToleranceBps} bps tolerance.`, source: 'chain', evidence: [] }];
}

/**
 * Telegraph's balance answer against the chain read.
 *
 * Seen live on 2026-11-23 (signals 0xcb5a6bdd… and 0x4ccd09d7…, miner 9002
 * TxLens): asked for the USDC and ENS balances of the ENS DAO timelock, the
 * ranked miner answered balance 0 with `address` set to the token contract.
 * It read the token's own balance, not the wallet's. An answer whose address
 * field names another account is not about this wallet, so it is no evidence
 * and a second opinion is asked, as for a security review of another token.
 */
export function balanceFindings(p: Purchase | undefined, read: HoldingRead, wallet: string): Finding[] {
  const sym = labelOf(read);
  if (!p || !p.ok || !p.fields) return [unavailable(p, 'balance', 'Wallet balance')];
  const answeredFor = typeof p.fields.address === 'string' ? p.fields.address.trim() : '';
  if (/^0x[0-9a-fA-F]{40}$/.test(answeredFor) && answeredFor.toLowerCase() !== wallet.toLowerCase()) {
    return [{ rule: 'balance.not_about_wallet', severity: 'review', title: 'Wallet balance: about another address', detail: `The answer gives a balance of ${String(p.fields.balance)} for ${answeredFor}${answeredFor.toLowerCase() === read.token.toLowerCase() ? ', the token contract itself,' : ''} not for the wallet ${wallet}, so it is no evidence about this holding.`, source: 'telegraph', evidence: ['balance'] }];
  }
  const told = num(p.fields.balance);
  if (told === null) return [{ rule: 'balance.missing', severity: 'review', title: 'Wallet balance: no figure', detail: `The answer carried no balance (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['balance'] }];
  if (read.balance === null) return [{ rule: 'balance.chain_only', severity: 'info', title: `${sym}: Telegraph says ${told.toLocaleString('en-US')}`, detail: 'There is no chain read to compare it with.', source: 'telegraph', evidence: ['balance'] }];
  const chain = Number(read.balance);
  const bps = relDiffBps(told, chain);
  if (bps <= HOLDINGS_POLICY.balanceToleranceBps) {
    return [{ rule: 'balance.agrees', severity: 'pass', title: `${sym}: Telegraph's balance agrees with the chain`, detail: `Telegraph: ${told.toLocaleString('en-US')}; chain at block ${read.facts.block}: ${chain.toLocaleString('en-US')} (${bps.toFixed(2)} bps apart, tolerance ${HOLDINGS_POLICY.balanceToleranceBps}).`, source: 'telegraph+chain', evidence: ['balance'] }];
  }
  return [{ rule: 'balance.conflict', severity: 'review', title: `${sym}: Telegraph's balance conflicts with the chain`, detail: `Telegraph says ${told.toLocaleString('en-US')} but balanceOf() is ${chain.toLocaleString('en-US')} at block ${read.facts.block} (${Number.isFinite(bps) ? `${bps.toFixed(0)} bps` : 'unbounded'} apart, tolerance ${HOLDINGS_POLICY.balanceToleranceBps}). Conflicting sources need a person.`, source: 'telegraph+chain', evidence: ['balance'] }];
}

/** The holding's share of the token's supply, from the chain read: what an index rebalance must account for. */
function floatFindings(read: HoldingRead): Finding[] {
  const f = read.facts;
  if (read.balanceRaw === null || f.totalSupplyRaw === null || f.totalSupplyRaw === '0') return [];
  const share = Number((BigInt(read.balanceRaw) * 1_000_000n) / BigInt(f.totalSupplyRaw)) / 10_000;
  return [{ rule: 'holding.float_share', severity: 'info', title: `${labelOf(read)}: ${share.toFixed(4)}% of supply`, detail: `${read.balance} of ${f.totalSupply} ${labelOf(read)} at block ${f.block}.`, source: 'chain', evidence: [] }];
}

/** Prefix a shared rule's title with the holding it is about. */
const about = (read: HoldingRead, findings: Finding[]): Finding[] =>
  findings.map((f) => (f.title.startsWith(`${labelOf(read)}:`) || f.title.startsWith(`${labelOf(read)} `) ? f : { ...f, title: `${labelOf(read)}: ${f.title}` }));

/**
 * The decision from the evidence. Pure: the same chain reads and answers
 * always give the same findings and decision.
 */
export function evaluateHoldings(
  req: Pick<HoldingsRequest, 'chain' | 'wallet'>,
  reads: HoldingRead[],
  purchases: Purchase[],
): { findings: Finding[]; decision: Decision; decisionRule: string } {
  const findings: Finding[] = [];
  reads.forEach((read, i) => {
    const mine = purchases.filter((p) => p.holding === i);
    const by = (key: Purchase['key']) => mine.find((p) => p.key === key);
    findings.push(...claimFindings(read, req.wallet));
    if (!read.facts.isContract) return;
    findings.push(...about(read, balanceFindings(by('balance'), read, req.wallet)));
    findings.push(...about(read, supplyFindings(by('supply'), read.facts)));
    findings.push(...floatFindings(read));
    if (read.pool) findings.push(...about(read, liquidityFindings(by('liquidity'), asPreflightRequest(req, read))));
    for (const p of mine) {
      const so = p.secondOpinion;
      if (!so) continue;
      findings.push({
        rule: `${p.key}.second_opinion`, severity: 'info',
        title: `${labelOf(read)}: ${so.used ? `second opinion used: ${so.miner?.name ?? '-'}` : so.second ? `second opinion not used: ${so.miner?.name ?? '-'}` : 'no second opinion could be asked'}`,
        detail: `${so.reason} ${so.outcome}.`, source: 'telegraph', evidence: [p.key],
      });
    }
  });
  if (findings.some((f) => f.severity === 'block')) return { findings, decision: 'REJECT', decisionRule: 'a holding is short of its claim on the chain, or is not a token' };
  if (findings.some((f) => f.severity === 'review')) return { findings, decision: 'REVIEW', decisionRule: 'every claim is covered on the chain, but a bought answer is missing or disagrees: a person must look' };
  return { findings, decision: 'VERIFIED', decisionRule: 'every claim is covered on the chain and every bought answer agrees with it' };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface HoldingsEvents {
  onHoldingsRead?: (reads: HoldingRead[]) => void;
  onPlan?: (plan: Array<{ key: Purchase['key']; intent: string; holding: number | undefined }>, escrowUsd: number | null) => void;
  onPurchase?: (p: Purchase) => void;
}

/** Every holding read at the same block: contract facts and the wallet's balance. */
export async function readHoldings(req: HoldingsRequest): Promise<HoldingRead[]> {
  const anchor = await anchorBlock(req.chain);
  const client = getClient(req.chain);
  return Promise.all(req.holdings.map(async (h) => {
    const facts = await readTokenFacts(req.chain, h.token, anchor);
    let balanceRaw: string | null = null;
    if (facts.isContract) {
      try {
        balanceRaw = (await client.readContract({ address: h.token, abi: ERC20, functionName: 'balanceOf', args: [req.wallet], blockNumber: anchor.number })).toString();
      } catch {
        balanceRaw = null; // no ERC-20 balanceOf(); the rules say the claim cannot be checked
      }
    }
    return {
      token: h.token, claimed: h.claimed, pool: h.pool ?? null, facts,
      balanceRaw, balance: balanceRaw !== null && facts.decimals !== null ? formatUnits(BigInt(balanceRaw), facts.decimals) : null,
    };
  }));
}

export async function runHoldings(req: HoldingsRequest, events: HoldingsEvents = {}): Promise<PreflightMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const reads = await readHoldings(req);
  events.onHoldingsRead?.(reads);

  const plan: Planned[] = [];
  reads.forEach((read, i) => {
    const f = read.facts;
    if (!f.isContract) return;
    const sym = f.symbol ?? 'token';
    const label = f.chainLabel;
    plan.push({ key: 'balance', holding: i, intent: 'WALLET_BALANCE_CHECK_GENERAL', params: { address: req.wallet, chain: req.chain, token: read.token }, question: `What is the ${sym} (${read.token}) balance of ${req.wallet} on ${label}, in whole tokens?` });
    if (f.totalSupply !== null) plan.push({ key: 'supply', holding: i, intent: 'TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL', params: { token: `${sym} (${read.token}) on ${label}` }, question: `What is the current total supply of ${sym} (${read.token}) on ${label}, in whole tokens?` });
    if (read.pool) plan.push({ key: 'liquidity', holding: i, intent: 'LIQUIDITY_DEPTH_VERIFY_GENERAL', params: { pool: read.pool, chain: req.chain }, question: `What is the liquidity in USD of the DEX pool ${read.pool} on ${label}?` });
  });

  const budget = budgetUsd();
  const escrow = plan.length > 0 ? await apiKeyBalanceUsd() : null;
  events.onPlan?.(plan.map(({ key, intent, holding }) => ({ key, intent, holding })), escrow);
  let purchases: Purchase[] = [];
  const policyFindings: Finding[] = [];
  const expected = plan.length * ROUTED_ASK_USD;
  if (plan.length > 0 && expected > budget + 1e-9) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `This proof would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per decision. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0 && escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds for each ask while it runs. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (plan.length > 0) {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    const spend = new Spend(budget, expected);
    purchases = await pooled(plan.map((p) => () => {
      const read = reads[p.holding!]!;
      return buy(p, { req: asPreflightRequest(req, read), facts: read.facts, treasuryRead: null, spend, judge: (x) => balanceFindings(x, read, req.wallet) });
    }), parallel, (p) => events.onPurchase?.(p));
  }

  const judged = evaluateHoldings(req, reads, purchases);
  const findings = [...policyFindings, ...judged.findings];
  let decision = judged.decision;
  let decisionRule = judged.decisionRule;
  if (policyFindings.length > 0 && decision !== 'REJECT') {
    decision = 'REVIEW';
    decisionRule = 'the checks could not be bought, so nothing can verify the holdings';
  }
  const label = reads[0]?.facts.chainLabel ?? req.chain;
  return {
    version: 'truvian-shield-memo/1',
    kind: 'holdings-proof',
    createdAt,
    input: {
      mode: 'holdings', chain: req.chain, token: req.wallet, pool: null, tradeUsd: null, issuer: null, treasury: null,
      wallet: req.wallet,
      holdings: req.holdings.map((h) => ({ token: getAddress(h.token), claimed: h.claimed, pool: h.pool ?? null })),
    },
    network: {
      telegraphNode: process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com',
      routing: 'one routed ask per fact (POST /engine/ask with intent and params, paid from escrow); the node picks its ranked miner and returns a payment receipt. When that answer is no evidence, at most one more ask per fact, pinned to the next-best miner on the node leaderboard (POST /engine/ask/{minerId}), within the budget',
      settlement: 'Anjoman escrow, test USDC on Ethereum Sepolia (testnet)',
      note: 'Telegraph Season II runs on testnet settlement; the holdings checked are on the mainnet chain named in input.chain.',
    },
    chainReads: null,
    treasuryRead: null,
    holdingReads: reads.map((r) => ({ ...r, source: `${label} JSON-RPC at block ${r.facts.block} (Truvian chain registry, not Telegraph)` })),
    purchases,
    findings,
    decision,
    decisionRule,
    action: null,
    cost: { ...memoCost(purchases), budgetUsd: budget, escrowBeforeUsd: escrow },
    latencyMs: Date.now() - started,
    policy: POLICY,
    holdingsPolicy: HOLDINGS_POLICY,
  };
}
