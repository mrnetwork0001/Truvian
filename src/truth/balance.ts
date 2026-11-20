/**
 * Native balance and nonce of an address at a block, agreed by two
 * independent archive endpoints.
 *
 * This backs a Telegraph truth source for ONCHAIN_METRIC_VERIFY_GENERAL: the
 * reference miners are scored against. A wrong reference makes correct miners
 * look wrong, so a value is only returned when two full-history endpoints run
 * by different providers return exactly the same number. Anything less is an
 * error, which the node treats as "this source gave no value" and leaves out
 * of the median. Never a guess.
 *
 * Decimal strings throughout: wei values exceed 2^53.
 */
import { createPublicClient, formatUnits, getAddress, http, isAddress, type PublicClient } from 'viem';
import { arbitrum, mainnet, polygon } from 'viem/chains';
import { chainMeta, type RpcClient, type SupportedChain } from '../config/chains.js';

/** The chains ONCHAIN_METRIC_VERIFY_GENERAL accepts (its `chain` enum), plus their ids. */
export const TRUTH_CHAINS = ['ethereum', 'polygon', 'arbitrum'] as const;
export type TruthChain = (typeof TRUTH_CHAINS)[number];
const CHAIN_BY_ID: Record<string, TruthChain> = { '1': 'ethereum', '137': 'polygon', '42161': 'arbitrum' };

/**
 * Endpoints that serve account STATE at old blocks (eth_getBalance and
 * eth_getTransactionCount with a historical block), which is a different
 * capability from the transaction history the miner's registry marks as
 * `fullHistory`. arb1.arbitrum.io and arbitrum.drpc.org, both full history
 * for transactions, refuse state older than about an hour ("missing trie
 * node", "Unknown state").
 *
 * Each URL below returned the balance of one address at blocks about 1 hour,
 * 2 days, 60 days and 1 year old on 2026-11-20, except api.zan.top, which
 * stops short of a year and is the Arbitrum fallback. Two endpoints run by
 * different providers must agree, so a chain needs at least two.
 */
const STATE_ARCHIVES: Record<TruthChain, string[]> = {
  ethereum: ['https://eth.drpc.org', 'https://rpc.mevblocker.io'],
  polygon: ['https://polygon.drpc.org', 'https://rpc-mainnet.matic.quiknode.pro'],
  arbitrum: ['https://arb-pokt.nodies.app', 'https://arbitrum-one.public.blastapi.io', 'https://api.zan.top/arb-one'],
};
const VIEM_CHAIN = { ethereum: mainnet, polygon, arbitrum } as const;

const archiveClients = new Map<TruthChain, RpcClient[]>();

/** The state-archive endpoints of a chain, one client per endpoint (no failover inside a client). */
export function stateArchives(chain: TruthChain): RpcClient[] {
  let list = archiveClients.get(chain);
  if (!list) {
    list = STATE_ARCHIVES[chain].map((url) => ({
      url,
      fullHistory: true,
      client: createPublicClient({ chain: VIEM_CHAIN[chain], transport: http(url, { timeout: 8_000, retryCount: 0 }) }) as unknown as PublicClient,
    }));
    archiveClients.set(chain, list);
  }
  return list;
}

/**
 * Blocks this far below the tip are treated as final for caching. Ethereum
 * finalises in about 64 blocks; Polygon and Arbitrum blocks are faster, so
 * the same count is a shorter (and still safe) stretch of time there.
 */
const FINALITY_DEPTH = 128n;

export class TruthError extends Error {
  constructor(
    /** HTTP status: 400 bad request, 422 unanswerable, 502 sources disagree, 503 not enough sources */
    public readonly status: 400 | 422 | 502 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TruthError';
  }
}

export interface BalanceQuery {
  chain: TruthChain;
  address: `0x${string}`;
  block: bigint;
}

export interface BalanceAnswer {
  chain: TruthChain;
  chain_id: number;
  /** EIP-55 */
  address: string;
  /** Decimal string */
  block: string;
  /** Native balance at the end of `block`, wei, decimal string */
  balance_wei: string;
  /** The same in gwei, exact decimal string (Telegraph's field unit) */
  balance_gwei: string;
  /** Transactions the address had sent by the end of `block` (its nonce) */
  tx_count: number;
  /** The two endpoints that agreed, by host */
  agreed_by: [string, string];
}

/** Validate raw query parameters. Throws TruthError(400). */
export function parseBalanceQuery(raw: Record<string, unknown>): BalanceQuery {
  const chainRaw = String(raw.chain ?? 'ethereum').trim().toLowerCase().replace(/^eip155:/, '');
  const chain = (TRUTH_CHAINS as readonly string[]).includes(chainRaw) ? (chainRaw as TruthChain) : CHAIN_BY_ID[chainRaw];
  if (!chain) {
    throw new TruthError(400, 'CHAIN_UNSUPPORTED', `chain must be one of ${TRUTH_CHAINS.join(', ')} (or 1, 137, 42161); got ${String(raw.chain)}`);
  }
  const address = String(raw.address ?? '').trim();
  if (!isAddress(address, { strict: false })) {
    throw new TruthError(400, 'INVALID_ADDRESS', 'address must be 0x followed by 40 hexadecimal characters');
  }
  const blockRaw = String(raw.block ?? raw.blockno ?? '').trim();
  if (!/^\d{1,15}$/.test(blockRaw)) {
    throw new TruthError(400, 'INVALID_BLOCK', 'block must be a decimal block number');
  }
  return { chain, address: getAddress(address), block: BigInt(blockRaw) };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Reading {
  endpoint: string;
  balance: bigint;
  nonce: number;
}

async function read(endpoint: RpcClient, q: BalanceQuery): Promise<Reading> {
  const [balance, nonce] = await Promise.all([
    endpoint.client.getBalance({ address: q.address, blockNumber: q.block }),
    endpoint.client.getTransactionCount({ address: q.address, blockNumber: q.block }),
  ]);
  return { endpoint: endpoint.url, balance, nonce };
}

/** The chain tip from the first endpoint that answers; null if none does. */
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

const cache = new Map<string, BalanceAnswer>();
const CACHE_MAX = 20_000;

/**
 * Balance and nonce at a block, from the first two state-archive endpoints
 * that answer, accepted only if they agree exactly.
 */
export async function balanceAt(q: BalanceQuery, endpoints: RpcClient[] = stateArchives(q.chain)): Promise<BalanceAnswer> {
  const key = `${q.chain}:${q.address.toLowerCase()}:${q.block}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const archives = endpoints.filter((e) => e.fullHistory);
  if (archives.length < 2) throw new TruthError(503, 'NOT_ENOUGH_SOURCES', `${q.chain} has fewer than two full-history endpoints configured`);

  const head = await tip(archives);
  if (head === null) throw new TruthError(503, 'NO_SOURCE', `no ${q.chain} endpoint reported the chain tip`);
  if (q.block > head) {
    throw new TruthError(422, 'BLOCK_IN_FUTURE', `block ${q.block} is beyond the ${q.chain} tip (${head}); a balance there does not exist yet`);
  }

  const readings: Reading[] = [];
  const failures: string[] = [];
  for (const endpoint of archives) {
    if (readings.length === 2) break;
    try {
      readings.push(await read(endpoint, q));
    } catch (err: any) {
      failures.push(`${host(endpoint.url)}: ${(err?.shortMessage ?? err?.message ?? String(err)).slice(0, 80)}`);
    }
  }
  if (readings.length < 2) {
    throw new TruthError(503, 'NOT_ENOUGH_SOURCES', `need two agreeing archive reads, got ${readings.length} (${failures.join('; ')})`);
  }
  const [a, b] = readings as [Reading, Reading];
  if (a.balance !== b.balance || a.nonce !== b.nonce) {
    throw new TruthError(502, 'SOURCES_DISAGREE',
      `${host(a.endpoint)} says ${a.balance} wei / nonce ${a.nonce}, ${host(b.endpoint)} says ${b.balance} wei / nonce ${b.nonce}`);
  }

  const answer: BalanceAnswer = {
    chain: q.chain,
    chain_id: chainMeta(q.chain as SupportedChain).chainId,
    address: q.address,
    block: q.block.toString(),
    balance_wei: a.balance.toString(),
    balance_gwei: formatUnits(a.balance, 9),
    tx_count: a.nonce,
    agreed_by: [host(a.endpoint), host(b.endpoint)],
  };
  // Only final blocks are cached: a recent block can still be reorganised away.
  if (head - q.block >= FINALITY_DEPTH) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, answer);
  }
  return answer;
}
