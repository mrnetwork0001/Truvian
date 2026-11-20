/**
 * Truvian Shield contract types - the single source of truth shared by the
 * Telegraph transport (telegraph.ts), the verdict engine (verdict.ts), the
 * API server (server.ts) and the dashboard.
 *
 * Deliberately structural (interfaces + string-literal unions, no classes):
 * telegraph.ts may import these or declare identical shapes - either way the
 * modules stay assignment-compatible.
 */

export type ShieldIntent = 'GAS_PRICE' | 'ONCHAIN_TX_LOOKUP' | 'CRYPTO_PRICE' | 'TVL_LOOKUP';

/**
 * How the answer was obtained from Telegraph:
 *  - 'x402'   - routed by the Telegraph engine and paid per request by x402 with TELEGRAPH_PAYER_KEY
 *  - 'apikey' - routed the same way through Anjoman's API with TELEGRAPH_API_KEY, paid from escrow
 *  - 'direct' - live miner called on its public base_url from the FREE catalog
 *               (still a real Telegraph miner; dev/fallback mode, labeled as such)
 */
export type ShieldTransport = 'x402' | 'apikey' | 'direct';

/** Transports on which the answer was paid for. */
export function isPaidTransport(t: ShieldTransport): boolean {
  return t === 'x402' || t === 'apikey';
}

/** One live Telegraph miner answer, as returned by askIntent(). */
export interface IntentResult {
  /**
   * The answer in words. Since Telegraph V2 the node returns the intent's
   * typed fields, and this sentence is composed from them in a fixed wording
   * (telegraph.ts composeAnswer). On the direct transport it is the miner's
   * own text.
   */
  answer: string;
  minerId?: string;
  minerName?: string;
  /** What the answer cost in USD, when the transport paid for it */
  costUsd?: number;
  /** Telegraph signal hash - verifiable at GET /engine/v1/signal/{hash} */
  signalHash?: string;
  latencyMs: number;
  transport: ShieldTransport;
  /** The intent's V2 response fields, when the node returned them in that shape */
  fields?: Record<string, unknown>;
  /** Untouched upstream response body, kept for evidence display */
  raw: unknown;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'error';
export type ShieldVerdict = 'SAFE' | 'CAUTION' | 'BLOCK';

/** One evidence-backed safety check inside a CheckReport. */
export interface CheckItem {
  name: string;
  intent: ShieldIntent;
  status: CheckStatus;
  /** One-line human explanation of why this check got its status */
  summary: string;
  /** The miner answer this check was judged from ('' when the query errored) */
  answer: string;
  signalHash?: string;
  minerName?: string;
  costUsd?: number;
  latencyMs: number;
  transport: ShieldTransport;
}

/** Go / no-go report for a proposed transaction. */
export interface CheckReport {
  verdict: ShieldVerdict;
  /** 0-100, starts at 100 and loses points per warn/fail/error */
  score: number;
  reasons: string[];
  checks: CheckItem[];
}

/** Normalized POST /api/check request body. */
export interface CheckRequest {
  chain?: string;
  /** Counterparty address the caller is about to transact with (0x-hex, 20 bytes) */
  to?: string;
  /** Transaction value in ETH */
  valueEth?: number;
  /** A prior onchain tx referenced as evidence about the counterparty */
  txHash?: string;
  /** Protocol name for the liquidity (TVL) check */
  protocol?: string;
}

/** Shape of GET /api/stats (persisted best-effort to .shield-stats.json). */
export interface ShieldStats {
  checksRun: number;
  telegraphRequests: number;
  byIntent: Record<ShieldIntent, number>;
  /** Real USD paid to live miners over x402, all-time. */
  paidUsd: number;
  /** Real USD collected from callers who paid Shield over x402, all-time. */
  earnedUsd: number;
  /** Checks that were paid for (as opposed to run on the free allowance). */
  paidChecks: number;
  /** Token preflights and listing reviews run (POST /api/preflight). */
  preflightsRun: number;
}
