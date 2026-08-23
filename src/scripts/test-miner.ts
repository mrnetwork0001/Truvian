/**
 * Live verification of both intent handlers against Base mainnet.
 * Picks a real recent transaction, runs ONCHAIN_TX_LOOKUP on it, checks the
 * fee-math invariant against the raw RPC receipt, then runs GAS_PRICE and
 * checks internal consistency. Exits non-zero on any failure.
 */
import { getClient } from '../config/chains.js';
import { handleTxLookup, validateTxLookupInput } from '../miner/txLookup.js';
import { handleGasPrice, validateGasPriceInput } from '../miner/gasPrice.js';
import { IntentError } from '../types/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function main() {
  const client = getClient('base');

  // find a recent tx that emitted logs (so the Transfer decoder is exercised)
  const latest = await client.getBlock({ blockTag: 'latest', includeTransactions: false });
  let sampleHash: `0x${string}` | undefined;
  for (let offset = 1n; offset <= 5n && !sampleHash; offset++) {
    const block = await client.getBlock({ blockNumber: latest.number - offset });
    for (const hash of block.transactions.slice(0, 12)) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (r && r.status === 'success' && r.logs.length > 0) { sampleHash = hash; break; }
    }
  }
  if (!sampleHash) throw new Error('could not find a recent Base tx with logs');
  console.log(`sample Base tx: ${sampleHash}\n`);

  // --- ONCHAIN_TX_LOOKUP ---
  const txInput = validateTxLookupInput({ chain: 'base', txHash: sampleHash });
  const tx = await handleTxLookup(txInput);
  console.log(JSON.stringify(tx, null, 2).slice(0, 1200), '\n...');

  const rawReceipt = await client.getTransactionReceipt({ hash: sampleHash });
  const rawL1Fee = BigInt((rawReceipt as any).l1Fee ?? 0);
  check('status matches raw receipt', tx.status === rawReceipt.status);
  check('blockNumber matches', tx.blockNumber === rawReceipt.blockNumber.toString());
  check(
    'fee invariant: totalFee = gasUsed*effectiveGasPrice + l1Fee',
    BigInt(tx.totalFeeWei) === rawReceipt.gasUsed * rawReceipt.effectiveGasPrice + rawL1Fee,
    `total=${tx.totalFeeWei} l1=${tx.l1FeeWei}`,
  );
  check('l1Fee captured on OP-stack chain', BigInt(tx.l1FeeWei) === rawL1Fee, tx.l1FeeWei);
  check('logCount matches', tx.logCount === rawReceipt.logs.length, String(tx.logCount));
  check('no JS numbers in wei fields', /^[0-9]+$/.test(tx.totalFeeWei) && /^[0-9]+$/.test(tx.valueWei));
  check(
    'transfer amounts are decimal strings',
    tx.erc20Transfers.every((t) => /^[0-9]+$/.test(t.amount)),
    `${tx.erc20Transfers.length} transfers decoded`,
  );

  // answer-first format: the composed answer must carry the exact figures
  check('answer present and number-first', tx.answer.length > 50 && tx.answer.startsWith('Transaction 0x'));
  check('answer contains tx hash', tx.answer.includes(tx.txHash));
  check('answer contains block number', tx.answer.includes(`block ${tx.blockNumber}`));
  check('answer contains from/to addresses', tx.answer.includes(tx.from) && (tx.to === null || tx.answer.includes(tx.to)));
  check('scored answer stays in ground-truth scope (no fee numerics)', !tx.answer.includes(tx.totalFeeWei));
  check('total fee still in structured payload', BigInt(tx.totalFeeWei) > 0n);
  check('answer states status word', /succeeded|reverted/.test(tx.answer));
  check('signal carries the full answer (scored via label_field)', tx.signal === tx.answer);
  check('answer includes function selector when present', tx.inputData === '0x' || tx.answer.includes(tx.inputData.slice(0, 10)));

  // flexible input aliases
  const viaAlias = validateTxLookupInput({ chain: 'BASE', tx_hash: sampleHash });
  check('input aliases: tx_hash + case-insensitive chain', viaAlias.chain === 'base' && viaAlias.txHash === sampleHash.toLowerCase());
  const viaQuery = validateTxLookupInput({ query: `look up ${sampleHash} on base please` });
  check('input via natural-language query', viaQuery.txHash === sampleHash.toLowerCase());

  // determinism: same input twice -> identical scored payload (confirmations may differ)
  const tx2 = await handleTxLookup(txInput);
  const scrub = ({ confirmations, ...rest }: typeof tx) => rest;
  check('deterministic: identical payload on repeat call', JSON.stringify(scrub(tx)) === JSON.stringify(scrub(tx2)));

  // error path: unknown tx
  const missing = await handleTxLookup(
    validateTxLookupInput({ chain: 'base', txHash: `0x${'ab'.repeat(32)}` }),
  ).then(() => null, (e) => e);
  check('unknown tx -> TX_NOT_FOUND', missing instanceof IntentError && missing.code === 'TX_NOT_FOUND');

  // error path: bad input
  const bad = (() => { try { validateTxLookupInput({ chain: 'base', txHash: '0x123' }); return null; } catch (e) { return e; } })();
  check('malformed hash rejected', bad instanceof IntentError && bad.code === 'INVALID_INPUT');

  // --- GAS_PRICE ---
  console.log('');
  const gas = await handleGasPrice(validateGasPriceInput({ chain: 'base' }));
  console.log(JSON.stringify(gas, null, 2));
  check('gas snapshot anchored to a block', BigInt(gas.blockNumber) > 0n);
  check('baseFee > 0', BigInt(gas.baseFeePerGasWei) > 0n);
  check('gasPrice >= baseFee', BigInt(gas.gasPriceWei) >= BigInt(gas.baseFeePerGasWei));
  check(
    'percentiles ordered p25<=p50<=p75',
    BigInt(gas.priorityFeePercentilesWei.p25) <= BigInt(gas.priorityFeePercentilesWei.p50) &&
      BigInt(gas.priorityFeePercentilesWei.p50) <= BigInt(gas.priorityFeePercentilesWei.p75),
  );
  check('OP-stack l1GasPrice present on Base', BigInt(gas.l1GasPriceWei) > 0n, gas.l1GasPriceWei);
  check('gas answer present and number-first', gas.answer.startsWith('The current gas price on Base'));
  check('gas answer contains gwei and wei forms', gas.answer.includes('gwei') && gas.answer.includes(`(${gas.gasPriceWei} wei)`));
  check('gas answer anchored to block', gas.answer.includes(`block ${gas.blockNumber}`));
  check('gas signal carries the full answer', gas.signal === gas.answer);
  check('gas answer states fee level', /(low|normal|high) transaction fee level/.test(gas.answer));
  const gasViaQuery = validateGasPriceInput({ query: 'what is the current gas price on ethereum mainnet?' });
  check('gas chain inferred from query', gasViaQuery.chain === 'ethereum');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
