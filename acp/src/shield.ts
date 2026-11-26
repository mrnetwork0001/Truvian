/**
 * Shield's commerce desks over HTTP, as Truvian's ACP agents use them.
 * Typed loosely on purpose: the memo is passed through as Shield signed it.
 */
import { shieldKey, shieldUrl } from './config.js';

export class ShieldError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${shieldUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shieldKey()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6 * 60_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ShieldError(res.status, `${path}: HTTP ${res.status} ${String(json.message ?? json.error ?? '')}`.trim());
  return json as T;
}

export interface Claim { kind: string; [k: string]: unknown }

export interface StoredWork<M> {
  id: string;
  memo: M;
  sha256: string;
  signature: string | null;
  signer: string | null;
  url: string;
}

export interface DiligenceMemo {
  kind: 'due-diligence';
  recommendation: 'PROCEED' | 'REVIEW' | 'DECLINE';
  recommendationRule: string;
  report: { summary: string; claims: Claim[] };
  findings: Array<{ rule: string; severity: string; title: string; detail: string }>;
  cost: { telegraphUsd: number; paidRequests: number };
}

export interface WorkMemo {
  kind: 'work-verification';
  verdict: 'ACCEPTED' | 'REJECTED' | 'INCOMPLETE' | 'REVIEW';
  verdictRule: string;
  checks: Array<{ index: number; status: string; title: string; detail: string }>;
  missing: Array<Record<string, unknown>>;
  malformed: Array<{ index: number; error: string }>;
  cost: { telegraphUsd: number; paidRequests: number };
}

export function diligence(subject: { entity: string; jurisdiction: string; wallets?: unknown[]; purpose?: string }): Promise<StoredWork<DiligenceMemo>> {
  return call('POST', '/api/diligence', subject);
}

export function verifyWork(req: { task: string; requirements: unknown[]; deliverable: { claims: unknown[] } | { text: string }; worker: string }): Promise<StoredWork<WorkMemo>> {
  return call('POST', '/api/verify-work', req);
}

export function book(memoId: string, priceUsd: number, acpJobId: string, network: string): Promise<unknown> {
  return call('POST', '/api/business/book', { memoId, priceUsd, acpJobId, network });
}

export const memoUrl = (id: string) => `${shieldUrl()}/api/work/${id}`;
