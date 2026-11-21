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
 *  - addresses are EIP-55 checksummed, except the /tx reply's own fields
 *    (from, to), which are lower case like every hash
 *  - hashes are lowercase 0x-hex
 *  - no wall-clock timestamps inside scored fields (a reply may say when it
 *    was read, as checked_at and provenance.read_at)
 */
import type { RpcTerms, SupportedChain } from '../config/chains.js';

// ---------- ONCHAIN_TX_LOOKUP ----------

/**
 * How much of a lookup the /tx reply shows. `default` is the concise reply
 * the node stores and its judge reads; `full` (?detail=full) adds every raw
 * field, including the calldata, decoded transfers and the exact fee figures.
 */
export type TxDetail = 'default' | 'full';

export interface TxLookupInput {
  /** null = caller did not specify a chain; resolve by searching all chains */
  chain: SupportedChain | null;
  txHash: `0x${string}`;
  detail: TxDetail;
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
 * format (GET /engine/v1/intents/ONCHAIN_TX_LOOKUP_GENERAL -> response.fields.status).
 */
export type TxStatus = 'confirmed' | 'reverted' | 'pending' | 'not_found';

/**
 * A mined transaction's execution outcome, as its receipt records it.
 * `not_recorded`: the receipt has no status field. Ethereum receipts from
 * before the Byzantium upgrade (block 4,370,000) carry a post-transaction
 * state root instead, so no success or revert flag exists for them.
 */
export type ExecutionStatus = 'success' | 'reverted' | 'not_recorded';

/** JSON-RPC methods a transaction lookup reads. */
export type RpcMethod = 'eth_getTransactionByHash' | 'eth_getTransactionReceipt' | 'eth_blockNumber';

/** One endpoint answer a reply is built on. */
export interface RpcRead {
  chain: SupportedChain;
  method: RpcMethod;
  /** Hostname of the endpoint, as listed in src/config/chains.ts */
  host: string;
}

/** Where a /tx reply's facts were read, and on what terms. */
export interface TxProvenance {
  /** Hash of the block the transaction is in; mined transactions only */
  block_hash?: string;
  /** Present when the caller named no chain: every chain searched, in priority order */
  chains_searched?: SupportedChain[];
  /** Hostnames of the endpoints whose answers the reply is built on, in the order they were read */
  hosts: string[];
  methods: RpcMethod[];
  /** When the reads were issued (ISO 8601, UTC). Wall-clock time, never a scored field. */
  read_at: string;
  /** What is known about the terms on which those endpoints are used (PUBLIC_RPC_TERMS) */
  terms: RpcTerms;
  /** ?detail=full only: which host answered each method, chain by chain */
  reads?: RpcRead[];
}

/**
 * The default /tx reply, in every outcome. The node stores the whole body
 * and a judge model reads the first 512 tokens of it with keys sorted, so it
 * holds the intent's fields, the answer, the receipt's outcome and cost and
 * the provenance, and nothing bulky: calldata, decoded transfers, the fee's
 * parts and camelCase duplicates are behind ?detail=full.
 */
interface TxReplyBase {
  /**
   * The outcome stated directly: the transaction, chain, outcome and block
   * first, then who sent what to whom, the value exact in wei. FIRST field on
   * purpose: nodes without an intent_mapping have a parser model read the
   * whole answer, and judge models read the start of the reply.
   */
  answer: string;
  // ---- Telegraph V2 response format: the names and types the node reads by
  // path through intent_mapping (telegraph/truvian-miner.yaml). Verified
  // 2026-11-12 against GET /engine/v1/intents/ONCHAIN_TX_LOOKUP.
  /** Lowercase 0x-hex transaction hash */
  tx_hash: string;
  status: TxStatus;
  /** Lowercase sender; null when not found */
  from: string | null;
  /** Lowercase recipient; null for a contract creation or when not found */
  to: string | null;
  /** Inclusion height (the intent's scored field); null while pending or when not found */
  block_number: number | null;
  /**
   * The transaction's native value in whole coins. A JSON number because the
   * intent types it as one (6 decimals); the exact figure is in the answer
   * and, with ?detail=full, in `valueWei`. null when not found.
   */
  value_eth: number | null;
  /** Chain the answer refers to; null when no chain was named and none has the transaction */
  chain: SupportedChain | null;
  /** The outcome in one word, finer than `status`: a confirmed transaction either succeeded or has no recorded result */
  verdict: 'succeeded' | 'reverted' | 'no_execution_result' | 'pending' | 'not_found';
  /** Static per-outcome confidence that the reads completed and agree (signal_mapping.confidence_field) */
  confidence: number;
  /** When the reply was assembled (ISO 8601, UTC). Wall-clock time, never a scored field. */
  checked_at: string;
  provenance: TxProvenance;
}

/** A mined transaction: what its receipt proves. */
export interface TxMinedReply extends TxReplyBase {
  status: 'confirmed' | 'reverted';
  verdict: 'succeeded' | 'reverted' | 'no_execution_result';
  from: string;
  block_number: number;
  value_eth: number;
  chain: SupportedChain;
  /** The receipt's outcome and cost, exact; the fee's parts are in ?detail=full */
  receipt: {
    execution_status: ExecutionStatus;
    /** Decimal string */
    gas_used: string;
    /** Everything the sender paid, in wei: gasUsed * effectiveGasPrice plus the L1 data fee where the receipt bills one */
    total_fee_wei: string;
  };
}

/** A transaction an endpoint knows about that is not yet in a block. */
export interface TxPendingReply extends TxReplyBase {
  status: 'pending';
  verdict: 'pending';
  from: string;
  block_number: null;
  value_eth: number;
  chain: SupportedChain;
}

/** No endpoint able to prove absence has the transaction. */
export interface TxNotFoundReply extends TxReplyBase {
  status: 'not_found';
  verdict: 'not_found';
  from: null;
  to: null;
  block_number: null;
  value_eth: null;
}

export type TxReply = TxMinedReply | TxPendingReply | TxNotFoundReply;

/** Fields ?detail=full adds to every reply. */
interface TxRawBase {
  /** The answer with the function selector added: every fact in words (signal_mapping.label_field) */
  signal: string;
  /** One-line provenance (signal_mapping.reason_field) */
  source: string;
  chainId: number | null;
  txHash: string;
}

/** Raw fields of a found transaction, mined or not; addresses inside are EIP-55. */
interface TxRawFound extends TxRawBase {
  chainId: number;
  valueWei: string;
  nonce: number;
  inputData: string;
}

/** Raw fields of a mined transaction: the receipt's figures, exact. */
interface TxRawMined extends TxRawFound {
  execution_status: ExecutionStatus;
  blockNumber: string;
  blockHash: string;
  transactionIndex: number;
  /** EIP-55; non-null only for contract creations */
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

export type TxFullReply =
  | (TxMinedReply & TxRawMined)
  | (TxPendingReply & TxRawFound)
  | (TxNotFoundReply & TxRawBase);

// ---------- GAS_PRICE ----------

export interface GasPriceInput {
  chain: SupportedChain;
}

export interface GasPriceResult {
  /**
   * Number-first natural-language answer. FIRST field on purpose: nodes
   * without an intent_mapping have a parser model read the whole answer, and
   * the Season I text scorer read this field.
   */
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

/**
 * A request this miner cannot answer. A transaction that does not exist is
 * not one of these: `not_found` is an answer in the intent's own vocabulary,
 * and /tx returns it as a reply with the provenance of the reads that proved it.
 */
export class IntentError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
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
   * empty error body. `subject` is what the route's request must identify;
   * the default is the transaction lookup's.
   */
  answerText(subject = 'a transaction to look up'): string {
    switch (this.code) {
      case 'CHAIN_UNSUPPORTED':
        return `The requested chain is not served by this miner. ${this.message.charAt(0).toUpperCase()}${this.message.slice(1)}.`;
      case 'INVALID_INPUT':
        return `The request did not identify ${subject}. ${this.message.charAt(0).toUpperCase()}${this.message.slice(1)}.`;
      default:
        return this.message;
    }
  }
}
