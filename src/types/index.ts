/**
 * Truvian intent payload types.
 *
 * These are OUR canonical handler shapes, deliberately envelope-agnostic:
 * the Telegraph request/response envelope is not yet confirmed, and per
 * project rules we do not guess schemas. A thin adapter in src/miner/
 * maps Telegraph's contract onto these once recon confirms it.
 *
 * Determinism rules (Tier A intents are scored by exact match):
 *  - every big number is a decimal string, never a JS number or hex; the only
 *    JSON numbers are the fields Telegraph's response format types as numbers
 *    (block_number, value_eth, gas_price_gwei), each beside its exact string
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
  /** Raw token units as decimal string (no decimals scaling - that is presentation) */
  amount: string;
  logIndex: number;
}

/**
 * Lifecycle status in the vocabulary of the Telegraph intent's response
 * format (GET /engine/v1/intents/ONCHAIN_TX_LOOKUP -> response.fields.status).
 * `not_found` is reported through IntentError, never through a result.
 */
export type TxStatus = 'confirmed' | 'reverted' | 'pending';

/** Fields every found transaction carries, mined or not. */
interface TxLookupBase {
  /**
   * Number-first natural-language statement of the facts, FIRST field on
   * purpose: nodes without an intent_mapping have a parser model read the
   * whole answer, and the Season I text scorer read this field.
   */
  answer: string;
  /**
   * Telegraph signal_mapping.label_field. Carries the FULL answer statement:
   * the node translates miner responses to an internal standard built from
   * the mapped fields, so the scored text must live here (the rank-1 miner's
   * `signal` is its complete sentence - verified against its live API).
   */
  signal: string;
  /** Provenance for signal_mapping.reason_field */
  source: string;
  /** Static per-intent confidence for signal_mapping.confidence_field */
  confidence: number;

  // ---- Telegraph V2 response format: the names and types the node reads by
  // path through intent_mapping (telegraph/truvian-miner.yaml). Verified
  // 2026-11-12 against GET /engine/v1/intents/ONCHAIN_TX_LOOKUP.
  /** Lowercase 0x-hex transaction hash */
  tx_hash: string;
  status: TxStatus;
  /** EIP-55 sender */
  from: string;
  /** EIP-55 recipient; null for contract creations */
  to: string | null;
  /** Inclusion height (the intent's scored field); null while pending */
  block_number: number | null;
  /**
   * The transaction's native value in whole coins. A JSON number because the
   * intent types it as one (6 decimals); the exact figure is `valueWei`.
   */
  value_eth: number;

  // ---- Truvian's own exact, raw-faithful fields
  chain: SupportedChain;
  chainId: number;
  txHash: string;
  valueWei: string;
  nonce: number;
  inputData: string;
}

/** A mined transaction: everything the receipt proves. */
export interface TxLookupResult extends TxLookupBase {
  status: 'confirmed' | 'reverted';
  block_number: number;
  /** Receipt execution outcome, in the receipt's own words */
  execution_status: 'success' | 'reverted';
  blockNumber: string;
  blockHash: string;
  transactionIndex: number;
  /** non-null only for contract creations */
  contractAddress: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  /** L1 data fee the receipt reports, in wei (OP-stack chains and Scroll); "0" where it reports none */
  l1FeeWei: string;
  /** gasUsed * effectiveGasPrice + l1Fee - the true total cost */
  totalFeeWei: string;
  logCount: number;
  erc20Transfers: DecodedTransfer[];
  /**
   * Confirmations at response time - informational, NOT a scored field.
   * null when no endpoint could report the chain tip.
   */
  confirmations: string | null;
}

/** A transaction the node knows about that is not yet in a block. */
export interface TxPendingResult extends TxLookupBase {
  status: 'pending';
  block_number: null;
}

// ---------- GAS_PRICE ----------

export interface GasPriceInput {
  chain: SupportedChain;
}

export interface GasPriceResult {
  /** Number-first natural-language answer - see TxLookupBase.answer */
  answer: string;
  signal: string;
  source: string;
  confidence: number;
  chain: SupportedChain;
  chainId: number;
  /** Block this snapshot is anchored to - makes the answer verifiable */
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

  // ---- Telegraph V2 response format (GET /engine/v1/intents/GAS_PRICE)
  /**
   * eth_gasPrice in gwei (the intent's scored field). A JSON number because
   * the intent types it as one (6 decimals); the exact figure is `gasPriceWei`.
   */
  gas_price_gwei: number;
  /** Timestamp of the anchoring block (ISO 8601, UTC) - chain time, not wall-clock */
  as_of: string;
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
    /**
     * Structured fields to return beside the answer text when the outcome is
     * itself an answer (a transaction that does not exist has status
     * `not_found` in the intent's response format).
     */
    public readonly fields: Record<string, unknown> = {},
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
        return `The requested chain is not served by this miner. ${this.message.charAt(0).toUpperCase()}${this.message.slice(1)}.`;
      case 'INVALID_INPUT':
        return `The request did not identify a transaction to look up. ${this.message}.`;
      default:
        return this.message;
    }
  }
}
