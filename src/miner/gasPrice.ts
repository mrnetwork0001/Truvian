/**
 * GAS_PRICE intent handler.
 * Snapshot anchored to an explicit block number so any answer is verifiable.
 * `gas_price_gwei` and `as_of` are the names of Telegraph's V2 response format.
 */
import { formatGwei } from 'viem';
import { chainMeta, getClient, type SupportedChain } from '../config/chains.js';
import { IntentError, type GasPriceInput, type GasPriceResult } from '../types/index.js';
import { chainFromText, requireChain } from './txLookup.js';

/** OP-stack GasPriceOracle predeploy, same address on every OP-stack chain. */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
const l1BaseFeeAbi = [
  { name: 'l1BaseFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export function validateGasPriceInput(raw: unknown): GasPriceInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new IntentError('INVALID_INPUT', 'input must be an object');
  }
  const body = raw as Record<string, unknown>;
  // An explicit chain/network param wins; otherwise a chain named in a
  // natural-language query; otherwise Base, this miner's home chain.
  const chainRaw = body.chain ?? body.network;
  let chain: SupportedChain = 'base';
  if (chainRaw !== undefined && chainRaw !== null && String(chainRaw).trim() !== '') {
    chain = requireChain(chainRaw);
  } else if (typeof body.query === 'string') {
    chain = chainFromText(body.query) ?? 'base';
  }
  return { chain };
}

export async function handleGasPrice(input: GasPriceInput): Promise<GasPriceResult> {
  const client = getClient(input.chain);
  const meta = chainMeta(input.chain);

  try {
    const [block, gasPrice, maxPriorityFee, feeHistory, l1BaseFee] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.getGasPrice(),
      client.estimateMaxPriorityFeePerGas(),
      client.getFeeHistory({ blockCount: 5, rewardPercentiles: [25, 50, 75] }),
      meta.isOpStack
        ? client.readContract({ address: GAS_PRICE_ORACLE, abi: l1BaseFeeAbi, functionName: 'l1BaseFee' })
        : Promise.resolve(0n),
    ]);

    // median across the sampled blocks for each percentile column
    const median = (col: number): bigint => {
      const vals = (feeHistory.reward ?? [])
        .map((row) => row[col])
        .filter((v): v is bigint => v !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (vals.length === 0) return 0n;
      return vals[Math.floor(vals.length / 2)]!;
    };

    const chainLabel = meta.label;
    const baseFee = block.baseFeePerGas ?? 0n;
    const gwei = (v: bigint) => `${formatGwei(v)} gwei (${v} wei)`;
    // deterministic fee-level classification (thresholds in gwei)
    const level = gasPrice <= 1_000_000_000n ? 'low' : gasPrice <= 50_000_000_000n ? 'normal' : 'high';
    const answer = [
      `The current gas price on ${chainLabel} (chain id ${meta.chainId}) is ${gwei(gasPrice)} at block ${block.number}, a ${level} transaction fee level.`,
      `The base fee per gas is ${gwei(baseFee)} and the suggested priority fee is ${gwei(maxPriorityFee)}, so a standard EIP-1559 transaction can use max fee ${gwei(baseFee * 2n + maxPriorityFee)}.`,
      `Recent priority fees over the last 5 blocks: 25th percentile ${formatGwei(median(0))} gwei, median ${formatGwei(median(1))} gwei, 75th percentile ${formatGwei(median(2))} gwei.`,
      meta.isOpStack ? `The L1 base fee observed by ${chainLabel} is ${gwei(l1BaseFee)}.` : '',
    ].filter(Boolean).join(' ');

    return {
      answer,
      // Full statement in the label_field - see txLookup.ts for why.
      signal: answer,
      source: `${chainLabel} JSON-RPC eth_gasPrice + eth_feeHistory + latest block`,
      confidence: 0.99,
      chain: input.chain,
      chainId: meta.chainId,
      blockNumber: block.number.toString(),
      baseFeePerGasWei: (block.baseFeePerGas ?? 0n).toString(),
      gasPriceWei: gasPrice.toString(),
      maxPriorityFeePerGasWei: maxPriorityFee.toString(),
      priorityFeePercentilesWei: { p25: median(0).toString(), p50: median(1).toString(), p75: median(2).toString() },
      l1GasPriceWei: l1BaseFee.toString(),
      // formatGwei is exact; Number() of it is the nearest double, the same for the same value
      gas_price_gwei: Number(formatGwei(gasPrice)),
      as_of: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  } catch (err: any) {
    if (err instanceof IntentError) throw err;
    throw new IntentError('UPSTREAM_RPC_ERROR', err?.shortMessage ?? err?.message ?? 'rpc failure');
  }
}
