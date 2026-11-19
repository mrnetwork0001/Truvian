import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import {
  arbitrum, avalanche, base, baseSepolia, bsc, gnosis, linea, mainnet, optimism, polygon, scroll, sepolia, xLayer, zksync,
} from 'viem/chains';

/**
 * Chain registry. Base is primary; the rest cover the chains Telegraph
 * Season II questions name (the intent's `chain` input is free text).
 *
 * Public RPCs differ in how much history they keep, and the ones that prune
 * do not say so: asked for an old transaction or receipt they answer `null`,
 * exactly as they would for one that never existed. Each endpoint is
 * therefore marked `fullHistory` only if it returned both the transaction
 * and the receipt for a one-year-old, a 60-day-old and a 2-day-old
 * transaction when probed on 2026-11-14. Only a full-history endpoint can
 * prove a transaction absent; see searchRpcs in src/miner/txLookup.ts.
 *
 * The flag is a snapshot, not a guarantee. Five days after the first probe
 * two Sepolia endpoints marked full had stopped being so. `npm run
 * test:miner` looks up year-old transactions on every chain and is the way
 * to notice; re-run it before relying on this table.
 *
 * Probe results worth remembering (2026-11-14):
 *  - publicnode.com prunes on every chain and is inconsistent between calls
 *    (it is load balanced): Ethereum returned no receipt at one year and,
 *    once, at two days; Avalanche returned null for transactions that exist;
 *    Arbitrum, OP Mainnet and BNB Chain refuse receipts as "archive requests".
 *    It is kept only where it serves recent data, never as full history.
 *  - eth.merkle.io and bsc.drpc.org rate-limit every call; blastapi.io is
 *    shutting down; base.llamarpc.com is dead.
 *  - rpc.xlayer.tech caps eth_getLogs at 100 blocks.
 *
 * Scroll, Linea, Gnosis and ZKsync Era were added on 2026-11-19 because the
 * node asks for them (nginx access log: 46 of 570 gas requests), probed the
 * same way. gnosis.drpc.org and gnosis-rpc.publicnode.com prune;
 * zksync.drpc.org answers null for every transaction.
 */
export type SupportedChain =
  | 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | 'bsc' | 'avalanche'
  | 'scroll' | 'linea' | 'gnosis' | 'zksync'
  | 'sepolia' | 'base-sepolia' | 'xlayer';

interface RpcEndpoint {
  url: string;
  /** True only if the endpoint served year-old transactions and receipts when probed. */
  fullHistory: boolean;
}

interface ChainEntry {
  chain: Chain;
  /** Display name used in composed answers */
  label: string;
  /** Tried in this order; full-history endpoints first. */
  rpcs: RpcEndpoint[];
  /**
   * OP-stack chains expose the L1 base fee through the GasPriceOracle
   * predeploy, which the gas snapshot reads. (Whether a receipt carries an
   * L1 fee is read from the receipt itself, not from this flag: Scroll's do
   * and it is not OP-stack.)
   */
  isOpStack: boolean;
}

const full = (url: string): RpcEndpoint => ({ url, fullHistory: true });
const recent = (url: string): RpcEndpoint => ({ url, fullHistory: false });

const REGISTRY: Record<SupportedChain, ChainEntry> = {
  base: {
    chain: base,
    label: 'Base',
    rpcs: [full('https://mainnet.base.org'), full('https://base.drpc.org'), recent('https://base-rpc.publicnode.com')],
    isOpStack: true,
  },
  ethereum: {
    chain: mainnet,
    label: 'Ethereum',
    rpcs: [full('https://eth.drpc.org'), full('https://rpc.mevblocker.io'), recent('https://ethereum-rpc.publicnode.com')],
    isOpStack: false,
  },
  // Arbitrum folds its L1 data cost into gasUsed, so there is no separate l1Fee to add.
  arbitrum: {
    chain: arbitrum,
    label: 'Arbitrum One',
    rpcs: [full('https://arb1.arbitrum.io/rpc'), full('https://arbitrum.drpc.org')],
    isOpStack: false,
  },
  optimism: {
    chain: optimism,
    label: 'OP Mainnet',
    rpcs: [full('https://mainnet.optimism.io'), full('https://optimism.drpc.org')],
    isOpStack: true,
  },
  polygon: {
    chain: polygon,
    label: 'Polygon',
    // polygon-bor-rpc.publicnode.com was a recent-data fallback; it now times out
    rpcs: [full('https://polygon.drpc.org'), full('https://rpc-mainnet.matic.quiknode.pro')],
    isOpStack: false,
  },
  bsc: {
    chain: bsc,
    label: 'BNB Smart Chain',
    rpcs: [
      full('https://bsc-dataseed.binance.org'),
      full('https://bsc-dataseed1.defibit.io'),
      full('https://bsc-dataseed1.ninicoin.io'),
    ],
    isOpStack: false,
  },
  avalanche: {
    chain: avalanche,
    label: 'Avalanche C-Chain',
    rpcs: [full('https://api.avax.network/ext/bc/C/rpc'), full('https://avalanche.drpc.org')],
    isOpStack: false,
  },
  scroll: {
    chain: scroll,
    label: 'Scroll',
    rpcs: [full('https://rpc.scroll.io'), full('https://scroll.drpc.org'), full('https://1rpc.io/scroll')],
    isOpStack: false,
  },
  linea: {
    chain: linea,
    label: 'Linea',
    rpcs: [full('https://rpc.linea.build'), full('https://linea.drpc.org'), full('https://1rpc.io/linea')],
    isOpStack: false,
  },
  gnosis: {
    chain: gnosis,
    label: 'Gnosis',
    rpcs: [
      full('https://rpc.gnosischain.com'),
      full('https://rpc.gnosis.gateway.fm'),
      recent('https://gnosis-rpc.publicnode.com'),
    ],
    isOpStack: false,
  },
  zksync: {
    chain: zksync,
    label: 'ZKsync Era',
    rpcs: [full('https://mainnet.era.zksync.io'), full('https://1rpc.io/zksync2-era')],
    isOpStack: false,
  },
  // Ethereum Sepolia: Telegraph's home chain since V2 (was Base Sepolia in Season I)
  sepolia: {
    chain: sepolia,
    label: 'Ethereum Sepolia',
    rpcs: [
      // Re-probed 2026-11-19: sepolia.gateway.tenderly.co had stopped
      // answering and 1rpc.io/sepolia had begun pruning (no receipt at one
      // year) and rate-limiting; both were listed as full history.
      // fastest first: ethpandaops takes about 2 s to answer
      full('https://ethereum-sepolia.gateway.tatum.io'),
      full('https://sepolia.rpc.thirdweb.com'),
      full('https://rpc.sepolia.ethpandaops.io'),
      // serves recent transactions and current state; no receipts past ~60 days
      recent('https://ethereum-sepolia-rpc.publicnode.com'),
    ],
    isOpStack: false,
  },
  'base-sepolia': {
    chain: baseSepolia,
    label: 'Base Sepolia',
    rpcs: [
      full('https://sepolia.base.org'),
      full('https://base-sepolia.drpc.org'),
      recent('https://base-sepolia-rpc.publicnode.com'),
    ],
    isOpStack: true,
  },
  xlayer: {
    chain: xLayer,
    label: 'X Layer',
    // xlayerrpc.okx.com stopped answering (every call timed out, 2026-11-19)
    rpcs: [full('https://rpc.xlayer.tech'), full('https://xlayer.drpc.org')],
    isOpStack: false,
  },
};

/** Every supported chain name, in registry order. */
export const SUPPORTED_CHAINS = Object.keys(REGISTRY) as SupportedChain[];

const clients = new Map<SupportedChain, PublicClient>();
const rpcClients = new Map<SupportedChain, RpcClient[]>();

/** One endpoint of a chain, with a client that talks to that endpoint only. */
export interface RpcClient {
  url: string;
  fullHistory: boolean;
  client: PublicClient;
}

export function isSupportedChain(value: string): value is SupportedChain {
  return Object.hasOwn(REGISTRY, value);
}

export function chainMeta(name: SupportedChain): {
  chainId: number;
  isOpStack: boolean;
  label: string;
  /** Ticker of the chain's native coin (ETH, POL, BNB, AVAX, XDAI, OKB) */
  nativeSymbol: string;
} {
  const entry = REGISTRY[name];
  return {
    chainId: entry.chain.id,
    isOpStack: entry.isOpStack,
    label: entry.label,
    nativeSymbol: entry.chain.nativeCurrency.symbol,
  };
}

/**
 * Client for reads of current state (gas price, latest block), where every
 * endpoint is equally able to answer: viem fails over on errors, in order.
 *
 * Do not use it to look up historical records. viem's fallback only moves on
 * when an endpoint errors, and a pruned endpoint answers `null` without
 * erroring, so the first endpoint's gap would be reported as the truth.
 * Use getRpcClients for those.
 */
export function getClient(name: SupportedChain): PublicClient {
  let client = clients.get(name);
  if (!client) {
    const entry = REGISTRY[name];
    // viem's chain-parameterized client type is narrower than the generic
    // PublicClient we hand out; behavior is identical.
    client = createPublicClient({
      chain: entry.chain,
      // 4 s per endpoint and no per-endpoint retry: with the earlier 15 s and
      // two retries, one throttled endpoint held a request for a minute.
      // fallback moves to the next endpoint on error and makes one more pass.
      transport: fallback(
        entry.rpcs.map(({ url }) => http(url, { timeout: 4_000, retryCount: 0 })),
        { retryCount: 1 },
      ),
    }) as unknown as PublicClient;
    clients.set(name, client);
  }
  return client;
}

/**
 * The chain's endpoints one by one, in registry order, for lookups of
 * historical records where the caller must see each endpoint's own answer.
 *
 * Three-second timeout and no retry: the caller fails over itself, and a
 * dead endpoint must cost little. With the previous 8 s and one retry, a
 * single endpoint that had stopped answering added 16 s to every lookup
 * that reached it. Healthy endpoints answer in 0.1 to 1 s.
 */
export function getRpcClients(name: SupportedChain): RpcClient[] {
  let list = rpcClients.get(name);
  if (!list) {
    const entry = REGISTRY[name];
    list = entry.rpcs.map(({ url, fullHistory }) => ({
      url,
      fullHistory,
      client: createPublicClient({
        chain: entry.chain,
        transport: http(url, { timeout: 3_000, retryCount: 0 }),
      }) as unknown as PublicClient,
    }));
    rpcClients.set(name, list);
  }
  return list;
}
