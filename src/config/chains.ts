import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { base, baseSepolia, mainnet, xLayer } from 'viem/chains';

/**
 * Chain registry. Base is primary (Telegraph is built on Base).
 * RPC endpoints verified live 2026-08-23:
 *  - mainnet.base.org and base-rpc.publicnode.com respond (base.llamarpc.com is dead)
 *  - rpc.xlayer.tech responds; caps eth_getLogs at 100 blocks
 */
export type SupportedChain = 'base' | 'ethereum' | 'xlayer' | 'base-sepolia';

interface ChainEntry {
  chain: typeof base | typeof mainnet | typeof xLayer | typeof baseSepolia;
  rpcUrls: string[];
  /** OP-stack chains carry l1Fee fields on receipts; total cost must include them. */
  isOpStack: boolean;
}

const REGISTRY: Record<SupportedChain, ChainEntry> = {
  base: {
    chain: base,
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    isOpStack: true,
  },
  ethereum: {
    chain: mainnet,
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.merkle.io'],
    isOpStack: false,
  },
  xlayer: {
    chain: xLayer,
    rpcUrls: ['https://rpc.xlayer.tech'],
    isOpStack: false,
  },
  // Telegraph's own home chain — validators are likely to ask about it
  'base-sepolia': {
    chain: baseSepolia,
    rpcUrls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
    isOpStack: true,
  },
};

const clients = new Map<SupportedChain, PublicClient>();

export function isSupportedChain(value: string): value is SupportedChain {
  return value in REGISTRY;
}

export function chainMeta(name: SupportedChain): { chainId: number; isOpStack: boolean } {
  const entry = REGISTRY[name];
  return { chainId: entry.chain.id, isOpStack: entry.isOpStack };
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
