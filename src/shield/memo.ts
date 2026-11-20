/**
 * Tamper-evident decision memos.
 *
 * A memo is hashed as canonical JSON (keys sorted, no whitespace) and the
 * digest is signed with Shield's memo key (EIP-191 personal message). Anyone
 * holding a memo can recompute the digest and recover the signer, with this
 * server (POST /api/memo/verify) or without it (any EIP-191 library):
 *
 *   message   = "Truvian Shield memo sha256:" + sha256(canonicalJson(memo))
 *   signer    = recoverMessageAddress({ message, signature })
 *
 * The memo key is SHIELD_MEMO_KEY, used for nothing else. It is not the miner
 * wallet and holds no funds. Without it memos are still hashed, just unsigned.
 *
 * Memos are kept in a bounded ring persisted to disk, like receipts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PreflightMemo } from './preflight.js';

/** JSON with object keys sorted at every level and undefined dropped: one text per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function memoDigest(memo: unknown): string {
  return createHash('sha256').update(canonicalJson(memo)).digest('hex');
}

export function memoMessage(digest: string): string {
  return `Truvian Shield memo sha256:${digest}`;
}

function memoAccount() {
  const key = process.env.SHIELD_MEMO_KEY?.trim();
  if (!key) return null;
  try {
    return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  } catch {
    return null;
  }
}

/** The address memos are signed by, or null when no memo key is configured. */
export function memoSigner(): `0x${string}` | null {
  return memoAccount()?.address ?? null;
}

export interface SignedMemo {
  id: string;
  memo: PreflightMemo;
  sha256: string;
  message: string;
  signature: Hex | null;
  signer: `0x${string}` | null;
}

export async function signMemo(memo: PreflightMemo): Promise<Omit<SignedMemo, 'id'>> {
  const sha256 = memoDigest(memo);
  const message = memoMessage(sha256);
  const account = memoAccount();
  if (!account) return { memo, sha256, message, signature: null, signer: null };
  return { memo, sha256, message, signature: await account.signMessage({ message }), signer: account.address };
}

export interface MemoVerification {
  sha256: string;
  message: string;
  /** Who signed this exact memo, recovered from the signature */
  recoveredSigner: `0x${string}` | null;
  /** True when the recovered signer is this Shield's memo key */
  signedByThisShield: boolean;
  shieldSigner: `0x${string}` | null;
  error?: string;
}

export async function verifyMemo(memo: unknown, signature: unknown): Promise<MemoVerification> {
  const sha256 = memoDigest(memo);
  const message = memoMessage(sha256);
  const shieldSigner = memoSigner();
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { sha256, message, recoveredSigner: null, signedByThisShield: false, shieldSigner, error: 'signature must be 0x followed by 130 hexadecimal characters' };
  }
  try {
    const recoveredSigner = await recoverMessageAddress({ message, signature: signature as Hex });
    return { sha256, message, recoveredSigner, signedByThisShield: shieldSigner !== null && recoveredSigner === shieldSigner, shieldSigner };
  } catch (err) {
    return { sha256, message, recoveredSigner: null, signedByThisShield: false, shieldSigner, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- store ----------

const DEFAULT_MAX = 100;

export interface MemoSummary {
  id: string;
  createdAt: string;
  kind: PreflightMemo['kind'];
  decision: PreflightMemo['decision'];
  chain: string;
  token: string;
  symbol: string | null;
  costUsd: number;
  sha256: string;
}

export interface MemoStore {
  add(signed: Omit<SignedMemo, 'id'>): SignedMemo;
  get(id: string): SignedMemo | undefined;
  recent(limit?: number): MemoSummary[];
}

export function createMemoStore(file: string | null, max = DEFAULT_MAX): MemoStore {
  let items: SignedMemo[] = [];
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) items = (parsed as SignedMemo[]).filter((m) => typeof m?.id === 'string' && typeof m?.sha256 === 'string').slice(-max);
    } catch {
      // first run or unreadable file
    }
  }
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    if (!file) return;
    const snapshot = JSON.stringify(items);
    writing = writing.then(() => writeFile(file, snapshot, 'utf8')).catch(() => {});
  };
  return {
    add(signed) {
      const entry: SignedMemo = { id: randomBytes(6).toString('base64url'), ...signed };
      items.push(entry);
      if (items.length > max) items = items.slice(-max);
      persist();
      return entry;
    },
    get(id) {
      return items.find((m) => m.id === id);
    },
    recent(limit = 12) {
      return items.slice(-limit).reverse().map((m) => ({
        id: m.id,
        createdAt: m.memo.createdAt,
        kind: m.memo.kind,
        decision: m.memo.decision,
        chain: m.memo.input.chain,
        token: m.memo.input.token,
        symbol: m.memo.chainReads?.symbol ?? null,
        costUsd: m.memo.cost.telegraphUsd,
        sha256: m.sha256,
      }));
    },
  };
}
