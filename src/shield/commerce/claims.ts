/**
 * Claims an agent's work makes, and how each is checked. Pure: no network.
 *
 * A deliverable (a due diligence report, an agent's answer to a task) is
 * reduced to typed claims. Each claim is one fact Truvian can check
 * independently:
 *
 *   sanctions      an entity is (or is not) on a sanctions list
 *                  checked with SANCTIONS_SCREENING_MATCH bought on Telegraph
 *   registry       an entity's registry record: active or not, jurisdiction,
 *                  registration id, legal name
 *                  checked with CORPORATE_REGISTRY_LOOKUP bought on Telegraph
 *   token_balance  a wallet holds an amount of a token (EVM or Solana)
 *                  checked against the chain itself; Telegraph's
 *                  WALLET_BALANCE_CHECK is bought as a cross-check
 *   token_supply   a token's total supply
 *                  checked against the chain; TOKEN_TOTAL_SUPPLY_VERIFY is
 *                  bought as a cross-check
 *
 * Each claim ends confirmed, contradicted or unverified. A task can also list
 * requirements (what the work had to cover); a requirement no claim satisfies
 * makes the work incomplete.
 */
import { parseUnits } from 'viem';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../config/chains.js';
import { POLICY, type Purchase } from '../preflight.js';
import { countryOf, normName } from '../settlement.js';
import type { SolanaNetwork } from '../solana.js';

export type ClaimKind = 'sanctions' | 'registry' | 'token_balance' | 'token_supply';
export const CLAIM_KINDS: readonly ClaimKind[] = ['sanctions', 'registry', 'token_balance', 'token_supply'];
export type ClaimChain = SupportedChain | SolanaNetwork;

export interface SanctionsClaim { kind: 'sanctions'; entity: string; listed: boolean }
export interface RegistryClaim { kind: 'registry'; entity: string; jurisdiction: string; active?: boolean; registrationId?: string; legalName?: string }
export interface BalanceClaim { kind: 'token_balance'; chain: ClaimChain; wallet: string; token: string; balance: string }
export interface SupplyClaim { kind: 'token_supply'; chain: ClaimChain; token: string; totalSupply: string }
export type Claim = SanctionsClaim | RegistryClaim | BalanceClaim | SupplyClaim;

/** What the work had to cover. Every field given must match a claim's. */
export interface Requirement { kind: ClaimKind; entity?: string; chain?: ClaimChain; wallet?: string; token?: string }

export type ClaimStatus = 'confirmed' | 'contradicted' | 'unverified';

export interface ClaimCheck {
  /** Position of the claim in the deliverable */
  index: number;
  claim: Claim;
  status: ClaimStatus;
  title: string;
  detail: string;
  /** Where the deciding evidence came from */
  source: 'telegraph' | 'chain' | 'telegraph+chain' | 'policy';
  /** Telegraph cross-checks and notes that did not decide the claim */
  notes: string[];
}

export class ClaimInputError extends Error {}

export const VERIFY_POLICY = {
  /** A claimed balance vs the chain read: the two are read at different times */
  balanceToleranceBps: 50,
  /** A claimed supply vs the chain read */
  supplyToleranceBps: 10,
  /** Telegraph's cross-check vs the chain read */
  crossCheckToleranceBps: 50,
  sanctionsNearMatchScore: POLICY.sanctionsNearMatchScore,
  maxClaims: 8,
  maxRequirements: 8,
} as const;

const SOLANA: readonly string[] = ['solana', 'solana-devnet'];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT = /^\d{1,30}(\.\d{1,18})?$/;

export const isSolanaChain = (c: ClaimChain): c is SolanaNetwork => SOLANA.includes(c);

function text(v: unknown, what: string, min = 2, max = 160): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new ClaimInputError(`${what} must be text of ${min} to ${max} characters`);
  return s;
}

function chainOf(v: unknown): ClaimChain {
  const c = String(v ?? '').trim().toLowerCase();
  if ((SUPPORTED_CHAINS as readonly string[]).includes(c) || SOLANA.includes(c)) return c as ClaimChain;
  throw new ClaimInputError(`chain must be one of ${[...SUPPORTED_CHAINS, ...SOLANA].join(', ')}`);
}

function addressOn(chain: ClaimChain, v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (isSolanaChain(chain) ? SOL_ADDRESS.test(s) : EVM_ADDRESS.test(s)) return isSolanaChain(chain) ? s : s.toLowerCase();
  throw new ClaimInputError(`${what} must be a ${isSolanaChain(chain) ? 'Solana' : '0x'} address on ${chain}`);
}

function amount(v: unknown, what: string): string {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!AMOUNT.test(s)) throw new ClaimInputError(`${what} must be an amount in whole tokens, such as 1500 or 0.25`);
  return s;
}

function bool(v: unknown, what: string): boolean {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new ClaimInputError(`${what} must be true or false`);
}

/** One claim as given, checked for shape. Throws ClaimInputError with what is wrong. */
export function normalizeClaim(raw: unknown): Claim {
  if (typeof raw !== 'object' || raw === null) throw new ClaimInputError('a claim must be an object');
  const b = raw as Record<string, unknown>;
  const kind = String(b.kind ?? '').trim().toLowerCase();
  switch (kind) {
    case 'sanctions':
      return { kind, entity: text(b.entity, 'entity'), listed: bool(b.listed, 'listed') };
    case 'registry': {
      const c: RegistryClaim = { kind, entity: text(b.entity, 'entity'), jurisdiction: text(b.jurisdiction, 'jurisdiction', 2, 60) };
      if (b.active !== undefined && b.active !== null) c.active = bool(b.active, 'active');
      if (b.registrationId !== undefined && b.registrationId !== null && String(b.registrationId).trim() !== '') c.registrationId = text(String(b.registrationId), 'registrationId', 1, 60);
      if (b.legalName !== undefined && b.legalName !== null && String(b.legalName).trim() !== '') c.legalName = text(b.legalName, 'legalName');
      if (c.active === undefined && c.registrationId === undefined && c.legalName === undefined) throw new ClaimInputError('a registry claim must state active, registrationId or legalName');
      return c;
    }
    case 'token_balance': {
      const chain = chainOf(b.chain);
      return { kind, chain, wallet: addressOn(chain, b.wallet, 'wallet'), token: addressOn(chain, b.token, 'token'), balance: amount(b.balance, 'balance') };
    }
    case 'token_supply': {
      const chain = chainOf(b.chain);
      return { kind, chain, token: addressOn(chain, b.token, 'token'), totalSupply: amount(b.totalSupply, 'totalSupply') };
    }
    default:
      throw new ClaimInputError(`kind must be one of ${CLAIM_KINDS.join(', ')}`);
  }
}

export function normalizeRequirement(raw: unknown): Requirement {
  if (typeof raw !== 'object' || raw === null) throw new ClaimInputError('a requirement must be an object');
  const b = raw as Record<string, unknown>;
  const kind = String(b.kind ?? '').trim().toLowerCase() as ClaimKind;
  if (!CLAIM_KINDS.includes(kind)) throw new ClaimInputError(`requirement kind must be one of ${CLAIM_KINDS.join(', ')}`);
  const r: Requirement = { kind };
  if (b.entity !== undefined) r.entity = text(b.entity, 'requirement entity');
  if (b.chain !== undefined) r.chain = chainOf(b.chain);
  if (b.wallet !== undefined) r.wallet = addressOn(r.chain ?? 'ethereum', b.wallet, 'requirement wallet');
  if (b.token !== undefined) r.token = addressOn(r.chain ?? 'ethereum', b.token, 'requirement token');
  return r;
}

const sameAddress = (a: string, b: string): boolean => (EVM_ADDRESS.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** True when the claim covers the requirement. */
export function satisfies(claim: Claim, req: Requirement): boolean {
  if (claim.kind !== req.kind) return false;
  if (req.entity !== undefined) {
    if (!('entity' in claim)) return false;
    const want = normName(req.entity), got = normName(claim.entity);
    if (!(want === got || got.includes(want) || want.includes(got))) return false;
  }
  if (req.chain !== undefined && (!('chain' in claim) || claim.chain !== req.chain)) return false;
  if (req.wallet !== undefined && (!('wallet' in claim) || !sameAddress(claim.wallet, req.wallet))) return false;
  if (req.token !== undefined && (!('token' in claim) || !sameAddress(claim.token, req.token))) return false;
  return true;
}

/** A short label for a claim, for titles. */
export function claimLabel(c: Claim): string {
  switch (c.kind) {
    case 'sanctions': return `${c.entity} ${c.listed ? 'is' : 'is not'} sanctioned`;
    case 'registry': return `${c.entity} registry record (${c.jurisdiction})`;
    case 'token_balance': return `${c.wallet.slice(0, 8)}… holds ${c.balance} of ${c.token.slice(0, 8)}… on ${c.chain}`;
    case 'token_supply': return `${c.token.slice(0, 8)}… total supply ${c.totalSupply} on ${c.chain}`;
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function relBps(a: number, b: number): number {
  if (a === b) return 0;
  return (Math.abs(a - b) / Math.max(Math.abs(b), 1e-18)) * 10_000;
}

// ---------------------------------------------------------------------------
// Judges (pure): a claim against its evidence
// ---------------------------------------------------------------------------

const check = (index: number, claim: Claim, status: ClaimStatus, title: string, detail: string, source: ClaimCheck['source'], notes: string[] = []): ClaimCheck => ({ index, claim, status, title, detail, source, notes });

const answerTag = (p: Purchase): string => [p.minerId ? `miner ${p.minerId}${p.minerName ? ` (${p.minerName})` : ''}` : null, p.signalHash ? `signal ${p.signalHash}` : null].filter(Boolean).join(', ');

export function judgeSanctions(index: number, claim: SanctionsClaim, p: Purchase | undefined): ClaimCheck {
  if (!p || !p.ok || !p.fields) return check(index, claim, 'unverified', 'Sanctions screening: no answer', `Telegraph returned no screening for "${claim.entity}"${p?.error ? ` (${p.error.slice(0, 160)})` : ''}.`, 'telegraph');
  const f = p.fields;
  const matched = f.matched;
  const score = num(f.match_score);
  const lists = Array.isArray(f.lists) ? f.lists.map(String) : [];
  const on = lists.length ? ` (${lists.slice(0, 3).join(', ')})` : '';
  if (matched !== true && matched !== false) return check(index, claim, 'unverified', 'Sanctions screening: no clear result', `The screening gave no match result (field status ${JSON.stringify(p.fieldStatus)}). ${answerTag(p)}.`, 'telegraph');
  if (matched === false && score !== null && score >= VERIFY_POLICY.sanctionsNearMatchScore) {
    return check(index, claim, 'unverified', 'Sanctions screening: close name match', `No exact match for "${claim.entity}", but the best fuzzy score is ${score}; a person must compare the names before the claim can stand. ${answerTag(p)}.`, 'telegraph');
  }
  if (matched === claim.listed) {
    return check(index, claim, 'confirmed', claim.listed ? `Confirmed: ${claim.entity} is on a sanctions list` : `Confirmed: ${claim.entity} is not on the lists checked`, `The screening ${matched ? `matched ${Array.isArray(f.matches) ? f.matches.map(String).join(', ') : 'an entry'}` : 'found no match'}${on}. ${answerTag(p)}.`, 'telegraph');
  }
  return check(index, claim, 'contradicted', claim.listed ? `Contradicted: ${claim.entity} is not on the lists checked` : `Contradicted: ${claim.entity} IS on a sanctions list`, `The work says "${claim.entity}" ${claim.listed ? 'is' : 'is not'} sanctioned; the screening ${matched ? `matched ${Array.isArray(f.matches) ? f.matches.map(String).join(', ') : 'an entry'}` : 'found no match'}${on}. ${answerTag(p)}.`, 'telegraph');
}

export function judgeRegistry(index: number, claim: RegistryClaim, p: Purchase | undefined): ClaimCheck {
  if (!p || !p.ok || !p.fields) return check(index, claim, 'unverified', 'Registry: no answer', `Telegraph returned no registry record for "${claim.entity}"${p?.error ? ` (${p.error.slice(0, 160)})` : ''}.`, 'telegraph');
  const f = p.fields;
  const legal = typeof f.legal_name === 'string' && f.legal_name.trim() ? f.legal_name.trim() : null;
  const regId = typeof f.registration_id === 'string' && f.registration_id.trim() ? f.registration_id.trim() : null;
  const juris = typeof f.jurisdiction === 'string' && f.jurisdiction.trim() ? f.jurisdiction.trim() : null;
  if (legal) {
    const want = normName(claim.entity), got = normName(legal);
    if (want && got && !(want === got || got.includes(want) || want.includes(got))) {
      return check(index, claim, 'unverified', 'Registry: record is for another entity', `Asked for "${claim.entity}", the record names "${legal}"${regId ? ` (${regId})` : ''}. It is no evidence either way. ${answerTag(p)}.`, 'telegraph');
    }
  }
  const agreed: string[] = [], wrong: string[] = [], unchecked: string[] = [];
  const said = countryOf(claim.jurisdiction), found = juris ? countryOf(juris) : null;
  if (said && found) (said === found ? agreed : wrong).push(said === found ? `jurisdiction ${juris}` : `jurisdiction: the work says ${claim.jurisdiction}, the registry says ${juris}`);
  if (claim.active !== undefined) {
    if (typeof f.active === 'boolean') (f.active === claim.active ? agreed : wrong).push(f.active === claim.active ? `${f.active ? 'active' : 'inactive'}` : `status: the work says ${claim.active ? 'active' : 'inactive'}, the registry says ${f.active ? 'active' : 'inactive'}`);
    else unchecked.push('active (the registry answer gave no status)');
  }
  if (claim.registrationId !== undefined) {
    if (regId) (regId.replace(/[\s-]/g, '').toLowerCase() === claim.registrationId.replace(/[\s-]/g, '').toLowerCase() ? agreed : wrong).push(regId.replace(/[\s-]/g, '').toLowerCase() === claim.registrationId.replace(/[\s-]/g, '').toLowerCase() ? `registration ${regId}` : `registration id: the work says ${claim.registrationId}, the registry says ${regId}`);
    else unchecked.push('registrationId (the registry answer gave none)');
  }
  if (claim.legalName !== undefined) {
    if (legal) (normName(legal) === normName(claim.legalName) ? agreed : wrong).push(normName(legal) === normName(claim.legalName) ? `legal name ${legal}` : `legal name: the work says "${claim.legalName}", the registry says "${legal}"`);
    else unchecked.push('legalName (the registry answer gave none)');
  }
  const tag = answerTag(p);
  if (wrong.length) return check(index, claim, 'contradicted', `Contradicted: ${claim.entity}'s registry record`, `${wrong.join('; ')}.${agreed.length ? ` Agreed: ${agreed.join(', ')}.` : ''} ${tag}.`, 'telegraph');
  if (unchecked.length) return check(index, claim, 'unverified', `Registry: part of the claim could not be checked`, `Not checkable: ${unchecked.join('; ')}.${agreed.length ? ` Agreed: ${agreed.join(', ')}.` : ''} ${tag}.`, 'telegraph');
  return check(index, claim, 'confirmed', `Confirmed: ${claim.entity}'s registry record`, `${agreed.join(', ') || 'every stated field'} agree with the registry answer. ${tag}.`, 'telegraph');
}

/** A chain amount read for a claim: exact text in whole tokens, or why it could not be read. */
export interface AmountRead { whole: string | null; decimals: number | null; at: string; source: string; error?: string }

/** Exact comparison in token base units, within a tolerance in bps of the chain figure. */
export function withinBps(claimed: string, chainWhole: string, decimals: number, bps: number): { ok: boolean; offBps: number } {
  let c: bigint, r: bigint;
  try {
    c = parseUnits(claimed, decimals);
    r = parseUnits(chainWhole, decimals);
  } catch {
    return { ok: false, offBps: Number.POSITIVE_INFINITY };
  }
  const diff = c > r ? c - r : r - c;
  if (r === 0n) return { ok: diff === 0n, offBps: diff === 0n ? 0 : Number.POSITIVE_INFINITY };
  const off = Number((diff * 1_000_000n) / r) / 100;
  return { ok: diff * 10_000n <= r * BigInt(bps), offBps: off };
}

function crossCheck(p: Purchase | undefined, field: string, chainWhole: string | null, about: string | null): string[] {
  if (!p) return [];
  if (!p.ok || !p.fields) return [`Telegraph cross-check: no answer${p.error ? ` (${p.error.slice(0, 120)})` : ''}.`];
  const answeredFor = typeof p.fields.address === 'string' ? p.fields.address.trim() : '';
  if (about && answeredFor && !sameAddress(answeredFor, about)) return [`Telegraph cross-check: the answer was about ${answeredFor}, not ${about}, so it is no evidence (${answerTag(p)}).`];
  const told = num(p.fields[field]);
  if (told === null) return [`Telegraph cross-check: the answer carried no ${field} (${answerTag(p)}).`];
  if (chainWhole === null) return [`Telegraph cross-check: ${told} (${answerTag(p)}); no chain read to compare.`];
  const bps = relBps(told, Number(chainWhole));
  return [bps <= VERIFY_POLICY.crossCheckToleranceBps
    ? `Telegraph cross-check agrees: ${told} vs chain ${chainWhole} (${bps.toFixed(2)} bps; ${answerTag(p)}).`
    : `Telegraph cross-check DISAGREES with the chain: ${told} vs ${chainWhole} (${Number.isFinite(bps) ? bps.toFixed(0) : '∞'} bps; ${answerTag(p)}). The chain decides; the miner's answer is recorded as wrong.`];
}

export function judgeBalance(index: number, claim: BalanceClaim, read: AmountRead, p: Purchase | undefined): ClaimCheck {
  const notes = crossCheck(p, 'balance', read.whole, claim.wallet);
  if (read.whole === null || read.decimals === null) return check(index, claim, 'unverified', 'Balance: the chain could not be read', `${read.error ?? 'No balance read.'} (${read.source})`, 'chain', notes);
  const r = withinBps(claim.balance, read.whole, read.decimals, VERIFY_POLICY.balanceToleranceBps);
  if (r.ok) return check(index, claim, 'confirmed', `Confirmed: the wallet holds ${read.whole}`, `Claimed ${claim.balance}; the chain shows ${read.whole} at ${read.at} (${r.offBps.toFixed(2)} bps apart, tolerance ${VERIFY_POLICY.balanceToleranceBps}). ${read.source}.`, 'chain', notes);
  return check(index, claim, 'contradicted', `Contradicted: the wallet holds ${read.whole}, not ${claim.balance}`, `Claimed ${claim.balance}; the chain shows ${read.whole} at ${read.at} (${Number.isFinite(r.offBps) ? `${r.offBps.toFixed(2)} bps` : 'unbounded'} apart, tolerance ${VERIFY_POLICY.balanceToleranceBps}). ${read.source}.`, 'chain', notes);
}

export function judgeSupply(index: number, claim: SupplyClaim, read: AmountRead, p: Purchase | undefined): ClaimCheck {
  const notes = crossCheck(p, 'total_supply', read.whole, null);
  if (read.whole === null || read.decimals === null) return check(index, claim, 'unverified', 'Supply: the chain could not be read', `${read.error ?? 'No supply read.'} (${read.source})`, 'chain', notes);
  const r = withinBps(claim.totalSupply, read.whole, read.decimals, VERIFY_POLICY.supplyToleranceBps);
  if (r.ok) return check(index, claim, 'confirmed', `Confirmed: total supply ${read.whole}`, `Claimed ${claim.totalSupply}; the chain shows ${read.whole} at ${read.at} (${r.offBps.toFixed(2)} bps apart, tolerance ${VERIFY_POLICY.supplyToleranceBps}). ${read.source}.`, 'chain', notes);
  return check(index, claim, 'contradicted', `Contradicted: total supply is ${read.whole}, not ${claim.totalSupply}`, `Claimed ${claim.totalSupply}; the chain shows ${read.whole} at ${read.at} (${Number.isFinite(r.offBps) ? `${r.offBps.toFixed(2)} bps` : 'unbounded'} apart, tolerance ${VERIFY_POLICY.supplyToleranceBps}). ${read.source}.`, 'chain', notes);
}

// ---------------------------------------------------------------------------
// The verdict (pure)
// ---------------------------------------------------------------------------

export type WorkVerdict = 'ACCEPTED' | 'REJECTED' | 'INCOMPLETE' | 'REVIEW';

export function workVerdict(checks: ClaimCheck[], missing: number, malformed: number, policyHold: boolean): { verdict: WorkVerdict; rule: string } {
  if (checks.some((c) => c.status === 'contradicted')) return { verdict: 'REJECTED', rule: 'at least one claim is contradicted by the evidence' };
  if (missing > 0 || malformed > 0) return { verdict: 'INCOMPLETE', rule: `nothing is contradicted, but ${[missing ? `${missing} required item${missing > 1 ? 's are' : ' is'} not covered` : null, malformed ? `${malformed} claim${malformed > 1 ? 's are' : ' is'} malformed` : null].filter(Boolean).join(' and ')}` };
  if (checks.length === 0) return { verdict: 'INCOMPLETE', rule: 'the work makes no checkable claim' };
  if (policyHold || checks.some((c) => c.status === 'unverified')) return { verdict: 'REVIEW', rule: 'nothing is contradicted and nothing is missing, but at least one claim could not be verified: a person must look' };
  return { verdict: 'ACCEPTED', rule: 'every required item is covered and every claim is confirmed by independent evidence' };
}
