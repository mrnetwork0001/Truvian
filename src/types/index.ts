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
  chain: SupportedChain;
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
}
