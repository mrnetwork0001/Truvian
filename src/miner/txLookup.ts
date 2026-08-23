/**
 * ONCHAIN_TX_LOOKUP intent handler.
 * Pure (input) -> payload against live RPC; no Telegraph envelope knowledge.
 */
import { getAddress, isHex } from 'viem';
import { chainMeta, getClient, isSupportedChain } from '../config/chains.js';
import { IntentError, type DecodedTransfer, type TxLookupInput, type TxLookupResult } from '../types/index.js';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicToAddress(topic: `0x${string}`): string {
  return getAddress(`0x${topic.slice(26)}`);
}

export function validateTxLookupInput(raw: unknown): TxLookupInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new IntentError('INVALID_INPUT', 'input must be an object');
  }
  const { chain, txHash } = raw as Record<string, unknown>;
  if (typeof chain !== 'string' || !isSupportedChain(chain)) {
    throw new IntentError('CHAIN_UNSUPPORTED', `chain must be one of base|ethereum|xlayer, got ${String(chain)}`);
  }
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    throw new IntentError('INVALID_INPUT', 'txHash must be a 32-byte 0x-hex string');
  }
  return { chain, txHash: txHash.toLowerCase() as `0x${string}` };
}

export async function handleTxLookup(input: TxLookupInput): Promise<TxLookupResult> {
  const client = getClient(input.chain);
  const meta = chainMeta(input.chain);

  let receipt, tx, latestBlock;
  try {
    [receipt, tx, latestBlock] = await Promise.all([
      client.getTransactionReceipt({ hash: input.txHash }),
      client.getTransaction({ hash: input.txHash }),
      client.getBlockNumber(),
    ]);
  } catch (err: any) {
    if (err?.name === 'TransactionReceiptNotFoundError' || err?.name === 'TransactionNotFoundError') {
      throw new IntentError('TX_NOT_FOUND', `transaction ${input.txHash} not found on ${input.chain}`);
    }
    throw new IntentError('UPSTREAM_RPC_ERROR', err?.shortMessage ?? err?.message ?? 'rpc failure');
  }

  const erc20Transfers: DecodedTransfer[] = [];
  for (const log of receipt.logs) {
    // ERC-20 Transfer: topic0 = signature, topics[1]=from, topics[2]=to, data=amount.
    // ERC-721 Transfer shares topic0 but carries tokenId as a 4th topic — excluded here.
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

  // OP-stack receipts carry l1Fee (viem types don't surface it on generic clients)
  const l1Fee = meta.isOpStack ? BigInt((receipt as any).l1Fee ?? 0) : 0n;
  const totalFee = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;

  return {
    chain: input.chain,
    chainId: meta.chainId,
    txHash: receipt.transactionHash.toLowerCase(),
    status: receipt.status === 'success' ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash.toLowerCase(),
    transactionIndex: receipt.transactionIndex,
    from: getAddress(receipt.from),
    to: receipt.to ? getAddress(receipt.to) : null,
    contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
    valueWei: tx.value.toString(),
    nonce: tx.nonce,
    inputData: tx.input,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    l1FeeWei: l1Fee.toString(),
    totalFeeWei: totalFee.toString(),
    logCount: receipt.logs.length,
    erc20Transfers,
    confirmations: (latestBlock - receipt.blockNumber + 1n).toString(),
  };
}
