import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem';
import { arbitrum, avalanche, base, baseSepolia, bsc, mainnet, optimism, polygon, sepolia, xLayer } from 'viem/chains';

/**
 * Chain registry. Base is primary; the rest cover the chains Telegraph
 * Season II questions name (the intent's `chain` input is free text).
 *
 * RPC endpoints verified live with eth_chainId:
 *  - 2026-08-23: mainnet.base.org, base-rpc.publicnode.com (base.llamarpc.com is dead);
 *    rpc.xlayer.tech (caps eth_getLogs at 100 blocks)
 *  - 2026-11-12: every arbitrum / optimism / polygon / bsc / avalanche / sepolia URL below
 */
export type SupportedChain =
  | 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | 'bsc' | 'avalanche'
  | 'sepolia' | 'base-sepolia' | 'xlayer';

interface ChainEntry {
  chain: Chain;
  /** Display name used in composed answers */
  label: string;
  rpcUrls: string[];
  /** OP-stack chains carry l1Fee fields on receipts; total cost must include them. */
  isOpStack: boolean;
}

const REGISTRY: Record<SupportedChain, ChainEntry> = {
  base: {
    chain: base,
    label: 'Base',
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    isOpStack: true,
  },
  ethereum: {
    chain: mainnet,
    label: 'Ethereum',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.merkle.io'],
    isOpStack: false,
  },
  // Arbitrum folds its L1 data cost into gasUsed, so there is no separate l1Fee to add.
  arbitrum: {
    chain: arbitrum,
    label: 'Arbitrum One',
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    isOpStack: false,
  },
  optimism: {
    chain: optimism,
    label: 'OP Mainnet',
    rpcUrls: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    isOpStack: true,
  },
  polygon: {
    chain: polygon,
    label: 'Polygon',
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    isOpStack: false,
  },
  bsc: {
    chain: bsc,
    label: 'BNB Smart Chain',
    rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    isOpStack: false,
  },
  avalanche: {
    chain: avalanche,
    label: 'Avalanche C-Chain',
    rpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
    isOpStack: false,
  },
  // Ethereum Sepolia: Telegraph's home chain since V2 (was Base Sepolia in Season I)
  sepolia: {
    chain: sepolia,
    label: 'Ethereum Sepolia',
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://1rpc.io/sepolia'],
    isOpStack: false,
  },
  'base-sepolia': {
    chain: baseSepolia,
    label: 'Base Sepolia',
    rpcUrls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
    isOpStack: true,
  },
  xlayer: {
    chain: xLayer,
    label: 'X Layer',
    rpcUrls: ['https://rpc.xlayer.tech'],
    isOpStack: false,
  },
};

/** Every supported chain name, in registry order. */
export const SUPPORTED_CHAINS = Object.keys(REGISTRY) as SupportedChain[];

const clients = new Map<SupportedChain, PublicClient>();

export function isSupportedChain(value: string): value is SupportedChain {
  return Object.hasOwn(REGISTRY, value);
}

export function chainMeta(name: SupportedChain): {
  chainId: number;
  isOpStack: boolean;
  label: string;
  /** Ticker of the chain's native coin (ETH, POL, BNB, AVAX, OKB) */
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

export function getClient(name: SupportedChain): PublicClient {
  let client = clients.get(name);
  if (!client) {
    const entry = REGISTRY[name];
    // viem's chain-parameterized client type is narrower than the generic
    // PublicClient we hand out; behavior is identical.
    client = createPublicClient({
      chain: entry.chain,
      transport: fallback(
        entry.rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 2 })),
      ),
    }) as unknown as PublicClient;
    clients.set(name, client);
  }
  return client;
}
