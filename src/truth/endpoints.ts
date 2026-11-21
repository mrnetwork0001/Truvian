/**
 * Chains and endpoints for the truth answers about current state (total
 * supply, wallet balance) and about transactions (the block a transaction was
 * included in).
 *
 * Kept apart from the miner's registry (src/config/chains.ts) on purpose: the
 * truth API is the reference miners are scored against, Truvian's miner
 * among them, so it must not share the miner's endpoint choices or failover.
 *
 * Every URL below is a public endpoint that answers without a key. Each was
 * probed on 2026-11-21 with eth_getBlockByNumber, eth_call totalSupply() and
 * eth_getBalance twelve blocks below the tip, and with
 * eth_getTransactionReceipt for transactions about 2 days, 60 days, 1 year and
 * 3 years old. Two endpoints must agree, and they must be run by different
 * providers (src/truth/agree.ts), so each chain lists at least two providers.
 *
 * What the probe ruled out:
 *  - 1rpc.io answers every call with "usage limit for your current plan";
 *    eth.llamarpc.com answers HTTP 525; blockpi.network wants a key;
 *    polygon-rpc.com answers no JSON-RPC result; polygon-pokt.nodies.app and
 *    polygon-bor-rpc.publicnode.com need a paid plan or time out;
 *    base.meowrpc.com and eth.merkle.io rate-limit after one call;
 *    api.zan.top refuses eth_call without an account; rpc.flashbots.net
 *    refuses eth_call; cloudflare-eth.com fails state reads; Blast API
 *    (blastapi.io) answers "no longer available" on OP Mainnet and Polygon
 *    (it still served Arbitrum); ankr.com wants a key; onfinality.io
 *    rate-limits keyless calls; tenderly.co timed out.
 *  - thirdweb.com (<chain id>.rpc.thirdweb.com) served every probe on all
 *    five chains but takes about 2 s a call, so it is a late fallback. OP
 *    Mainnet has only two other receipt archives, and a burst of test reads
 *    rate-limited optimism.drpc.org.
 *  - publicnode.com serves current state but refuses receipts older than a
 *    few days ("Archive requests require a paid plan") on Base, Arbitrum and
 *    OP Mainnet, so it is a state endpoint only, and last.
 *  - arbitrum.drpc.org and op-pokt.nodies.app answer null for a receipt
 *    three years (Arbitrum) or one year (OP Mainnet) old, the answer they
 *    would give for a transaction that never existed, so they are not
 *    receipt archives.
 */
import { createPublicClient, http, type Chain, type PublicClient } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import type { RpcClient } from '../config/chains.js';

export const CURRENT_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'] as const;
export type CurrentChain = (typeof CURRENT_CHAINS)[number];

const VIEM_CHAIN: Record<CurrentChain, Chain> = { ethereum: mainnet, base, arbitrum, optimism, polygon };

/** Display names, as the node writes them ("on Ethereum", "on Arbitrum One"). */
export const CHAIN_LABEL: Record<CurrentChain, string> = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum One', optimism: 'OP Mainnet', polygon: 'Polygon PoS',
};

/** Endpoints that serve current state (a recent block's eth_call and eth_getBalance), in the order tried. */
const STATE: Record<CurrentChain, string[]> = {
  ethereum: ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth-pokt.nodies.app', 'https://1.rpc.thirdweb.com', 'https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base-pokt.nodies.app', 'https://8453.rpc.thirdweb.com', 'https://base-rpc.publicnode.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arb-pokt.nodies.app', 'https://arbitrum-one.public.blastapi.io', 'https://42161.rpc.thirdweb.com', 'https://arbitrum.drpc.org', 'https://arbitrum-one-rpc.publicnode.com'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism.drpc.org', 'https://10.rpc.thirdweb.com', 'https://op-pokt.nodies.app', 'https://optimism-rpc.publicnode.com'],
  polygon: ['https://polygon.drpc.org', 'https://rpc-mainnet.matic.quiknode.pro', 'https://137.rpc.thirdweb.com'],
};

/**
 * Endpoints that returned the receipt of every probed transaction, up to three
 * years old. Only these may say a transaction does not exist: a pruned node
 * answers null for an old transaction exactly as for one that never existed.
 */
const RECEIPTS: Record<CurrentChain, string[]> = {
  ethereum: ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth-pokt.nodies.app', 'https://1.rpc.thirdweb.com'],
  base: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base-pokt.nodies.app', 'https://8453.rpc.thirdweb.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arb-pokt.nodies.app', 'https://arbitrum-one.public.blastapi.io', 'https://42161.rpc.thirdweb.com'],
  optimism: ['https://mainnet.optimism.io', 'https://optimism.drpc.org', 'https://10.rpc.thirdweb.com'],
  polygon: ['https://polygon.drpc.org', 'https://rpc-mainnet.matic.quiknode.pro', 'https://137.rpc.thirdweb.com'],
};

/**
 * Blocks below the tip a current-state answer is read at, and the depth a
 * transaction's block must have before its block number is given: about a
 * minute on every chain (Ethereum 12 s blocks, Base, OP Mainnet and Polygon
 * 2 s, Arbitrum 0.25 s). Both endpoints must also report the same block hash
 * at that height, so a block one of them has reorganised away is never used.
 */
export const CONFIRMATIONS: Record<CurrentChain, bigint> = {
  ethereum: 5n, base: 30n, arbitrum: 240n, optimism: 30n, polygon: 30n,
};

const clients = new Map<string, RpcClient[]>();

function build(chain: CurrentChain, urls: string[], fullHistory: boolean): RpcClient[] {
  return urls.map((url) => ({
    url,
    fullHistory,
    client: createPublicClient({ chain: VIEM_CHAIN[chain], transport: http(url, { timeout: 8_000, retryCount: 0 }) }) as unknown as PublicClient,
  }));
}

/** The current-state endpoints of a chain, one client per endpoint (no failover inside a client). */
export function stateEndpoints(chain: CurrentChain): RpcClient[] {
  const key = `state:${chain}`;
  let list = clients.get(key);
  if (!list) clients.set(key, (list = build(chain, STATE[chain], false)));
  return list;
}

/** The receipt-archive endpoints of a chain. */
export function receiptArchives(chain: CurrentChain): RpcClient[] {
  const key = `receipts:${chain}`;
  let list = clients.get(key);
  if (!list) clients.set(key, (list = build(chain, RECEIPTS[chain], true)));
  return list;
}

export function chainId(chain: CurrentChain): number {
  return VIEM_CHAIN[chain].id;
}

/** The chain's own coin: ETH, or POL on Polygon (MATIC before it was renamed). */
export function nativeSymbols(chain: CurrentChain): string[] {
  const own = VIEM_CHAIN[chain].nativeCurrency.symbol.toUpperCase();
  return chain === 'polygon' ? [own, 'MATIC'] : [own];
}

const ALIASES: Record<string, CurrentChain> = {
  ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum', 'ethereum-mainnet': 'ethereum', '1': 'ethereum',
  base: 'base', 'base-mainnet': 'base', '8453': 'base',
  arbitrum: 'arbitrum', 'arbitrum-one': 'arbitrum', 'arbitrum-mainnet': 'arbitrum', '42161': 'arbitrum',
  optimism: 'optimism', 'op-mainnet': 'optimism', 'optimism-mainnet': 'optimism', '10': 'optimism',
  polygon: 'polygon', 'polygon-pos': 'polygon', 'polygon-mainnet': 'polygon', '137': 'polygon',
};

/**
 * A chain given as a parameter or as the words after "on": its name, a
 * common alias, its EIP-155 id or CAIP-2 form. Case, spaces and the words
 * "mainnet", "network" and "chain" after a name do not matter ("Base
 * Mainnet", "Ethereum network"). Anything else is null: the caller refuses
 * it rather than read another chain.
 */
export function parseChain(raw: unknown): CurrentChain | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^eip155:/, '').replace(/[\s_]+/g, '-');
  if (Object.hasOwn(ALIASES, s)) return ALIASES[s]!;
  const stripped = s.replace(/-(main-?net|network|chain)$/, '');
  return Object.hasOwn(ALIASES, stripped) ? ALIASES[stripped]! : null;
}
