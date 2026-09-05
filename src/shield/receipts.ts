/**
 * Shareable receipts for Truvian Shield.
 *
 * "No mocked data" is a claim until someone can click it. Every finished
 * report is kept under a short id so it has a permanent URL (/app?r=<id>),
 * and the most recent ones are published as a public feed. Each stored check
 * carries the miner that answered, what it cost, and the Telegraph signal
 * hash, so a reader can resolve the same hash on the node and see the answer
 * we were given.
 *
 * Only what the caller already sent about PUBLIC chain state is stored (chain,
 * counterparty address, value, transaction hash, protocol) plus the report.
 * No IP address, no wallet, no payment details.
 *
 * The store is a bounded ring in memory, persisted best-effort to disk so the
 * feed survives a restart.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { CheckReport, CheckRequest } from './types.js';

/** Reports kept for the public feed and permalinks. */
const DEFAULT_MAX = 50;

export interface StoredReceipt {
  id: string;
  /** ISO 8601, when the report was produced. */
  at: string;
  request: CheckRequest;
  report: CheckReport;
}

/** One row of the public feed - enough to render without the full report. */
export interface ReceiptSummary {
  id: string;
  at: string;
  verdict: CheckReport['verdict'];
  score: number;
  chain: string;
  checks: number;
  /** Signal hashes in this report, so the feed itself is verifiable. */
  signals: string[];
  txHash?: string;
  protocol?: string;
}

export interface ReceiptStore {
  add(request: CheckRequest, report: CheckReport): StoredReceipt;
  get(id: string): StoredReceipt | undefined;
  recent(limit?: number): ReceiptSummary[];
  size(): number;
}

function summarize(entry: StoredReceipt): ReceiptSummary {
  const signals: string[] = [];
  for (const check of entry.report.checks) {
    if (typeof check.signalHash === 'string' && check.signalHash !== '') signals.push(check.signalHash);
  }
  const summary: ReceiptSummary = {
    id: entry.id,
    at: entry.at,
    verdict: entry.report.verdict,
    score: entry.report.score,
    chain: entry.request.chain ?? 'base',
    checks: entry.report.checks.length,
    signals,
  };
  if (entry.request.txHash !== undefined) summary.txHash = entry.request.txHash;
  if (entry.request.protocol !== undefined) summary.protocol = entry.request.protocol;
  return summary;
}

/**
 * Build a receipt store backed by `file`. Reading a corrupt or missing file is
 * not an error - the feed simply starts empty.
 */
export function createReceiptStore(file: string, max = DEFAULT_MAX): ReceiptStore {
  const entries: StoredReceipt[] = [];
  const byId = new Map<string, StoredReceipt>();

  const remember = (entry: StoredReceipt): void => {
    entries.push(entry);
    byId.set(entry.id, entry);
    while (entries.length > max) {
      const dropped = entries.shift();
      if (dropped) byId.delete(dropped.id);
    }
  };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      for (const raw of parsed) {
        const entry = raw as Partial<StoredReceipt>;
        if (typeof entry.id === 'string' && typeof entry.at === 'string' && entry.report && entry.request) {
          remember(entry as StoredReceipt);
        }
      }
    }
  } catch {
    // no feed yet
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): void => {
    const snapshot = JSON.stringify(entries, null, 2);
    writeChain = writeChain.then(() => writeFile(file, snapshot, 'utf8')).catch(() => {});
  };

  return {
    add(request, report) {
      const entry: StoredReceipt = {
        id: randomBytes(5).toString('hex'),
        at: new Date().toISOString(),
        request,
        report,
      };
      remember(entry);
      persist();
      return entry;
    },
    get: (id) => byId.get(id),
    recent(limit = 12) {
      const count = Math.max(1, Math.min(limit, max));
      return entries.slice(-count).reverse().map(summarize);
    },
    size: () => entries.length,
  };
}
