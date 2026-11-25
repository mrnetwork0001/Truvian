/**
 * Truvian Shield settlement assurance on Solana (Solana use case 1:
 * Institutional Transaction Intelligence & Settlement Assurance).
 *
 * A custodian is about to pay a counterparty in an SPL token on Solana.
 * Before it signs, Shield decides RELEASE, REVIEW or REJECT:
 *  1. Free direct Solana reads (solana.ts): the mint's program, decimals,
 *     authorities and Token-2022 extensions (what the issuer can still do to
 *     the recipient's tokens), the payer's balance, and the recipient's
 *     existing accounts of the mint (frozen or not).
 *  2. Through Telegraph, one routed ask per fact, paid from escrow with a
 *     receipt, with the same second-opinion and reuse rules as the other
 *     desks: sanctions screening of the counterparty
 *     (SANCTIONS_SCREENING_MATCH), its corporate registry record
 *     (CORPORATE_REGISTRY_LOOKUP), and the payer's balance
 *     (WALLET_BALANCE_CHECK) as an independent check on the chain read.
 *  3. Fixed rules (`evaluateSettlement`, pure). REJECT on a sanctions match,
 *     a counterparty the registry shows inactive, a payer short of the
 *     amount, a frozen recipient account, or a mint no transfer can be made
 *     in. REVIEW on an answer that is missing or about another entity, a
 *     registry jurisdiction in another country, a recipient that is not a
 *     wallet, or a mint power that can reverse or tax the payment (permanent
 *     delegate, transfer hook, transfer fee, accounts frozen by default).
 *     RELEASE only when every check is answered and none holds it back.
 *  4. On RELEASE, when asked to execute on devnet from Shield's own devnet
 *     wallet, Shield sends the transfer, waits for finalized, reads it back
 *     and checks the recipient received exactly the amount authorised. The
 *     signature and that check go into the memo before it is signed.
 */
import {
  budgetUsd,
  buy,
  HOLD_PER_ASK_USD,
  memoCost,
  pooled,
  POLICY,
  PreflightInputError,
  ROUTED_ASK_USD,
  Spend,
  unavailable,
  type Decision,
  type Finding,
  type FactContext,
  type Planned,
  type PreflightMemo,
  type PreflightRequest,
  type Purchase,
} from './preflight.js';
import { apiKeyBalanceUsd } from './telegraph.js';
import {
  devnetKeypair,
  explorerTx,
  isWalletAddress,
  mintRestrictions,
  parseMint,
  parseSolanaAddress,
  parseSolanaNetwork,
  readBalance,
  readMint,
  sendDevnetSettlement,
  SOLANA_LABEL,
  SolanaInputError,
  SolanaReadError,
  verifySettlement,
  wholeUnits,
  type BalanceRead,
  type MintRead,
  type Restriction,
  type SettlementCheck,
  type SolanaNetwork,
} from './solana.js';

export interface SettlementRequest {
  mode: 'settlement';
  network: SolanaNetwork;
  /** Mint address (or a known symbol, resolved on input) */
  mint: string;
  /** Amount in whole tokens, exact decimal text */
  amount: string;
  payer: string;
  recipient: string;
  /** The counterparty's legal name, screened and looked up */
  counterparty: string;
  /** Where the counterparty says it is registered */
  jurisdiction: string;
  /** Send the payment on RELEASE (devnet, from Shield's own devnet wallet only) */
  execute: boolean;
}

export const SETTLEMENT_POLICY = {
  /** Telegraph's payer balance vs the chain read */
  balanceToleranceBps: 50,
  /** The most Shield will send in one devnet settlement, in whole tokens */
  maxDevnetSettlement: Number(process.env.SHIELD_SETTLEMENT_MAX ?? '1') > 0 ? Number(process.env.SHIELD_SETTLEMENT_MAX ?? '1') : 1,
} as const;

/** What the memo records about the payment itself. */
export interface SettlementSection {
  network: SolanaNetwork;
  mint: MintRead & { source: string };
  restrictions: Restriction[];
  amountRaw: string;
  payerBalance: (BalanceRead & { source: string }) | null;
  payerBalanceError: string | null;
  recipientIsWallet: boolean;
  recipientAccounts: BalanceRead['accounts'];
  /** Set when Shield sent the payment */
  execution: {
    requested: boolean;
    sent: boolean;
    reason: string;
    signature: string | null;
    explorer: string | null;
    check: SettlementCheck | null;
  };
}

const AMOUNT = /^\d{1,20}(\.\d{1,12})?$/;

export function normalizeSettlementRequest(raw: unknown): SettlementRequest {
  if (typeof raw !== 'object' || raw === null) throw new PreflightInputError('body must be a JSON object');
  const b = raw as Record<string, unknown>;
  try {
    const network = parseSolanaNetwork(b.network ?? b.chain);
    const mint = parseMint(network, b.mint ?? b.token);
    const amount = String(b.amount ?? '').trim().replace(/,/g, '');
    if (!AMOUNT.test(amount) || /^0+(\.0+)?$/.test(amount)) throw new PreflightInputError('amount must be a positive amount in whole tokens, such as 250000 or 0.5');
    const devnetWallet = devnetKeypair()?.publicKey.toBase58();
    const payerRaw = b.payer === undefined || String(b.payer).trim() === '' ? devnetWallet : b.payer;
    if (!payerRaw) throw new PreflightInputError('payer is required');
    const payer = parseSolanaAddress(payerRaw, 'payer');
    const recipient = parseSolanaAddress(b.recipient, 'recipient');
    if (recipient === payer) throw new PreflightInputError('recipient and payer are the same address');
    const counterparty = String(b.counterparty ?? '').trim();
    if (counterparty.length < 2 || counterparty.length > 160) throw new PreflightInputError('counterparty must be the recipient\'s legal name');
    const jurisdiction = String(b.jurisdiction ?? '').trim();
    if (jurisdiction.length < 2 || jurisdiction.length > 60) throw new PreflightInputError('jurisdiction must name the country (or state) the counterparty is registered in');
    return { mode: 'settlement', network, mint, amount, payer, recipient, counterparty, jurisdiction, execute: b.execute === true || b.execute === 'true' };
  } catch (err) {
    if (err instanceof SolanaInputError) throw new PreflightInputError(err.message);
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
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);

const SUFFIXES = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\.l\.c|plc|gmbh|ag|sa|s\.a|bv|nv|oy|ou|oü|as|ab|pte|pty|lp|llp|holdings?)\b\.?/g;
export function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[.,'"()&]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

const COUNTRY: Record<string, string> = {
  'united states': 'US', usa: 'US', us: 'US', america: 'US', delaware: 'US', 'new york': 'US', texas: 'US', california: 'US', wyoming: 'US',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', 'great britain': 'GB', gb: 'GB', scotland: 'GB',
  germany: 'DE', estonia: 'EE', ireland: 'IE', france: 'FR', netherlands: 'NL', switzerland: 'CH', singapore: 'SG', 'hong kong': 'HK',
  'cayman islands': 'KY', 'british virgin islands': 'VG', bermuda: 'BM', bahamas: 'BS', japan: 'JP', australia: 'AU', canada: 'CA', russia: 'RU', 'russian federation': 'RU',
  'united arab emirates': 'AE', uae: 'AE', luxembourg: 'LU', malta: 'MT', gibraltar: 'GI', nigeria: 'NG', india: 'IN', brazil: 'BR', panama: 'PA', seychelles: 'SC',
};
/** The ISO country of a jurisdiction as people and registries write it: "US-DE", "Delaware", "Estonia", "GB". */
export function countryOf(j: string): string | null {
  const s = j.trim();
  const iso = s.match(/^([A-Za-z]{2})(?:-[A-Za-z0-9]{1,3})?$/);
  if (iso) return iso[1]!.toUpperCase();
  return COUNTRY[s.toLowerCase().replace(/^the /, '').replace(/,.*$/, '').trim()] ?? null;
}

function sanctionsJudge(p: Purchase, name: string): Finding[] {
  if (!p.ok || !p.fields) return [unavailable(p, 'sanctions', 'Sanctions screening')];
  const matched = p.fields.matched;
  const score = num(p.fields.match_score);
  const lists = list(p.fields.lists);
  const matches = list(p.fields.matches);
  if (matched === true) return [{ rule: 'sanctions.match', severity: 'block', title: 'Counterparty matches a sanctions list', detail: `"${name}" matched ${matches.join(', ') || 'an entry'}${lists.length ? ` (lists: ${lists.slice(0, 4).join(', ')})` : ''}. Paying it would breach sanctions.`, source: 'telegraph', evidence: ['sanctions'] }];
  if (matched !== false) return [{ rule: 'sanctions.uncertain', severity: 'review', title: 'Sanctions screening uncertain', detail: `The screening returned no clear match result (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['sanctions'] }];
  if (score !== null && score >= POLICY.sanctionsNearMatchScore) return [{ rule: 'sanctions.near_match', severity: 'review', title: 'Close name match on a sanctions list', detail: `No exact match, but the best fuzzy score is ${score}; a person must compare the names before paying.`, source: 'telegraph', evidence: ['sanctions'] }];
  return [{ rule: 'sanctions.clear', severity: 'pass', title: 'Counterparty not on the sanctions lists checked', detail: `"${name}" did not match${lists.length ? ` across ${lists.length} lists (${lists.slice(0, 3).join(', ')}${lists.length > 3 ? ', ...' : ''})` : ''}.`, source: 'telegraph', evidence: ['sanctions'] }];
}

function registryJudge(p: Purchase, name: string, jurisdiction: string): Finding[] {
  if (!p.ok || !p.fields) return [unavailable(p, 'registry', 'Corporate registry')];
  const f = p.fields;
  const legal = typeof f.legal_name === 'string' ? f.legal_name : null;
  const id = typeof f.registration_id === 'string' ? f.registration_id : null;
  if (!legal && typeof f.active !== 'boolean') return [{ rule: 'registry.missing', severity: 'review', title: 'Corporate registry: no record', detail: `The answer named no entity and no status (field status ${JSON.stringify(p.fieldStatus)}).`, source: 'telegraph', evidence: ['registry'] }];
  const want = normName(name);
  const got = legal ? normName(legal) : '';
  if (legal && want && got && !(got === want || got.includes(want) || want.includes(got))) {
    return [{ rule: 'registry.other_entity', severity: 'review', title: 'Registry record is for another entity', detail: `Asked for "${name}", the record names "${legal}"${id ? ` (${id})` : ''}. It is no evidence about the counterparty.`, source: 'telegraph', evidence: ['registry'] }];
  }
  const out: Finding[] = [];
  const at = [legal, id ? `registration ${id}` : null, typeof f.jurisdiction === 'string' ? f.jurisdiction : null, typeof f.incorporated === 'string' ? `incorporated ${f.incorporated}` : null].filter(Boolean).join(', ');
  if (f.active === false) out.push({ rule: 'registry.inactive', severity: 'block', title: 'Counterparty is not active in its registry', detail: `${at}: the registry shows it inactive, dissolved or lapsed. A payment to an entity that no longer exists cannot be authorised.`, source: 'telegraph', evidence: ['registry'] });
  else if (f.active !== true) out.push({ rule: 'registry.status_unknown', severity: 'review', title: 'Registry status unknown', detail: `${at}: the answer did not say whether the entity is active.`, source: 'telegraph', evidence: ['registry'] });
  const said = countryOf(jurisdiction);
  const found = typeof f.jurisdiction === 'string' ? countryOf(f.jurisdiction) : null;
  if (said && found && said !== found) out.push({ rule: 'registry.jurisdiction_conflict', severity: 'review', title: 'Registered in another country', detail: `The counterparty was given as registered in ${jurisdiction}; the registry record says ${f.jurisdiction}.`, source: 'telegraph', evidence: ['registry'] });
  if (out.length === 0) out.push({ rule: 'registry.active', severity: 'pass', title: 'Counterparty is a registered, active entity', detail: `${at}.`, source: 'telegraph', evidence: ['registry'] });
  return out;
}

function balanceJudge(p: Purchase, read: BalanceRead | null, decimals: number | null): Finding[] {
  if (!p.ok || !p.fields) return [{ ...unavailable(p, 'balance', 'Payer balance (Telegraph)'), severity: 'info', detail: `Telegraph did not return the payer's balance${p.error ? ` (${p.error.slice(0, 160)})` : ''}. On 2026-11-25 no miner on the node answered Solana balances; the funds check rests on the chain read, which two RPC providers agree on.` }];
  const told = num(p.fields.balance);
  if (told === null) return [{ rule: 'balance.missing', severity: 'info', title: 'Payer balance (Telegraph): no figure', detail: `The answer carried no balance (field status ${JSON.stringify(p.fieldStatus)}); the funds check rests on the chain read.`, source: 'telegraph', evidence: ['balance'] }];
  if (!read || decimals === null) return [{ rule: 'balance.chain_unread', severity: 'info', title: `Telegraph says the payer holds ${told}`, detail: 'The chain read failed, so there is nothing to compare it with.', source: 'telegraph', evidence: ['balance'] }];
  const chain = Number(read.whole);
  const bps = chain === 0 && told === 0 ? 0 : (Math.abs(told - chain) / Math.max(Math.abs(chain), 1e-12)) * 10_000;
  if (bps <= SETTLEMENT_POLICY.balanceToleranceBps) return [{ rule: 'balance.agrees', severity: 'pass', title: 'Telegraph agrees with the chain on the payer\'s balance', detail: `${told} vs ${read.whole} at slot ${read.slot} (${bps.toFixed(2)} bps apart).`, source: 'telegraph+chain', evidence: ['balance'] }];
  return [{ rule: 'balance.conflict', severity: 'review', title: 'Payer balance conflicts with the chain', detail: `Telegraph says ${told}, the chain says ${read.whole} at slot ${read.slot}.`, source: 'telegraph+chain', evidence: ['balance'] }];
}

export interface SettlementReads {
  mint: MintRead;
  payerBalance: BalanceRead | null;
  payerBalanceError: string | null;
  recipient: BalanceRead | null;
  recipientIsWallet: boolean;
}

/** Findings from the Solana reads alone. Pure. */
export function chainSettlementFindings(req: SettlementRequest, r: SettlementReads): { findings: Finding[]; amountRaw: bigint | null; restrictions: Restriction[] } {
  const out: Finding[] = [];
  const label = SOLANA_LABEL[req.network];
  const m = r.mint;
  if (!m.isMint || m.decimals === null) {
    out.push({ rule: 'mint.not_a_mint', severity: 'block', title: 'Not a token mint', detail: `${req.mint} is not an SPL token mint on ${label}. Nothing can be settled in it.`, source: 'chain', evidence: [] });
    return { findings: out, amountRaw: null, restrictions: [] };
  }
  const frac = req.amount.split('.')[1] ?? '';
  if (frac.length > m.decimals) {
    out.push({ rule: 'amount.too_precise', severity: 'block', title: 'Amount has more decimals than the token', detail: `${req.amount} cannot be written with ${m.decimals} decimals.`, source: 'policy', evidence: [] });
    return { findings: out, amountRaw: null, restrictions: [] };
  }
  const [i, f = ''] = req.amount.split('.');
  const amountRaw = BigInt(i! + f.padEnd(m.decimals, '0'));
  const restrictions = mintRestrictions(m, amountRaw);
  for (const x of restrictions) out.push({ rule: `mint.${x.key}`, severity: x.level, title: x.title, detail: x.detail, source: 'chain', evidence: [] });
  if (r.payerBalance) {
    const have = BigInt(r.payerBalance.raw);
    if (have < amountRaw) out.push({ rule: 'payer.insufficient', severity: 'block', title: 'Payer cannot cover the payment', detail: `The payer holds ${r.payerBalance.whole} at slot ${r.payerBalance.slot}; the payment is ${req.amount}.`, source: 'chain', evidence: [] });
    else out.push({ rule: 'payer.funded', severity: 'pass', title: 'Payer can cover the payment', detail: `The payer holds ${r.payerBalance.whole} at slot ${r.payerBalance.slot} (${r.payerBalance.sources.join('; ')}).`, source: 'chain', evidence: [] });
    if (r.payerBalance.accounts.some((a) => a.frozen)) out.push({ rule: 'payer.frozen', severity: 'block', title: 'Payer account is frozen', detail: 'One of the payer\'s accounts of this mint is frozen by the issuer.', source: 'chain', evidence: [] });
  } else {
    out.push({ rule: 'payer.unreadable', severity: 'review', title: 'Payer balance unreadable', detail: r.payerBalanceError ?? 'The chain did not answer.', source: 'chain', evidence: [] });
  }
  if (!r.recipientIsWallet) out.push({ rule: 'recipient.not_wallet', severity: 'review', title: 'Recipient is a program address', detail: `${req.recipient} is not an ordinary wallet key but a program-derived address; a person must confirm which program controls it.`, source: 'chain', evidence: [] });
  if (r.recipient?.accounts.some((a) => a.frozen)) out.push({ rule: 'recipient.frozen', severity: 'block', title: 'Recipient account is frozen', detail: `The recipient's account of this mint is frozen by the issuer, so it could not use the payment.`, source: 'chain', evidence: [] });
  return { findings: out, amountRaw, restrictions };
}

export function evaluateSettlement(findings: Finding[]): { decision: Decision; decisionRule: string } {
  if (findings.some((f) => f.severity === 'block')) return { decision: 'REJECT', decisionRule: 'at least one finding blocks the payment' };
  if (findings.some((f) => f.severity === 'review')) return { decision: 'REVIEW', decisionRule: 'no blocking finding, but at least one needs a person before the payment is released' };
  return { decision: 'RELEASE', decisionRule: 'every check answered and none holds the payment back' };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface SettlementEvents {
  onChainRead?: (reads: { mint: MintRead; restrictions: Restriction[]; payerBalance: BalanceRead | null; recipientIsWallet: boolean }) => void;
  onPlan?: (plan: Array<{ key: string; intent: string }>, escrowUsd: number | null) => void;
  onPurchase?: (p: Purchase) => void;
  onExecution?: (e: SettlementSection['execution']) => void;
}

export async function runSettlement(req: SettlementRequest, events: SettlementEvents = {}): Promise<PreflightMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const label = SOLANA_LABEL[req.network];

  const mint = await readMint(req.network, req.mint);
  const decimals = mint.decimals ?? 0;
  let payerBalance: BalanceRead | null = null;
  let payerBalanceError: string | null = null;
  let recipient: BalanceRead | null = null;
  if (mint.isMint) {
    const [p, r] = await Promise.allSettled([readBalance(req.network, req.payer, req.mint, decimals), readBalance(req.network, req.recipient, req.mint, decimals)]);
    if (p.status === 'fulfilled') payerBalance = p.value;
    else payerBalanceError = p.reason instanceof Error ? p.reason.message : String(p.reason);
    if (r.status === 'fulfilled') recipient = r.value;
  }
  const reads: SettlementReads = { mint, payerBalance, payerBalanceError, recipient, recipientIsWallet: isWalletAddress(req.recipient) };
  const chain = chainSettlementFindings(req, reads);
  events.onChainRead?.({ mint, restrictions: chain.restrictions, payerBalance, recipientIsWallet: reads.recipientIsWallet });

  const sym = req.mint.slice(0, 4);
  const plan: Planned[] = [
    { key: 'sanctions', intent: 'SANCTIONS_SCREENING_MATCH_GENERAL', params: { name: req.counterparty }, question: `Is ${req.counterparty} on a sanctions list?` },
    { key: 'registry', intent: 'CORPORATE_REGISTRY_LOOKUP_GENERAL', params: { company: req.counterparty, jurisdiction: req.jurisdiction }, question: `Corporate registry record of ${req.counterparty} (${req.jurisdiction}): legal name, registration id, active or not, jurisdiction.` },
  ];
  if (mint.isMint) plan.push({ key: 'balance', intent: 'WALLET_BALANCE_CHECK_GENERAL', params: { address: req.payer, chain: req.network, token: req.mint }, question: `What is the balance of token mint ${req.mint} held by wallet ${req.payer} on ${label}, in whole tokens?` });

  const budget = budgetUsd();
  const escrow = await apiKeyBalanceUsd();
  events.onPlan?.(plan.map(({ key, intent }) => ({ key, intent })), escrow);
  const policyFindings: Finding[] = [];
  let purchases: Purchase[] = [];
  const expected = plan.length * ROUTED_ASK_USD;
  const judgeAll = (p: Purchase): Finding[] => {
    if (p.key === 'sanctions') return sanctionsJudge(p, req.counterparty);
    if (p.key === 'registry') return registryJudge(p, req.counterparty, req.jurisdiction);
    return balanceJudge(p, payerBalance, mint.decimals);
  };
  if (expected > budget) {
    policyFindings.push({ rule: 'budget.over', severity: 'review', title: 'Over budget', detail: `The checks would cost about $${expected.toFixed(2)}, above the $${budget.toFixed(2)} budget per decision. Nothing was bought.`, source: 'policy', evidence: [] });
  } else if (escrow !== null && escrow < HOLD_PER_ASK_USD) {
    policyFindings.push({ rule: 'budget.escrow_low', severity: 'review', title: 'Escrow too low to buy', detail: `The escrow holds $${escrow.toFixed(2)}, below the $${HOLD_PER_ASK_USD} Telegraph holds per ask. Nothing was bought.`, source: 'policy', evidence: [] });
  } else {
    const parallel = escrow === null ? 1 : Math.max(1, Math.min(3, Math.floor(escrow / HOLD_PER_ASK_USD)));
    // The shared buy() path wants a token desk's context; this desk judges every fact itself (judgeAll).
    const ctx = { req: { mode: 'settlement', chain: 'ethereum', token: '0x0000000000000000000000000000000000000000', issuer: req.counterparty } as unknown as PreflightRequest, facts: null as unknown as FactContext['facts'], treasuryRead: null, judgeAll, spend: new Spend(budget, expected) };
    purchases = await pooled(plan.map((p) => () => buy(p, ctx)), parallel, (p) => events.onPurchase?.(p));
  }

  const bought = purchases.flatMap(judgeAll);
  const order = { block: 0, review: 1, info: 2, pass: 3 } as const;
  const findings = [...policyFindings, ...chain.findings, ...bought].sort((a, b) => order[a.severity] - order[b.severity]);
  let { decision, decisionRule } = evaluateSettlement(findings);

  // Execution: devnet only, from Shield's own devnet wallet, within the cap, and only on RELEASE.
  const wallet = devnetKeypair()?.publicKey.toBase58() ?? null;
  const execution: SettlementSection['execution'] = { requested: req.execute, sent: false, reason: '', signature: null, explorer: null, check: null };
  if (!req.execute) execution.reason = 'not requested: decision only';
  else if (decision !== 'RELEASE') execution.reason = `not sent: the decision is ${decision}`;
  else if (req.network !== 'solana-devnet') execution.reason = 'not sent: Shield settles on Solana devnet only';
  else if (req.payer !== wallet) execution.reason = 'not sent: Shield can only send from its own devnet settlement wallet';
  else if (Number(req.amount) > SETTLEMENT_POLICY.maxDevnetSettlement) execution.reason = `not sent: above the ${SETTLEMENT_POLICY.maxDevnetSettlement}-token cap per devnet settlement`;
  else if (chain.amountRaw === null) execution.reason = 'not sent: the amount could not be read';
  else {
    try {
      const sig = await sendDevnetSettlement(mint, req.recipient, chain.amountRaw);
      execution.sent = true;
      execution.signature = sig;
      execution.explorer = explorerTx(req.network, sig);
      execution.check = await verifySettlement(req.network, sig, req.mint, req.recipient, chain.amountRaw, decimals);
      execution.reason = execution.check.amountMatches ? 'sent and verified at finalized' : 'sent, but the read-back did not show the exact amount received';
      findings.push(execution.check.amountMatches
        ? { rule: 'settlement.verified', severity: 'pass', title: 'Settled and verified on Solana', detail: `Transaction ${sig} is finalized at slot ${execution.check.slot}; the recipient received exactly ${execution.check.received} (${execution.check.source}).`, source: 'chain', evidence: [] }
        : { rule: 'settlement.mismatch', severity: 'block', title: 'Settlement did not pay the exact amount', detail: `Transaction ${sig}: found ${execution.check.found}, succeeded ${execution.check.succeeded}, received ${execution.check.received ?? '-'} of ${req.amount}.`, source: 'chain', evidence: [] });
      if (!execution.check.amountMatches) ({ decision, decisionRule } = { decision: 'REJECT', decisionRule: 'the payment was sent but the chain does not show the exact amount received' });
    } catch (err) {
      execution.reason = `send failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
      findings.push({ rule: 'settlement.send_failed', severity: 'review', title: 'Released, but the send failed', detail: execution.reason, source: 'chain', evidence: [] });
      ({ decision, decisionRule } = { decision: 'REVIEW', decisionRule: 'the checks cleared the payment but it could not be sent' });
    }
  }
  events.onExecution?.(execution);

  return {
    version: 'truvian-shield-memo/1',
    kind: 'settlement-assurance',
    createdAt,
    input: { mode: 'settlement', chain: req.network, token: req.mint, pool: null, tradeUsd: null, issuer: req.counterparty, treasury: null, wallet: req.payer },
    network: {
      telegraphNode: process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com',
      routing: 'one routed ask per fact (POST /engine/ask with intent and params, paid from escrow); at most one more ask per fact, pinned to the next-best ranked miner, when the first answer is no evidence',
      settlement: 'Telegraph answers: Anjoman escrow, test USDC on Ethereum Sepolia. The payment itself: SPL transfer on Solana devnet.',
      note: `The payment is on ${label}; counterparty facts are bought through Telegraph; mint and balances are read directly from ${label}.`,
    },
    chainReads: null,
    treasuryRead: null,
    purchases,
    findings,
    decision,
    decisionRule,
    action: {
      simulated: false,
      description: execution.sent ? `paid ${req.amount} to ${req.recipient} on ${label}: ${execution.signature}` : `payment of ${req.amount} to ${req.recipient} on ${label}: ${execution.reason}`,
      executed: execution.sent,
    },
    cost: { ...memoCost(purchases), budgetUsd: budget, escrowBeforeUsd: escrow },
    latencyMs: Date.now() - started,
    policy: POLICY,
    settlement: {
      network: req.network,
      mint: { ...mint, source: mint.sources.join('; ') },
      restrictions: chain.restrictions,
      amountRaw: chain.amountRaw?.toString() ?? '',
      payerBalance: payerBalance ? { ...payerBalance, source: payerBalance.sources.join('; ') } : null,
      payerBalanceError,
      recipientIsWallet: reads.recipientIsWallet,
      recipientAccounts: recipient?.accounts ?? [],
      execution,
    },
  };
}

export { SolanaReadError, wholeUnits };
