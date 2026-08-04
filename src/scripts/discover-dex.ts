/**
 * Empirical DEX discovery for X Layer (chain 196).
 * We do NOT assume any factory/router address. We scan real `Swap` event logs
 * from recent blocks, collect the emitting pool contracts, then introspect each
 * pool on-chain to learn its factory, tokens, fee tier and liquidity.
 */
import { createPublicClient, http, parseAbi, erc20Abi, type Address, type Hex } from 'viem';

const client = createPublicClient({ transport: http('https://rpc.xlayer.tech') });

// topic0 signatures
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as Hex; // Swap(address,address,int256,int256,uint160,uint128,int24)
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822' as Hex; // Swap(address,uint256,uint256,uint256,uint256,address)

const poolAbi = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 obIdx,uint16 obCard,uint16 obCardNext,uint8 feeProtocol,bool unlocked)',
  'function getReserves() view returns (uint112 r0,uint112 r1,uint32 ts)',
]);

const symCache = new Map<string, string>();
async function sym(a: Address) {
  const k = a.toLowerCase();
  if (symCache.has(k)) return symCache.get(k)!;
  let s = '???';
  try { s = await client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }); } catch {}
  symCache.set(k, s); return s;
}

// X Layer public RPC enforces a hard 100-block range cap on eth_getLogs (verified empirically).
const MAX_LOG_RANGE = 100n;

async function scan(topic: Hex, label: string, fromBlock: bigint, toBlock: bigint) {
  const counts = new Map<string, number>();
  let total = 0;
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = start + MAX_LOG_RANGE - 1n > toBlock ? toBlock : start + MAX_LOG_RANGE - 1n;
    try {
      const logs = await client.getLogs({ fromBlock: start, toBlock: end, topics: [topic] } as any);
      total += logs.length;
      for (const l of logs) counts.set(l.address.toLowerCase(), (counts.get(l.address.toLowerCase()) ?? 0) + 1);
    } catch (e: any) {
      console.log(`  chunk ${start}-${end} failed: ${e.shortMessage ?? e.message?.slice(0, 90)}`);
    }
  }
  console.log(`\n### ${label}: ${total} swap logs across ${counts.size} pools (blocks ${fromBlock}-${toBlock})`);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const latest = await client.getBlockNumber();
  const from = latest - 1999n;
  console.log(`latestBlock=${latest}, scanning ${from}..${latest}`);

  const factoryTally = new Map<string, number>();

  for (const [topic, label] of [[V3_SWAP, 'UniV3-style'], [V2_SWAP, 'UniV2-style']] as const) {
    const pools = await scan(topic, label, from, latest);
    for (const [addr, n] of pools.slice(0, 12)) {
      const a = addr as Address;
      try {
        const [f, t0, t1] = await Promise.all([
          client.readContract({ address: a, abi: poolAbi, functionName: 'factory' }).catch(() => null),
          client.readContract({ address: a, abi: poolAbi, functionName: 'token0' }),
          client.readContract({ address: a, abi: poolAbi, functionName: 'token1' }),
        ]);
        const [s0, s1] = await Promise.all([sym(t0 as Address), sym(t1 as Address)]);
        let extra = '';
        if (label === 'UniV3-style') {
          const [fee, liq] = await Promise.all([
            client.readContract({ address: a, abi: poolAbi, functionName: 'fee' }).catch(() => null),
            client.readContract({ address: a, abi: poolAbi, functionName: 'liquidity' }).catch(() => null),
          ]);
          extra = `fee=${fee} L=${liq}`;
        } else {
          const r = await client.readContract({ address: a, abi: poolAbi, functionName: 'getReserves' }).catch(() => null);
          extra = r ? `r0=${(r as any)[0]} r1=${(r as any)[1]}` : 'no reserves';
        }
        if (f) factoryTally.set(String(f), (factoryTally.get(String(f)) ?? 0) + n);
        console.log(`  ${a} swaps=${String(n).padStart(4)} ${s0}/${s1} ${extra} factory=${f}`);
      } catch (e: any) {
        console.log(`  ${a} swaps=${n} introspect-failed: ${e.shortMessage ?? e.message?.slice(0, 70)}`);
      }
    }
  }

  console.log('\n=== FACTORY TALLY (by swap volume) ===');
  for (const [f, n] of [...factoryTally.entries()].sort((a, b) => b[1] - a[1])) {
    const code = await client.getBytecode({ address: f as Address });
    console.log(`  ${f}  swaps=${n}  codeLen=${code ? (code.length - 2) / 2 : 0}B`);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
