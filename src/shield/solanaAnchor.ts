/**
 * Anchor a memo digest on Solana devnet with the SPL Memo program.
 *
 * The transaction carries one Memo instruction whose text is
 * "Truvian Resolve sha256:<digest>", signed by the devnet-only wallet in
 * SOLANA_DEVNET_KEY (base64 of the 64-byte secret key). Anyone can read the
 * transaction on an explorer and compare its memo text with the digest of the
 * signed memo: the anchor proves the decision existed, unchanged, by that slot.
 *
 * The anchor is kept beside the signed memo, not inside it: the memo is signed
 * first and its digest is what gets anchored, so it cannot also contain the
 * transaction that records it.
 *
 * Never throws. A wallet without enough SOL for the fee is reported as
 * "not anchored: wallet unfunded" and nothing is sent.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RPC_URL = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
/** One signature's fee is 5,000 lamports; keep a margin. */
const MIN_LAMPORTS = 10_000;
const TIMEOUT_MS = 45_000;

export interface SolanaAnchor {
  cluster: 'devnet';
  anchored: boolean;
  /** The memo text written on chain (or that would have been) */
  memoText: string;
  /** Transaction signature, when anchored */
  signature?: string;
  slot?: number;
  explorer?: string;
  /** The wallet that signs anchors */
  wallet?: string;
  /** Why it was not anchored */
  note?: string;
}

export function anchorText(sha256: string): string {
  return `Truvian Resolve sha256:${sha256}`;
}

function keypair(): Keypair | null {
  const raw = process.env.SOLANA_DEVNET_KEY?.trim();
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw, 'base64');
    return bytes.length === 64 ? Keypair.fromSecretKey(new Uint8Array(bytes)) : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms))]);
}

export async function anchorDigest(sha256: string): Promise<SolanaAnchor> {
  const memoText = anchorText(sha256);
  const kp = keypair();
  if (!kp) return { cluster: 'devnet', anchored: false, memoText, note: 'not anchored: SOLANA_DEVNET_KEY is not set' };
  const wallet = kp.publicKey.toBase58();
  try {
    const conn = new Connection(RPC_URL, 'confirmed');
    const lamports = await withTimeout(conn.getBalance(kp.publicKey), TIMEOUT_MS, 'balance read');
    if (lamports < MIN_LAMPORTS) return { cluster: 'devnet', anchored: false, memoText, wallet, note: `not anchored: wallet unfunded (${lamports} lamports on devnet)` };
    const tx = new Transaction().add(new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }));
    const signature = await withTimeout(sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' }), TIMEOUT_MS, 'anchor transaction');
    const status = await conn.getSignatureStatus(signature).catch(() => null);
    const out: SolanaAnchor = { cluster: 'devnet', anchored: true, memoText, wallet, signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
    if (status?.context.slot) out.slot = status.context.slot;
    return out;
  } catch (err) {
    return { cluster: 'devnet', anchored: false, memoText, wallet, note: `not anchored: ${err instanceof Error ? err.message : String(err)}` };
  }
}
