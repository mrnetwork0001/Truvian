/**
 * Storage for the commerce desks: signed work memos (due diligence,
 * investigations, work verifications) and the business ledger.
 *
 * The ledger is the intelligence business's books (Virtuals "Autonomous
 * Intelligence Businesses", Visa/Monad "paid commercial work"): one line per
 * job with what the customer paid, what the Telegraph answers cost (from the
 * memo, which carries each answer's escrow receipt), the agent model's tokens,
 * and the margin. Free runs are recorded at a price of 0, so the books show
 * what giving them away costs.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Hex } from 'viem';
import type { DiligenceMemo } from './diligence.js';
import type { InvestigationMemo } from './investigate.js';
import type { WorkMemo } from './verifyWork.js';

export type AnyWorkMemo = DiligenceMemo | InvestigationMemo | WorkMemo;

export interface StoredWork {
  id: string;
  memo: AnyWorkMemo;
  sha256: string;
  message: string;
  signature: Hex | null;
  signer: `0x${string}` | null;
}

export interface WorkSummary {
  id: string;
  createdAt: string;
  kind: AnyWorkMemo['kind'];
  /** The decision: a recommendation or a verdict */
  decision: string;
  subject: string;
  costUsd: number;
  sha256: string;
}

function decisionOf(m: AnyWorkMemo): string {
  return m.kind === 'work-verification' ? m.verdict : m.recommendation;
}

function subjectOf(m: AnyWorkMemo): string {
  if (m.kind === 'work-verification') return m.task.slice(0, 120);
  return `${m.subject.entity} (${m.subject.jurisdiction})`;
}

function persister(file: string | null) {
  let writing: Promise<void> = Promise.resolve();
  return (value: unknown) => {
    if (!file) return;
    const snapshot = JSON.stringify(value);
    writing = writing.then(() => writeFile(file, snapshot, 'utf8')).catch(() => {});
  };
}

function load<T>(file: string | null, ok: (x: T) => boolean): T[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]).filter(ok) : [];
  } catch {
    return [];
  }
}

export interface WorkStore {
  add(signed: Omit<StoredWork, 'id'>): StoredWork;
  get(id: string): StoredWork | undefined;
  recent(limit?: number, kind?: AnyWorkMemo['kind']): WorkSummary[];
}

export function createWorkStore(file: string | null, max = 200): WorkStore {
  let items = load<StoredWork>(file, (m) => typeof m?.id === 'string' && typeof m?.sha256 === 'string').slice(-max);
  const persist = persister(file);
  return {
    add(signed) {
      const entry: StoredWork = { id: randomBytes(6).toString('base64url'), ...signed };
      items.push(entry);
      if (items.length > max) items = items.slice(-max);
      persist(items);
      return entry;
    },
    get(id) {
      return items.find((m) => m.id === id);
    },
    recent(limit = 12, kind) {
      return items.filter((m) => !kind || m.memo.kind === kind).slice(-limit).reverse().map((m) => ({
        id: m.id,
        createdAt: m.memo.createdAt,
        kind: m.memo.kind,
        decision: decisionOf(m.memo),
        subject: subjectOf(m.memo),
        costUsd: m.memo.kind === 'investigation' ? m.memo.cost.telegraphUsd : m.memo.cost.telegraphUsd,
        sha256: m.sha256,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// The business ledger
// ---------------------------------------------------------------------------

export type Channel = 'free' | 'x402' | 'acp';

export interface LedgerEntry {
  at: string;
  /** The memo the job produced */
  memoId: string;
  product: AnyWorkMemo['kind'];
  channel: Channel;
  /** What the customer paid, in USD (USDC); 0 for a free run */
  priceUsd: number;
  /** Where the payment settled, when it did */
  payment: { network: string; transaction: string | null } | null;
  /** The ACP job, when the work was sold on ACP */
  acpJobId: string | null;
  /** The Telegraph answers the job bought, as billed (each with its escrow receipt in the memo) */
  telegraphUsd: number;
  telegraphRequests: number;
  /** Agent model tokens, when a model was used */
  llmTokens: number | null;
  llmModel: string | null;
  marginUsd: number;
}

export interface LedgerSummary {
  jobs: number;
  paidJobs: number;
  revenueUsd: number;
  telegraphUsd: number;
  marginUsd: number;
  /** Margin over revenue, of paid jobs only; null before the first paid job */
  paidMarginPct: number | null;
  llmTokens: number;
  byChannel: Record<Channel, { jobs: number; revenueUsd: number; telegraphUsd: number; marginUsd: number }>;
  byProduct: Record<string, { jobs: number; revenueUsd: number; telegraphUsd: number }>;
  note: string;
}

const r6 = (n: number) => Number(n.toFixed(6));

export interface Ledger {
  record(e: Omit<LedgerEntry, 'at' | 'marginUsd'>): LedgerEntry;
  entries(limit?: number): LedgerEntry[];
  summary(): LedgerSummary;
}

export function createLedger(file: string | null, max = 5000): Ledger {
  let items = load<LedgerEntry>(file, (e) => typeof e?.memoId === 'string').slice(-max);
  const persist = persister(file);
  return {
    record(e) {
      const entry: LedgerEntry = { ...e, at: new Date().toISOString(), priceUsd: r6(e.priceUsd), telegraphUsd: r6(e.telegraphUsd), marginUsd: r6(e.priceUsd - e.telegraphUsd) };
      items.push(entry);
      if (items.length > max) items = items.slice(-max);
      persist(items);
      return entry;
    },
    entries(limit = 50) {
      return items.slice(-limit).reverse();
    },
    summary() {
      const zero = () => ({ jobs: 0, revenueUsd: 0, telegraphUsd: 0, marginUsd: 0 });
      const byChannel: LedgerSummary['byChannel'] = { free: zero(), x402: zero(), acp: zero() };
      const byProduct: LedgerSummary['byProduct'] = {};
      let revenue = 0, tg = 0, tokens = 0, paidRevenue = 0, paidCost = 0, paid = 0;
      for (const e of items) {
        revenue += e.priceUsd;
        tg += e.telegraphUsd;
        tokens += e.llmTokens ?? 0;
        if (e.priceUsd > 0) { paid++; paidRevenue += e.priceUsd; paidCost += e.telegraphUsd; }
        const c = byChannel[e.channel];
        c.jobs++; c.revenueUsd = r6(c.revenueUsd + e.priceUsd); c.telegraphUsd = r6(c.telegraphUsd + e.telegraphUsd); c.marginUsd = r6(c.revenueUsd - c.telegraphUsd);
        const p = (byProduct[e.product] ??= { jobs: 0, revenueUsd: 0, telegraphUsd: 0 });
        p.jobs++; p.revenueUsd = r6(p.revenueUsd + e.priceUsd); p.telegraphUsd = r6(p.telegraphUsd + e.telegraphUsd);
      }
      return {
        jobs: items.length,
        paidJobs: paid,
        revenueUsd: r6(revenue),
        telegraphUsd: r6(tg),
        marginUsd: r6(revenue - tg),
        paidMarginPct: paidRevenue > 0 ? Number((((paidRevenue - paidCost) / paidRevenue) * 100).toFixed(2)) : null,
        llmTokens: tokens,
        byChannel,
        byProduct,
        note: 'Revenue settles in USDC (x402 on Base Sepolia, or ACP on Base). Telegraph cost is what the escrow was billed for the answers, test USDC on Ethereum Sepolia during Season II. Model tokens are counted, not priced: the margin excludes them.',
      };
    },
  };
}
