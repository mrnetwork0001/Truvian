/**
 * Truvian intent payload types.
 *
 * These are OUR canonical handler shapes, deliberately envelope-agnostic:
 * the Telegraph request/response envelope is not yet confirmed, and per
 * project rules we do not guess schemas. A thin adapter in src/miner/
 * maps Telegraph's contract onto these once recon confirms it.
 *
 * Determinism rules (Tier A intents are scored by exact match):
 *  - every big number is a decimal string, never a JS number or hex
 *  - addresses are EIP-55 checksummed
 *  - hashes are lowercase 0x-hex
 *  - no wall-clock timestamps inside scored fields
 */
import type { SupportedChain } from '../config/chains.js';

// ---------- ONCHAIN_TX_LOOKUP ----------

export interface TxLookupInput {
  /** null = caller did not specify a chain; resolve by searching all chains */
  chain: SupportedChain | null;
  txHash: `0x${string}`;
}

export interface DecodedTransfer {
  /** Emitting token contract, EIP-55 */
  token: string;
  from: string;
  to: string;
  /** Raw token units as decimal string (no decimals scaling — that is presentation) */
  amount: string;
  logIndex: number;
}

export interface TxLookupResult {
  /**
   * Number-first natural-language statement of the facts, FIRST field on
   * purpose: Telegraph validators score miner responses against ground truth
   * as text. Verified empirically (epoch 267): miners returning bare JSON
   * score ~0; the two miners leading ONCHAIN_TX_LOOKUP (0.88 / 0.83) answer
   * with concise exact-figure statements.
   */
  answer: string;
  /**
   * Telegraph signal_mapping.label_field. Carries the FULL answer statement:
   * the node translates miner responses to an internal standard built from
   * the mapped fields, so the scored text must live here (the rank-1 miner's
   * `signal` is its complete sentence — verified against its live API).
   */
  signal: string;
  /** Provenance for signal_mapping.reason_field */
  source: string;
  /** Static per-intent confidence for signal_mapping.confidence_field */
  confidence: number;
  chain: SupportedChain;
  chainId: number;
  txHash: string;
  status: 'success' | 'reverted';
  blockNumber: string;
  blockHash: string;
  transactionIndex: number;
  from: string;
  /** null for contract creations */
  to: string | null;
  /** non-null only for contract creations */
  contractAddress: string | null;
  valueWei: string;
  nonce: number;
  inputData: string;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP-stack L1 data fee in wei; "0" on non-OP-stack chains */
  l1FeeWei: string;
  /** gasUsed * effectiveGasPrice + l1Fee — the true total cost */
  totalFeeWei: string;
  logCount: number;
  erc20Transfers: DecodedTransfer[];
  /** Confirmations at response time — informational, NOT a scored field */
  confirmations: string;
}

// ---------- GAS_PRICE ----------

export interface GasPriceInput {
  chain: SupportedChain;
}

export interface GasPriceResult {
  /** Number-first natural-language answer — see TxLookupResult.answer */
  answer: string;
  signal: string;
  source: string;
  confidence: number;
  chain: SupportedChain;
  chainId: number;
  /** Block this snapshot is anchored to — makes the answer verifiable */
  blockNumber: string;
  baseFeePerGasWei: string;
  /** eth_gasPrice */
  gasPriceWei: string;
  /** eth_maxPriorityFeePerGas */
  maxPriorityFeePerGasWei: string;
  /** Priority-fee percentiles over the last 5 blocks (eth_feeHistory) */
  priorityFeePercentilesWei: { p25: string; p50: string; p75: string };
  /** L1 gas price observed by the OP-stack chain; "0" elsewhere */
  l1GasPriceWei: string;
}

// ---------- errors ----------

export class IntentError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'TX_NOT_FOUND'
      | 'CHAIN_UNSUPPORTED'
      | 'UPSTREAM_RPC_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'IntentError';
  }

  /**
   * Plain-language statement of the outcome, used as the `answer` on intent
   * routes so a failed lookup still returns scoreable text rather than an
   * empty error body.
   */
  get answerText(): string {
    switch (this.code) {
      case 'TX_NOT_FOUND':
        return `${this.message.charAt(0).toUpperCase()}${this.message.slice(1)}. The transaction hash is well formed but no matching transaction exists on the chains searched, so it was never mined there or belongs to a chain this miner does not serve.`;
      case 'CHAIN_UNSUPPORTED':
        return `This miner serves Base, Ethereum, Base Sepolia and X Layer. ${this.message}.`;
      case 'INVALID_INPUT':
        return `The request did not identify a transaction to look up. ${this.message}.`;
      default:
        return this.message;
    }
  }
}
