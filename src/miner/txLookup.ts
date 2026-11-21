/**
 * ONCHAIN_TX_LOOKUP intent handler.
 * Pure (input) -> payload against live RPC. The payload carries the fields of
 * Telegraph's V2 response format by name; telegraph/truvian-miner.yaml maps them.
 *
 * One lookup, two views of it:
 *  - the default reply is what the node stores and scores. Its judge model
 *    reads the stored body with keys sorted and only its first 512 tokens,
 *    so the default holds the intent's six fields, one direct sentence, a
 *    verdict and where the facts were read, and nothing bulky.
 *  - ?detail=full adds every raw field: calldata, decoded ERC-20 transfers,
 *    and the exact fee figures, including the L1 data fee on rollups.
 */
import { formatEther, getAddress, isHex } from 'viem';
import {
  PUBLIC_RPC_TERMS,
  SUPPORTED_CHAINS,
  chainMeta,
  getRpcClients,
  isSupportedChain,
  type RpcClient,
  type SupportedChain,
} from '../config/chains.js';
import {
  IntentError,
  type DecodedTransfer,
  type ExecutionStatus,
  type RpcMethod,
  type RpcRead,
  type TxDetail,
  type TxFullReply,
  type TxLookupInput,
  type TxMinedReply,
  type TxNotFoundReply,
  type TxPendingReply,
  type TxProvenance,
  type TxReply,
} from '../types/index.js';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicToAddress(topic: `0x${string}`): string {
  return getAddress(`0x${topic.slice(26)}`);
}

/**
 * Names and EIP-155 ids callers use for each chain. Keys are in the form
 * normalizeChain produces: lower case, words joined by hyphens.
 *
 * `sepolia` means Ethereum Sepolia (it meant Base Sepolia in Season I, when
 * that was Telegraph's home chain; V2 moved to Ethereum Sepolia).
 */
const CHAIN_ALIASES: Record<string, SupportedChain> = {
  '1': 'ethereum', eth: 'ethereum', mainnet: 'ethereum', 'ethereum-mainnet': 'ethereum', 'eth-mainnet': 'ethereum',
  '8453': 'base', 'base-mainnet': 'base',
  '42161': 'arbitrum', arb: 'arbitrum', 'arbitrum-one': 'arbitrum', 'arbitrum-mainnet': 'arbitrum',
  '10': 'optimism', op: 'optimism', 'op-mainnet': 'optimism', 'optimism-mainnet': 'optimism',
  '137': 'polygon', matic: 'polygon', 'polygon-pos': 'polygon', 'polygon-mainnet': 'polygon',
  '56': 'bsc', bnb: 'bsc', binance: 'bsc', 'bnb-chain': 'bsc', 'bnb-smart-chain': 'bsc',
  'binance-smart-chain': 'bsc', 'bsc-mainnet': 'bsc',
  '43114': 'avalanche', avax: 'avalanche', 'avalanche-c-chain': 'avalanche', 'avalanche-c': 'avalanche',
  '534352': 'scroll', 'scroll-mainnet': 'scroll',
  '59144': 'linea', 'linea-mainnet': 'linea',
  '100': 'gnosis', xdai: 'gnosis', 'gnosis-chain': 'gnosis', 'gnosis-mainnet': 'gnosis',
  '324': 'zksync', 'zksync-era': 'zksync', 'zksync-mainnet': 'zksync', 'zksync-era-mainnet': 'zksync', 'zk-sync': 'zksync',
  era: 'zksync',
  '11155111': 'sepolia', 'ethereum-sepolia': 'sepolia', 'eth-sepolia': 'sepolia',
  '84532': 'base-sepolia', basesepolia: 'base-sepolia',
  '196': 'xlayer', 'x-layer': 'xlayer', okx: 'xlayer', 'xlayer-mainnet': 'xlayer',
};

/**
 * Canonical chain name for a caller-supplied value, or the cleaned input
 * when nothing matches (the caller then rejects it by name). Accepts names,
 * aliases, EIP-155 ids and CAIP-2 strings ("eip155:8453").
 */
export function normalizeChain(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^eip155:/, '').replace(/[\s_]+/g, '-');
  return CHAIN_ALIASES[s] ?? s;
}

/**
 * Chains searched, in priority order, when the caller names none: Base first
 * (Truvian's data focus), then Ethereum and the other mainnets, then testnets.
 */
export const SEARCH_CHAINS: SupportedChain[] = [
  'base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche',
  'scroll', 'linea', 'gnosis', 'zksync', 'sepolia', 'base-sepolia', 'xlayer',
];

/** Detect a chain named in free text; null when nothing matches. */
export function chainFromText(text: string): SupportedChain | null {
  const q = text.toLowerCase();
  // most specific first: "base sepolia" before "sepolia" before "base"
  if (/\bbase[\s-]?sepolia\b/.test(q)) return 'base-sepolia';
  if (/\bsepolia\b/.test(q)) return 'sepolia';
  if (/\bx[\s-]?layer\b|\bokx\b/.test(q)) return 'xlayer';
  if (/\barbitrum\b/.test(q)) return 'arbitrum';
  if (/\boptimism\b|\bop[\s-]mainnet\b/.test(q)) return 'optimism';
  if (/\bpolygon\b|\bmatic\b/.test(q)) return 'polygon';
  if (/\bbnb\b|\bbsc\b|\bbinance\b/.test(q)) return 'bsc';
  if (/\bavalanche\b|\bavax\b/.test(q)) return 'avalanche';
  if (/\bscroll\b/.test(q)) return 'scroll';
  if (/\blinea\b/.test(q)) return 'linea';
  if (/\bgnosis\b|\bxdai\b/.test(q)) return 'gnosis';
  if (/\bzk[\s-]?sync\b/.test(q)) return 'zksync';
  if (/\bethereum\b|\bmainnet\b|\beth\b|\bl1\b/.test(q)) return 'ethereum';
  if (/\bbase\b/.test(q)) return 'base';
  return null;
}

/** Resolve an explicit chain parameter, rejecting names this miner does not serve. */
export function requireChain(raw: unknown): SupportedChain {
  const normalized = normalizeChain(raw);
  if (!isSupportedChain(normalized)) {
    throw new IntentError('CHAIN_UNSUPPORTED', `chain must be one of ${SUPPORTED_CHAINS.join(', ')}; got ${String(raw)}`);
  }
  return normalized;
}

export function validateTxLookupInput(raw: unknown): TxLookupInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new IntentError('INVALID_INPUT', 'input must be an object');
  }
  const body = raw as Record<string, unknown>;
  // accept the aliases seen in live Telegraph traffic: hash / tx_hash / txHash
  const hashRaw = body.txHash ?? body.tx_hash ?? body.hash;
  const query = typeof body.query === 'string' ? body.query : '';

  // Chain resolution. An explicit param wins; otherwise look for a chain named
  // in the natural-language query; otherwise null => search every chain.
  // Never silently pin to Base: a bare hash from another chain used to 404,
  // which returns no `answer` text and scores exactly 0 (every miner that
  // auto-detects scores above zero; every miner that does not scores zero).
  const chainRaw = body.chain ?? body.network;
  let chain: SupportedChain | null = null;
  if (chainRaw !== undefined && chainRaw !== null && String(chainRaw).trim() !== '') {
    chain = requireChain(chainRaw);
  } else if (query) {
    chain = chainFromText(query);
  }

  // a natural-language query may carry the hash inline - extract it
  let txHash = typeof hashRaw === 'string' ? hashRaw.trim() : '';
  if (!txHash && query) {
    txHash = query.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? '';
  }
  if (!isHex(txHash) || txHash.length !== 66) {
    throw new IntentError('INVALID_INPUT', 'txHash must be a 32-byte 0x-hex string (params: txHash | tx_hash | hash, or a query containing one)');
  }

  // ?detail=full asks for the raw fields as well; anything else is a typo
  // the caller should hear about rather than a silent default.
  const detailRaw = body.detail === undefined || body.detail === null ? '' : String(body.detail).trim().toLowerCase();
  if (detailRaw !== '' && detailRaw !== 'full') {
    throw new IntentError('INVALID_INPUT', `detail must be "full" or left out; got ${String(body.detail)}`);
  }
  const detail: TxDetail = detailRaw === 'full' ? 'full' : 'default';
  return { chain, txHash: txHash.toLowerCase() as `0x${string}`, detail };
}

/**
 * Resolve a transaction. When the caller named a chain we query only that
 * chain; otherwise we search every supported chain concurrently and return
 * the first hit in SEARCH_CHAINS priority order.
 *
 * Searching concurrently keeps latency at roughly one RPC round-trip instead
 * of summing one per chain, which matters because validators score on a deadline.
 *
 * A hash no chain has is an answer (`status: not_found`), not an error; an
 * endpoint failure that leaves a chain unsearched is an error, because
 * absence is only proven by every chain answering.
 */
export async function handleTxLookup(input: TxLookupInput): Promise<TxReply | TxFullReply> {
  const readAt = new Date().toISOString();
  if (input.chain) return replyFor(await lookupOnChain(input.chain, input.txHash), input, readAt);

  // Fire every chain at once, then await in priority order so a Base hit
  // returns without waiting on the slower chains it raced.
  const inFlight = SEARCH_CHAINS.map((c) =>
    lookupOnChain(c, input.txHash).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  const absent: RpcRead[] = [];
  const failures: unknown[] = [];
  for (const pending of inFlight) {
    const outcome = await pending;
    if (!outcome.ok) { failures.push(outcome.error); continue; }
    if (outcome.value.kind !== 'absent') return replyFor(outcome.value, input, readAt);
    absent.push(...outcome.value.reads);
  }
  // Surface a real upstream failure rather than reporting "not found" when
  // a chain could not be searched.
  if (failures.length > 0) throw failures[0];
  return notFoundReply(input, absent, readAt, SEARCH_CHAINS);
}

function isNotFound(err: any): boolean {
  return err?.name === 'TransactionReceiptNotFoundError' || err?.name === 'TransactionNotFoundError';
}

/** What a chain's endpoints, asked in order, had to say about one record. */
export type RpcSearch<T> =
  /** `answeredBy`: the endpoint whose answer is the record. */
  | { found: T; answeredBy: string[] }
  /**
   * `provenAbsent`: a full-history endpoint answered that the record does not
   * exist and no endpoint contradicted it; `answeredBy` lists the endpoints
   * whose "not found" answers prove it. False means no endpoint able to
   * prove absence answered (they errored, or only pruned endpoints replied):
   * `answeredBy` is empty and `error` is the last failure.
   */
  | { found: null; provenAbsent: boolean; error: unknown; answeredBy: string[] };

/**
 * Ask each endpoint in turn for a record and return the first one found.
 *
 * "Not found" is weak evidence. A pruned node answers that way about a
 * year-old transaction, and any node, full history or not, answers that way
 * about a transaction newer than the block it has synced to. So:
 * - a record found anywhere is found, whatever the others said
 * - a not-found from a pruned endpoint alone proves nothing
 * - a not-found from a full-history endpoint is confirmed by the next
 *   endpoint that answers: when two endpoints agree and one keeps full
 *   history, the record is absent
 * - if no other endpoint answers, the single full-history answer stands,
 *   so one failing endpoint does not turn every "not found" into an error
 * - an error is remembered and moves on
 */
export async function searchRpcs<T>(
  endpoints: Pick<RpcClient, 'url' | 'fullHistory' | 'client'>[],
  read: (client: RpcClient['client']) => Promise<T>,
): Promise<RpcSearch<T>> {
  let error: unknown = null;
  const saidAbsent: string[] = [];
  let fullHistorySaidAbsent = false;
  for (const { url, client, fullHistory } of endpoints) {
    try {
      return { found: await read(client), answeredBy: [url] };
    } catch (err) {
      if (!isNotFound(err)) { error = err; continue; }
      saidAbsent.push(url);
      if (fullHistory) fullHistorySaidAbsent = true;
      if (fullHistorySaidAbsent && saidAbsent.length >= 2) {
        return { found: null, provenAbsent: true, error: null, answeredBy: saidAbsent };
      }
    }
  }
  if (fullHistorySaidAbsent) return { found: null, provenAbsent: true, error: null, answeredBy: saidAbsent };
  return { found: null, provenAbsent: false, error, answeredBy: [] };
}

/**
 * The chain tip and the endpoint that gave it, from the first endpoint that
 * answers; null when none does. It is only used for the informational
 * `confirmations` count, so an unreadable tip is reported as an unknown
 * count, not as a failed lookup.
 */
async function chainTip(endpoints: Pick<RpcClient, 'url' | 'client'>[]): Promise<{ number: bigint; url: string } | null> {
  for (const { url, client } of endpoints) {
    try {
      return { number: await client.getBlockNumber(), url };
    } catch {
      // this endpoint could not answer; the next one is asked
    }
  }
  return null;
}

function upstream(what: string, err?: any): IntentError {
  const detail = err?.shortMessage ?? err?.message;
  return new IntentError('UPSTREAM_RPC_ERROR', detail ? `${what}: ${detail}` : what);
}

type RpcTx = Awaited<ReturnType<RpcClient['client']['getTransaction']>>;
type RpcReceipt = Awaited<ReturnType<RpcClient['client']['getTransactionReceipt']>>;

/**
 * What one chain's endpoints established about a hash. `reads` are the
 * answers the outcome rests on; the chain tip, which only feeds the
 * confirmations count of ?detail=full, is kept apart as `tipRead`.
 */
type ChainLookup =
  | { kind: 'mined'; chain: SupportedChain; tx: RpcTx; receipt: RpcReceipt; tip: bigint | null; reads: RpcRead[]; tipRead: RpcRead | null }
  | { kind: 'pending'; chain: SupportedChain; tx: RpcTx; reads: RpcRead[] }
  | { kind: 'absent'; chain: SupportedChain; reads: RpcRead[] };

/** Hostname of an endpoint URL, the form provenance names it by. */
function hostOf(url: string): string {
  return new URL(url).host;
}

async function lookupOnChain(chain: SupportedChain, txHash: `0x${string}`): Promise<ChainLookup> {
  const endpoints = getRpcClients(chain);

  // The transaction and its receipt are separate records and are searched
  // separately: an endpoint can hold one and have pruned the other.
  const [txSearch, receiptSearch, tip] = await Promise.all([
    searchRpcs(endpoints, (c) => c.getTransaction({ hash: txHash })),
    searchRpcs(endpoints, (c) => c.getTransactionReceipt({ hash: txHash })),
    // Through the same short-timeout endpoints as the searches. The shared
    // fallback client used to be asked here, and one throttled endpoint
    // behind it stalled whole lookups for up to a minute.
    chainTip(endpoints),
  ]);
  const reads = (method: RpcMethod, urls: string[]): RpcRead[] => urls.map((url) => ({ chain, method, host: hostOf(url) }));
  const searched = [
    ...reads('eth_getTransactionByHash', txSearch.answeredBy),
    ...reads('eth_getTransactionReceipt', receiptSearch.answeredBy),
  ];

  if (!txSearch.found) {
    if (receiptSearch.found) {
      throw upstream(`${chain} returned a receipt for ${txHash} but no endpoint returned the transaction itself`);
    }
    if (txSearch.provenAbsent) return { kind: 'absent', chain, reads: searched };
    // No endpoint that could prove absence answered, so absence is not claimed.
    throw upstream(`${chain} lookup of ${txHash} could not be completed`, txSearch.error);
  }
  const tx = txSearch.found;

  if (!receiptSearch.found) {
    // Pending means the node itself says the transaction is in no block. A
    // transaction that has a block but whose receipt no endpoint returned is
    // mined; its outcome is unknown to us, and that is an upstream failure,
    // not a pending transaction.
    if (tx.blockNumber !== null) {
      throw upstream(
        `${chain} transaction ${txHash} is mined in block ${tx.blockNumber} but no endpoint returned its receipt`,
        receiptSearch.error,
      );
    }
    return { kind: 'pending', chain, tx, reads: searched };
  }
  return {
    kind: 'mined',
    chain,
    tx,
    receipt: receiptSearch.found,
    tip: tip?.number ?? null,
    reads: searched,
    tipRead: tip ? { chain, method: 'eth_blockNumber', host: hostOf(tip.url) } : null,
  };
}

/** Ethereum mainnet block at which Byzantium (EIP-658: a status code in every receipt) activated. */
const BYZANTIUM_BLOCK = 4_370_000n;

/**
 * A mined transaction's execution outcome, from its receipt.
 *
 * Ethereum receipts from before Byzantium hold a post-transaction state root
 * instead of a status code. Endpoints differ in how they show that: geth-style
 * nodes return `root` and no `status` (rpc.mevblocker.io, checked 2026-11-21),
 * which viem reads as a null status, while eth.drpc.org fills a status in
 * from its own re-execution. That status is not part of the receipt, and
 * taking it would make the answer depend on which endpoint replied, so for
 * those blocks no execution result is reported. A missing status on any
 * chain reads the same way; it never reads as a revert. Every other chain
 * served here started after Byzantium.
 */
export function executionOf(
  chain: SupportedChain,
  receipt: { status: RpcReceipt['status'] | null; blockNumber: bigint },
): ExecutionStatus {
  // viem types the status as always present; a receipt without one gives null
  const status = receipt.status as RpcReceipt['status'] | null;
  if (status === null || (chain === 'ethereum' && receipt.blockNumber < BYZANTIUM_BLOCK)) return 'not_recorded';
  return status === 'success' ? 'success' : 'reverted';
}

/** The order provenance lists methods in: the transaction, its receipt, the tip. */
const METHOD_ORDER: RpcMethod[] = ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber'];

/**
 * Provenance of a reply: the endpoints and methods whose answers it states,
 * so each view lists only what it shows (the default has no confirmations
 * count, so it leaves out the eth_blockNumber read behind it).
 */
function provenanceOf(
  reads: RpcRead[],
  readAt: string,
  detail: TxDetail,
  extra: { blockHash?: string; searched?: SupportedChain[] } = {},
): TxProvenance {
  const provenance: TxProvenance = {
    ...(extra.blockHash ? { block_hash: extra.blockHash } : {}),
    ...(extra.searched ? { chains_searched: extra.searched } : {}),
    hosts: [...new Set(reads.map((r) => r.host))],
    methods: METHOD_ORDER.filter((m) => reads.some((r) => r.method === m)),
    read_at: readAt,
    terms: PUBLIC_RPC_TERMS,
  };
  if (detail === 'full') provenance.reads = reads;
  return provenance;
}

/** The reply for one chain's outcome; a chain that has no such transaction answers not_found. */
function replyFor(found: ChainLookup, input: TxLookupInput, readAt: string): TxReply | TxFullReply {
  if (found.kind === 'mined') return minedReply(found, input, readAt);
  if (found.kind === 'pending') return pendingReply(found, input, readAt);
  return notFoundReply(input, found.reads, readAt, null);
}

/** Exact native value in whole coins: formatEther is exact. */
function valueText(wei: bigint, chain: SupportedChain): string {
  return `${formatEther(wei)} ${chainMeta(chain).nativeSymbol}`;
}

function minedReply(
  m: Extract<ChainLookup, { kind: 'mined' }>,
  input: TxLookupInput,
  readAt: string,
): TxMinedReply | TxFullReply {
  const { chain, tx, receipt } = m;
  const meta = chainMeta(chain);
  const hash = tx.hash.toLowerCase();
  const from = tx.from.toLowerCase();
  const to = receipt.to ? receipt.to.toLowerCase() : null;
  const created = receipt.contractAddress ? receipt.contractAddress.toLowerCase() : null;
  const execution = executionOf(chain, receipt);
  const value = `${valueText(tx.value, chain)} (${tx.value} wei)`;

  // Rollups that bill L1 data separately put it on the receipt as l1Fee: the
  // OP-stack chains and Scroll do, the others here do not (checked against
  // raw receipts 2026-11-19). Read it from the receipt rather than from a
  // per-chain flag, so the total is right wherever the field appears. viem's
  // types don't surface it on generic clients.
  const l1Fee = BigInt((receipt as any).l1Fee ?? 0);
  const totalFee = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;

  // The outcome first, then what moved, value exact in wei. Only a transaction
  // whose receipt says it succeeded is said to have transferred anything or
  // created a contract: a reverted one transferred nothing (only its fee was
  // paid), and one from before Byzantium has no recorded result to say so with.
  const head = `Transaction ${hash} on ${meta.label} (chain id ${meta.chainId})`;
  const sent = to
    ? `It was sent from ${from} to the recipient ${to} with a value of ${value}`
    : `It was sent from ${from} to create a contract, with a value of ${value}`;
  const answer =
    execution === 'success'
      ? `${head} succeeded in block ${receipt.blockNumber}. ${to
        ? `It transferred ${value} from ${from} to the recipient ${to}.`
        : `It was sent from ${from} and created contract ${created} with a value of ${value}.`}`
      : execution === 'reverted'
        ? `${head} reverted in block ${receipt.blockNumber} (receipt status 0). ${sent}, and its execution was rolled back.`
        : `${head} was confirmed in block ${receipt.blockNumber}. ${sent}. Its receipt predates Byzantium (block 4,370,000), so it records no execution result.`;

  const reply: TxMinedReply = {
    answer,
    tx_hash: hash,
    // The intent's vocabulary: a mined transaction is `confirmed` unless its
    // execution reverted.
    status: execution === 'reverted' ? 'reverted' : 'confirmed',
    from,
    to,
    // Block heights are far below 2^53, so the number is exact
    block_number: Number(receipt.blockNumber),
    // formatEther is exact; Number() of it is the nearest double, the same for the same value
    value_eth: Number(formatEther(tx.value)),
    chain,
    verdict: execution === 'success' ? 'succeeded' : execution === 'reverted' ? 'reverted' : 'no_execution_result',
    confidence: 0.99,
    checked_at: new Date().toISOString(),
    receipt: { execution_status: execution, gas_used: receipt.gasUsed.toString(), total_fee_wei: totalFee.toString() },
    provenance: provenanceOf(
      input.detail === 'full' && m.tipRead ? [...m.reads, m.tipRead] : m.reads,
      readAt,
      input.detail,
      { blockHash: receipt.blockHash.toLowerCase() },
    ),
  };
  if (input.detail !== 'full') return reply;

  const erc20Transfers: DecodedTransfer[] = [];
  for (const log of receipt.logs) {
    // ERC-20 Transfer: topic0 = signature, topics[1]=from, topics[2]=to, data=amount.
    // ERC-721 Transfer shares topic0 but carries tokenId as a 4th topic - excluded here.
    if (log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3 && log.topics[1] && log.topics[2]) {
      erc20Transfers.push({
        token: getAddress(log.address),
        from: topicToAddress(log.topics[1]),
        to: topicToAddress(log.topics[2]),
        amount: BigInt(log.data === '0x' ? 0 : log.data).toString(),
        logIndex: log.logIndex,
      });
    }
  }

  // The answer, with the function selector the calldata starts with
  const selector = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null;
  const signal = selector ? `${answer} The calldata starts with function selector ${selector}.` : answer;
  const createdChecksum = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;

  return {
    ...reply,
    signal,
    source: `${meta.label} JSON-RPC ${reply.provenance.methods.join(', ')} from ${reply.provenance.hosts.join(', ')}`,
    chainId: meta.chainId,
    txHash: hash,
    valueWei: tx.value.toString(),
    nonce: tx.nonce,
    inputData: tx.input,
    execution_status: execution,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash.toLowerCase(),
    transactionIndex: receipt.transactionIndex,
    contractAddress: createdChecksum,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    l1FeeWei: l1Fee.toString(),
    totalFeeWei: totalFee.toString(),
    logCount: receipt.logs.length,
    erc20Transfers,
    confirmations: m.tip === null ? null : (m.tip - receipt.blockNumber + 1n).toString(),
  };
}

function pendingReply(
  p: Extract<ChainLookup, { kind: 'pending' }>,
  input: TxLookupInput,
  readAt: string,
): TxPendingReply | TxFullReply {
  const { chain, tx } = p;
  const meta = chainMeta(chain);
  const hash = tx.hash.toLowerCase();
  const from = tx.from.toLowerCase();
  const to = tx.to ? tx.to.toLowerCase() : null;
  const value = `${valueText(tx.value, chain)} (${tx.value} wei)`;
  const head = `Transaction ${hash} on ${meta.label} (chain id ${meta.chainId}) is pending: it has been broadcast but is not yet in a block.`;
  const answer = to
    ? `${head} It was sent from ${from} to the recipient ${to} with a value of ${value}.`
    : `${head} It was sent from ${from} to create a contract, with a value of ${value}.`;
  const reply: TxPendingReply = {
    answer,
    tx_hash: hash,
    status: 'pending',
    from,
    to,
    block_number: null,
    value_eth: Number(formatEther(tx.value)),
    chain,
    verdict: 'pending',
    confidence: 0.9,
    checked_at: new Date().toISOString(),
    provenance: provenanceOf(p.reads, readAt, input.detail),
  };
  if (input.detail !== 'full') return reply;
  return {
    ...reply,
    signal: answer,
    source: `${meta.label} JSON-RPC ${reply.provenance.methods.join(', ')} from ${reply.provenance.hosts.join(', ')} (no receipt yet)`,
    chainId: meta.chainId,
    txHash: hash,
    valueWei: tx.value.toString(),
    nonce: tx.nonce,
    inputData: tx.input,
  };
}

/**
 * `searched`: the chains a lookup with no chain named went through; their
 * list is the scope of the absence, so it travels in the provenance.
 */
function notFoundReply(
  input: TxLookupInput,
  reads: RpcRead[],
  readAt: string,
  searched: SupportedChain[] | null,
): TxNotFoundReply | TxFullReply {
  const chain = searched ? null : input.chain;
  const answer = chain
    ? `Transaction ${input.txHash} was not found on ${chainMeta(chain).label}: the endpoints read hold no transaction or receipt with this hash, so it is in no ${chainMeta(chain).label} block.`
    : `Transaction ${input.txHash} was not found on any of the ${SEARCH_CHAINS.length} chains this miner serves: the endpoints read hold no transaction or receipt with this hash, so it is in no block on any of them.`;
  const reply: TxNotFoundReply = {
    answer,
    tx_hash: input.txHash,
    status: 'not_found',
    from: null,
    to: null,
    block_number: null,
    value_eth: null,
    chain,
    verdict: 'not_found',
    // Absence rests on endpoints agreeing that a record does not exist, which
    // is weaker evidence than a receipt that does.
    confidence: 0.95,
    checked_at: new Date().toISOString(),
    provenance: provenanceOf(reads, readAt, input.detail, searched ? { searched } : {}),
  };
  if (input.detail !== 'full') return reply;
  return {
    ...reply,
    signal: answer,
    source: `JSON-RPC ${reply.provenance.methods.join(', ')} from ${reply.provenance.hosts.join(', ')}`,
    chainId: chain ? chainMeta(chain).chainId : null,
    txHash: input.txHash,
  };
}
