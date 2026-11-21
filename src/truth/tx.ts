/**
 * The block a transaction was included in, agreed by two receipt archives
 * run by different providers.
 *
 * Backs a Telegraph truth source for ONCHAIN_TX_LOOKUP_GENERAL, whose scored
 * field is `block_number` (block height). Both endpoints must return the same
 * receipt facts: block number, block hash, status, sender, recipient and
 * value. A transaction both say does not exist is 404, one both see only in
 * their mempool is 422, and one included less than CONFIRMATIONS blocks ago
 * is 422 too, since its block can still be reorganised away.
 */
import {
  TransactionNotFoundError, TransactionReceiptNotFoundError, formatEther, getAddress, type PublicClient,
} from 'viem';
import type { RpcClient } from '../config/chains.js';
import { TruthError, twoAgree } from './agree.js';
import { CHAIN_LABEL, CONFIRMATIONS, CURRENT_CHAINS, chainId, parseChain, receiptArchives, type CurrentChain } from './endpoints.js';

export interface TxQuery {
  chain: CurrentChain;
  /** Lower-case 0x + 64 hex */
  hash: `0x${string}`;
}

export interface TxAnswer {
  chain: CurrentChain;
  chain_id: number;
  tx_hash: string;
  /**
   * In the intent's words: reverted when the receipt says so, confirmed
   * otherwise. Receipts from before Byzantium (Ethereum block 4,370,000)
   * carry no status; such a transaction is confirmed (it was included) and
   * receipt_status is null.
   */
  status: 'confirmed' | 'reverted';
  receipt_status: 'success' | 'reverted' | null;
  /** The block the transaction was included in (the intent's scored field) */
  block_number: number;
  block_hash: string;
  /** EIP-55 */
  from: string;
  /** EIP-55; null for a contract creation */
  to: string | null;
  /** The contract a creation deployed; null otherwise */
  contract_address: string | null;
  /** Native value sent, wei, decimal string */
  value_wei: string;
  /** The same in whole native units, exact decimal string */
  value_eth: string;
  agreed_by: [string, string];
}

export function parseTxQuery(raw: Record<string, unknown>): TxQuery {
  const hash = String(raw.tx_hash ?? raw.hash ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new TruthError(400, 'INVALID_TX_HASH', 'tx_hash must be 0x followed by 64 hexadecimal characters');
  const chainRaw = String(raw.chain ?? '').trim();
  if (!chainRaw) throw new TruthError(400, 'CHAIN_MISSING', `chain is required (${CURRENT_CHAINS.join(', ')})`);
  const chain = parseChain(chainRaw);
  if (!chain) throw new TruthError(400, 'CHAIN_UNSUPPORTED', `chain must be one of ${CURRENT_CHAINS.join(', ')} (or its chain id); got ${chainRaw}`);
  return { chain, hash: hash.toLowerCase() as `0x${string}` };
}

type Lookup =
  | { state: 'absent' }
  | { state: 'pending' }
  | {
    state: 'included';
    block_number: string;
    block_hash: string;
    status: 'success' | 'reverted' | null;
    from: string;
    to: string | null;
    contract_address: string | null;
    value_wei: string;
  };

/**
 * Ethereum's Byzantium fork. Receipts before it carry a state root, not a
 * status, so the protocol says nothing about success there. Endpoints differ:
 * eth.drpc.org reports status 1 for the first Ethereum transaction (block
 * 46147, the node's own question), rpc.mevblocker.io reports none (both
 * 2026-11-21). The status is not the scored field, so before this block it is
 * read as null on both sides instead of making them disagree.
 */
const BYZANTIUM_BLOCK = 4_370_000n;

/** One endpoint's view of the transaction. Throws when the endpoint did not answer. */
async function lookup(chain: CurrentChain, client: PublicClient, hash: `0x${string}`): Promise<Lookup> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (err) {
    if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
    try {
      const tx = await client.getTransaction({ hash });
      if (tx.blockNumber === null) return { state: 'pending' };
      // a mined transaction whose receipt the endpoint does not return: it is not answering
      throw new Error(`returned the transaction in block ${tx.blockNumber} but no receipt`);
    } catch (inner) {
      if (inner instanceof TransactionNotFoundError) return { state: 'absent' };
      throw inner;
    }
  }
  // The value is not on the receipt; it is read from the transaction, which must sit in the same block.
  const tx = await client.getTransaction({ hash });
  if (tx.blockHash !== receipt.blockHash) throw new Error('returned the receipt and the transaction from different blocks');
  return {
    state: 'included',
    block_number: receipt.blockNumber.toString(),
    block_hash: receipt.blockHash,
    status: chain === 'ethereum' && receipt.blockNumber < BYZANTIUM_BLOCK ? null : (receipt.status ?? null),
    from: getAddress(receipt.from),
    to: receipt.to ? getAddress(receipt.to) : null,
    contract_address: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
    value_wei: tx.value.toString(),
  };
}

async function tip(endpoints: RpcClient[]): Promise<bigint | null> {
  for (const { client } of endpoints) {
    try {
      return await client.getBlockNumber();
    } catch {
      // next endpoint
    }
  }
  return null;
}

const cache = new Map<string, TxAnswer>();
const CACHE_MAX = 20_000;
/** A transaction this deep is cached: final on every chain served. */
const FINALITY_DEPTH = 1_000n;

export async function txBlock(q: TxQuery, endpoints: RpcClient[] = receiptArchives(q.chain)): Promise<TxAnswer> {
  const key = `${q.chain}:${q.hash}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const archives = endpoints.filter((e) => e.fullHistory);
  if (archives.length < 2) throw new TruthError(503, 'NOT_ENOUGH_SOURCES', `${q.chain} has fewer than two receipt archives configured`);

  const { value: r, agreed_by } = await twoAgree(archives, ({ client }) => lookup(q.chain, client, q.hash), {
    key: (v) => JSON.stringify(v),
    show: (v) => (v.state === 'included' ? `block ${v.block_number} (${v.block_hash.slice(0, 12)}…), ${v.status}` : v.state),
    what: 'receipt-archive reads',
  });
  const label = CHAIN_LABEL[q.chain];
  if (r.state === 'absent') {
    throw new TruthError(404, 'TX_NOT_FOUND', `two ${label} receipt archives (${agreed_by.join(', ')}) have no transaction ${q.hash}`);
  }
  if (r.state === 'pending') throw new TruthError(422, 'TX_PENDING', `${q.hash} is not yet included in a ${label} block`);

  const head = await tip(archives);
  if (head === null) throw new TruthError(503, 'NO_SOURCE', `no ${label} endpoint reported the chain tip`);
  const depth = head - BigInt(r.block_number);
  if (depth < CONFIRMATIONS[q.chain]) {
    throw new TruthError(422, 'TX_NOT_CONFIRMED', `${q.hash} is in block ${r.block_number}, ${depth} below the ${label} tip; its block is given from ${CONFIRMATIONS[q.chain]} blocks deep`);
  }

  const answer: TxAnswer = {
    chain: q.chain,
    chain_id: chainId(q.chain),
    tx_hash: q.hash,
    status: r.status === 'reverted' ? 'reverted' : 'confirmed',
    receipt_status: r.status,
    block_number: Number(r.block_number),
    block_hash: r.block_hash,
    from: r.from,
    to: r.to,
    contract_address: r.contract_address,
    value_wei: r.value_wei,
    value_eth: formatEther(BigInt(r.value_wei)),
    agreed_by,
  };
  if (depth >= FINALITY_DEPTH) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, answer);
  }
  return answer;
}
