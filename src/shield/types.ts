/**
 * Truvian Shield contract types — the single source of truth shared by the
 * Telegraph transport (telegraph.ts), the verdict engine (verdict.ts), the
 * API server (server.ts) and the dashboard.
 *
 * Deliberately structural (interfaces + string-literal unions, no classes):
 * telegraph.ts may import these or declare identical shapes — either way the
 * modules stay assignment-compatible.
 */

export type ShieldIntent = 'GAS_PRICE' | 'ONCHAIN_TX_LOOKUP' | 'CRYPTO_PRICE' | 'TVL_LOOKUP';

/**
 * How the answer was obtained from Telegraph:
 *  - 'x402'   — paid through the Telegraph engine/dispatcher with TELEGRAPH_PAYER_KEY
 *  - 'direct' — live miner called on its public base_url from the FREE catalog
 *               (still a real Telegraph miner; dev/fallback mode, labeled as such)
 */
export type ShieldTransport = 'x402' | 'direct';

/** One live Telegraph miner answer, as returned by askIntent(). */
export interface IntentResult {
  /** Natural-language answer text exactly as the miner returned it */
  answer: string;
  minerId?: string;
  minerName?: string;
  /** x402 payment cost in USD, when the transport paid for the answer */
  costUsd?: number;
  /** Telegraph signal hash — verifiable at GET /engine/v1/signal/{hash} */
  signalHash?: string;
  latencyMs: number;
  transport: ShieldTransport;
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
  /** A prior on-chain tx referenced as evidence about the counterparty */
  txHash?: string;
  /** Protocol name for the liquidity (TVL) check */
  protocol?: string;
}

/** Shape of GET /api/stats (persisted best-effort to .shield-stats.json). */
export interface ShieldStats {
  checksRun: number;
  telegraphRequests: number;
  byIntent: Record<ShieldIntent, number>;
}
