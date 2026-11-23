/**
 * CRYPTO_TRANSFER_VERIFY intent handler.
 *
 * The intent asks whether a transfer happened and what it cost: its status,
 * the gas fee and how much of it was burned, the sender and recipient, and
 * how many blocks confirm it. The node has no input format for it yet, so a
 * request carries the transaction hash in a parameter or anywhere in a
 * free-text question, the way ONCHAIN_TX_LOOKUP requests do.
 *
 * Every figure is read from the chain: the receipt (status, gas used,
 * effective gas price, the OP-stack L1 data fee, Transfer logs), the block
 * header (base fee, so the burned part is base fee x gas used) and the chain
 * tip (confirmations). Token amounts use each token's own decimals() and
 * symbol() at the transaction's block. Nothing is estimated.
 *
 * Like the transaction lookup, the reply the node stores is kept short: its
 * judge reads only the first 512 tokens.
 */
import { formatEther, formatGwei, formatUnits, getAddress, parseAbi, type Block } from 'viem';
import { chainMeta, getRpcClients, type SupportedChain } from '../config/chains.js';
import { IntentError, type TxFullReply, type TxLookupInput } from '../types/index.js';
import { contractAnswered, readText } from './holdings.js';
import { handleTxLookup, validateTxLookupInput } from './txLookup.js';

const DECIMALS = parseAbi(['function decimals() view returns (uint8)']);
const HASH = /0x[0-9a-fA-F]{64}/;
/** Token transfers spelled out in the answer; the count of the rest is given */
const LISTED_TRANSFERS = 5;

/**
 * The hash in an explicit parameter, else in any text the request carries.
 * With no input format on the node, the parameter names it will use are not
 * known, so every string value is searched.
 */
export function validateTransferInput(raw: unknown): TxLookupInput {
  if (typeof raw !== 'object' || raw === null) throw new IntentError('INVALID_INPUT', 'input must be an object');
  const body = raw as Record<string, unknown>;
  if (body.txHash ?? body.tx_hash ?? body.hash ?? body.query) return validateTxLookupInput(body);
  const texts = Object.values(body).filter((v): v is string => typeof v === 'string');
  const text = texts.find((t) => HASH.test(t));
  if (!text) {
    throw new IntentError('INVALID_INPUT', 'no transaction hash given: send tx_hash (0x followed by 64 hexadecimal characters), or a question containing one');
  }
  return validateTxLookupInput({ ...body, query: texts.join(' ') });
}

/** The block header from the first endpoint that has it; a header is never pruned, but an endpoint may lag. */
async function blockOf(chain: SupportedChain, blockHash: `0x${string}`): Promise<Block> {
  let last: unknown = null;
  for (const { client } of getRpcClients(chain)) {
    try {
      return await client.getBlock({ blockHash });
    } catch (err) {
      last = err;
    }
  }
  throw new IntentError('UPSTREAM_RPC_ERROR', `no ${chainMeta(chain).label} endpoint returned block ${blockHash}: ${(last as any)?.shortMessage ?? (last as any)?.message ?? 'no answer'}`);
}

interface TokenMeta { symbol: string | null; decimals: number | null }

/** symbol() and decimals() at the block; null for a contract that does not answer them (no ERC-20 metadata). */
async function tokenMeta(chain: SupportedChain, token: `0x${string}`, blockNumber: bigint): Promise<TokenMeta> {
  let last: unknown = null;
  for (const { client } of getRpcClients(chain)) {
    try {
      const [symbol, decimals] = await Promise.all([
        readText(client, token, 'symbol', blockNumber).then((s) => s.trim() || null, (e) => { if (contractAnswered(e)) return null; throw e; }),
        client.readContract({ address: token, abi: DECIMALS, functionName: 'decimals', blockNumber })
          .then((d) => Number(d), (e) => { if (contractAnswered(e)) return null; throw e; }),
      ]);
      return { symbol, decimals };
    } catch (err) {
      last = err;
    }
  }
  throw new IntentError('UPSTREAM_RPC_ERROR', `no ${chainMeta(chain).label} endpoint answered symbol()/decimals() of ${token}: ${(last as any)?.shortMessage ?? 'no answer'}`);
}

export interface TokenTransferOut {
  token: string;
  symbol: string | null;
  from: string;
  to: string;
  amount_raw: string;
  /** Whole tokens with decimals applied, exact; null when the contract gives no decimals() */
  amount: string | null;
}

export async function handleTransferVerify(input: TxLookupInput) {
  const full = await handleTxLookup({ ...input, detail: 'full' }) as TxFullReply;

  // Pending or unknown: nothing has settled, and the lookup's answer says why.
  if (full.status !== 'confirmed' && full.status !== 'reverted') {
    return {
      answer: `${full.answer} So this transfer cannot be verified as settled: it has no receipt in any block.`,
      tx_hash: full.tx_hash,
      status: full.status,
      settled: false,
      chain: full.chain,
      confidence: full.confidence,
      checked_at: full.checked_at,
      provenance: full.provenance,
    };
  }

  const m = full as Extract<TxFullReply, { status: 'confirmed' | 'reverted' }> & Record<string, any>;
  const chain = m.chain as SupportedChain;
  const meta = chainMeta(chain);
  const coin = meta.nativeSymbol;
  const blockNumber = BigInt(m.blockNumber);
  const block = await blockOf(chain, m.blockHash as `0x${string}`);

  const gasUsed = BigInt(m.gasUsed);
  const price = BigInt(m.effectiveGasPrice);
  const l1Fee = BigInt(m.l1FeeWei);
  const totalFee = BigInt(m.totalFeeWei);
  const executionFee = gasUsed * price;
  // EIP-1559: the base fee part of the execution fee is burned. A chain or
  // block without a base fee burns nothing (BNB Smart Chain burns by its own
  // rule, outside the transaction).
  const baseFee = block.baseFeePerGas ?? null;
  const burned = baseFee === null ? null : gasUsed * baseFee;

  const transfers: TokenTransferOut[] = [];
  const decoded = (m.erc20Transfers ?? []) as Array<{ token: string; from: string; to: string; amount: string }>;
  const metas = new Map<string, TokenMeta>();
  for (const t of decoded.slice(0, LISTED_TRANSFERS)) {
    const token = getAddress(t.token);
    if (!metas.has(token)) metas.set(token, await tokenMeta(chain, token, blockNumber));
    const tm = metas.get(token)!;
    transfers.push({
      token, symbol: tm.symbol, from: t.from, to: t.to, amount_raw: t.amount,
      amount: tm.decimals === null ? null : formatUnits(BigInt(t.amount), tm.decimals),
    });
  }

  const ok = m.status === 'confirmed';
  const confirmations = m.confirmations === null ? null : Number(m.confirmations);
  const parts: string[] = [];
  parts.push(`Transaction ${m.tx_hash} on ${meta.label} (chain id ${meta.chainId}) ${ok ? 'succeeded' : 'was included but reverted, so nothing it tried to move was transferred'}: it is in block ${m.block_number}${confirmations === null ? '' : ` with ${confirmations} confirmation${confirmations === 1 ? '' : 's'}`}.`);
  parts.push(m.to
    ? `Sender ${m.from}, recipient ${m.to}, native value ${formatEther(BigInt(m.valueWei))} ${coin}.`
    : `Sender ${m.from}; it created a contract${m.contractAddress ? ` at ${m.contractAddress}` : ''}; native value ${formatEther(BigInt(m.valueWei))} ${coin}.`);
  const feeParts = [`gas used ${gasUsed} at ${formatGwei(price)} gwei`];
  if (burned !== null) feeParts.push(`${formatEther(burned)} ${coin} of it burned as base fee (${formatGwei(baseFee!)} gwei)`);
  if (l1Fee > 0n) feeParts.push(`plus an L1 data fee of ${formatEther(l1Fee)} ${coin}`);
  parts.push(`Fee paid: ${formatEther(totalFee)} ${coin} (${feeParts.join(', ')}).`);
  if (ok && transfers.length > 0) {
    const listed = transfers.map((t) => `${t.amount ?? `${t.amount_raw} base units of`} ${t.symbol ?? 'token'} (${t.token}) from ${t.from} to ${t.to}`);
    const more = decoded.length > transfers.length ? `, and ${decoded.length - transfers.length} more` : '';
    parts.push(`Token transfers: ${listed.join('; ')}${more}.`);
  } else if (ok) {
    parts.push('It moved no ERC-20 tokens.');
  }

  return {
    answer: parts.join(' '),
    tx_hash: m.tx_hash,
    status: m.status,
    settled: ok,
    chain,
    block_number: m.block_number,
    confirmations,
    from: m.from,
    to: m.to,
    value_native: formatEther(BigInt(m.valueWei)),
    native_symbol: coin,
    fee_total_native: formatEther(totalFee),
    fee_execution_native: formatEther(executionFee),
    fee_burned_native: burned === null ? null : formatEther(burned),
    fee_l1_native: formatEther(l1Fee),
    gas_used: gasUsed.toString(),
    effective_gas_price_gwei: formatGwei(price),
    token_transfers: transfers,
    token_transfer_count: decoded.length,
    confidence: 0.99,
    checked_at: m.checked_at,
    provenance: m.provenance,
  };
}
