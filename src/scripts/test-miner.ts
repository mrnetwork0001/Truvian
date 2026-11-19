/**
 * Live verification of both intent handlers against Base mainnet.
 * Picks a real recent transaction, runs ONCHAIN_TX_LOOKUP on it, checks the
 * fee-math invariant against the raw RPC receipt, then runs GAS_PRICE and
 * checks internal consistency. Exits non-zero on any failure.
 */
import { SUPPORTED_CHAINS, chainMeta, getClient, getRpcClients, type SupportedChain } from '../config/chains.js';
import { buildServer } from '../miner/server.js';
import { chainFromText, handleTxLookup, normalizeChain, searchRpcs, validateTxLookupInput } from '../miner/txLookup.js';
import { handleGasPrice, validateGasPriceInput } from '../miner/gasPrice.js';
import { IntentError } from '../types/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
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
  if (tx.status === 'pending') throw new Error('a mined sample transaction was reported pending');

  const rawReceipt = await client.getTransactionReceipt({ hash: sampleHash });
  const rawL1Fee = BigInt((rawReceipt as any).l1Fee ?? 0);
  check('execution_status matches raw receipt', tx.execution_status === rawReceipt.status);

  // Telegraph V2 response format (GET /engine/v1/intents/ONCHAIN_TX_LOOKUP):
  // tx_hash, status, from, to, block_number (scored), value_eth
  const rawTx = await client.getTransaction({ hash: sampleHash });
  check('V2 tx_hash is the lowercase hash', tx.tx_hash === sampleHash.toLowerCase());
  check('V2 status uses the intent enum', tx.status === 'confirmed', tx.status);
  check(
    'V2 block_number is the exact height as a JSON number',
    typeof tx.block_number === 'number' && BigInt(tx.block_number) === rawReceipt.blockNumber,
    String(tx.block_number),
  );
  check(
    'V2 value_eth is a JSON number equal to the wei value',
    typeof tx.value_eth === 'number' && Math.abs(tx.value_eth - Number(rawTx.value) / 1e18) < 1e-9,
    String(tx.value_eth),
  );
  check('V2 from/to are the receipt addresses', tx.from.toLowerCase() === rawReceipt.from.toLowerCase()
    && (tx.to ?? '').toLowerCase() === (rawReceipt.to ?? '').toLowerCase());
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
  if (tx2.status === 'pending') throw new Error('a mined sample transaction was reported pending');
  const scrub = ({ confirmations, ...rest }: typeof tx) => rest;
  check('deterministic: identical payload on repeat call', JSON.stringify(scrub(tx)) === JSON.stringify(scrub(tx2)));

  // error path: unknown tx
  const missing = await handleTxLookup(
    validateTxLookupInput({ chain: 'base', txHash: `0x${'ab'.repeat(32)}` }),
  ).then(() => null, (e) => e);
  check('unknown tx -> TX_NOT_FOUND', missing instanceof IntentError && missing.code === 'TX_NOT_FOUND');
  check(
    'TX_NOT_FOUND carries V2 status not_found and the hash',
    missing instanceof IntentError && missing.fields.status === 'not_found' && missing.fields.tx_hash === `0x${'ab'.repeat(32)}`,
  );

  // chain names: aliases, EIP-155 ids, CAIP-2, free text
  const aliasCases: Array<[string, string]> = [
    ['Ethereum', 'ethereum'], ['1', 'ethereum'], ['eip155:8453', 'base'], ['Arbitrum One', 'arbitrum'],
    ['42161', 'arbitrum'], ['OP Mainnet', 'optimism'], ['matic', 'polygon'], ['BNB Smart Chain', 'bsc'],
    ['avalanche_c_chain', 'avalanche'], ['sepolia', 'sepolia'], ['Base Sepolia', 'base-sepolia'], ['X Layer', 'xlayer'],
    ['scroll', 'scroll'], ['534352', 'scroll'], ['Linea', 'linea'], ['xdai', 'gnosis'], ['100', 'gnosis'],
    ['zkSync Era', 'zksync'], ['eip155:324', 'zksync'],
  ];
  const aliasMisses = aliasCases.filter(([raw, want]) => normalizeChain(raw) !== want);
  check('chain aliases, ids and CAIP-2 resolve', aliasMisses.length === 0, aliasMisses.map(([r]) => r).join(', '));
  const textCases: Array<[string, string | null]> = [
    ['gas on base sepolia?', 'base-sepolia'], ['on sepolia testnet', 'sepolia'], ['the Arbitrum network', 'arbitrum'],
    ['on Polygon', 'polygon'], ['BSC fees', 'bsc'], ['gas on zkSync', 'zksync'], ['Gnosis chain fee', 'gnosis'], ['ethereum mainnet', 'ethereum'], ['on base', 'base'], ['no chain here', null],
  ];
  const textMisses = textCases.filter(([raw, want]) => chainFromText(raw) !== want);
  check('chain named in free text is detected', textMisses.length === 0, textMisses.map(([r]) => r).join(' | '));
  const unsupported = (() => { try { validateTxLookupInput({ chain: 'solana', txHash: sampleHash }); return null; } catch (e) { return e; } })();
  check('unserved chain rejected by name', unsupported instanceof IntentError && unsupported.code === 'CHAIN_UNSUPPORTED');

  // every registered chain answers a real lookup: newest block's first transaction
  for (const name of SUPPORTED_CHAINS) {
    try {
      const c = getClient(name);
      let hash: `0x${string}` | undefined;
      const tip = await c.getBlockNumber();
      for (let back = 2n; back <= 12n && !hash; back++) {
        hash = (await c.getBlock({ blockNumber: tip - back })).transactions[0];
      }
      if (!hash) { check(`${name}: found a recent transaction to look up`, false); continue; }
      const got = await handleTxLookup(validateTxLookupInput({ chain: String(chainMeta(name).chainId), tx_hash: hash }));
      const raw = await c.getTransactionReceipt({ hash });
      check(
        `${name}: lookup by chain id returns the receipt's block`,
        got.status !== 'pending' && BigInt(got.block_number) === raw.blockNumber && got.chain === name
          && got.answer.includes(` ${chainMeta(name).nativeSymbol} (`),
        `${got.status} block ${got.block_number}`,
      );
      // the receipt's own l1Fee, where it has one, belongs in the total (OP-stack chains and Scroll)
      const rawL1 = BigInt((raw as any).l1Fee ?? 0);
      check(
        `${name}: total fee = gasUsed * effectiveGasPrice + the receipt's L1 fee`,
        got.status !== 'pending' && BigInt(got.totalFeeWei) === raw.gasUsed * raw.effectiveGasPrice + rawL1,
        `l1Fee ${rawL1}`,
      );
    } catch (e: any) {
      check(`${name}: lookup`, false, e?.message ?? String(e));
    }
  }

  // --- history: pruned endpoints must not turn old transactions into "not found" or "pending" ---
  console.log('');
  // searchRpcs rules, with stand-in endpoints (a pruned node answers "not found" for records it dropped)
  const notFound = () => Promise.reject(Object.assign(new Error('nf'), { name: 'TransactionNotFoundError' }));
  const broken = () => Promise.reject(new Error('rate limited'));
  const ep = (fullHistory: boolean, read: () => Promise<string>) => ({ fullHistory, client: { read } as any });
  const ask = (c: any) => c.read() as Promise<string>;
  const prunedThenFull = await searchRpcs([ep(false, notFound), ep(true, async () => 'record')], ask);
  check('a pruned endpoint\'s "not found" falls through to the next endpoint', prunedThenFull.found === 'record');
  const fullSaysNo = await searchRpcs([ep(true, notFound), ep(false, async () => 'never asked')], ask);
  check('a full-history "not found" proves absence', fullSaysNo.found === null && fullSaysNo.provenAbsent);
  const onlyPrunedAnswered = await searchRpcs([ep(true, broken), ep(false, notFound)], ask);
  check(
    'absence is not claimed when only a pruned endpoint answered',
    onlyPrunedAnswered.found === null && !onlyPrunedAnswered.provenAbsent && onlyPrunedAnswered.error instanceof Error,
  );
  const errorThenFound = await searchRpcs([ep(true, broken), ep(true, async () => 'record')], ask);
  check('an endpoint error falls through to the next endpoint', errorThenFound.found === 'record');

  // The transaction that exposed the bug: confirmed in Ethereum block 26398402,
  // reported "pending" once the first endpoint had pruned its receipt.
  const regression = await handleTxLookup(validateTxLookupInput({
    chain: 'ethereum', tx_hash: '0xa1c4b88b9ab5f6efc19a52f9d9d0c8ebd63023598f0bbbb7654bcdf44f7e2a36',
  }));
  check('regression: mined Ethereum tx with a pruned receipt is confirmed, not pending',
    regression.status === 'confirmed' && regression.block_number === 26398402, `${regression.status} ${regression.block_number}`);

  // every chain answers for transactions 60 days and one year old (approximate block times, seconds)
  const blockSeconds: Record<SupportedChain, number> = {
    base: 2, ethereum: 12, arbitrum: 0.25, optimism: 2, polygon: 2, bsc: 0.75, avalanche: 1.5,
    scroll: 3, linea: 2, gnosis: 5, zksync: 1, sepolia: 12, 'base-sepolia': 2, xlayer: 1,
  };
  for (const name of SUPPORTED_CHAINS) {
    for (const [age, days] of [['60 days', 60], ['1 year', 365]] as const) {
      try {
        const tip = await getClient(name).getBlockNumber();
        const target = tip - BigInt(Math.round((days * 86_400) / blockSeconds[name]));
        // Read the old block from whichever endpoint still has it. Some keep
        // transactions by hash but prune blocks by number (sepolia.base.org
        // answers 4444 "pruned history unavailable"), and free tiers drop
        // requests, so try several neighbouring blocks.
        let sample: { hash: `0x${string}`; block: bigint } | undefined;
        for (let off = 0n; off < 12n && !sample; off++) {
          for (const { client: c } of getRpcClients(name)) {
            const block = await c.getBlock({ blockNumber: target + off }).catch(() => null);
            if (block?.transactions[0]) { sample = { hash: block.transactions[0], block: block.number }; break; }
          }
        }
        if (!sample) { check(`${name}: found a ${age} old transaction to look up`, false); continue; }
        const got = await handleTxLookup(validateTxLookupInput({ chain: name, tx_hash: sample.hash }));
        check(
          `${name}: ${age} old transaction returns its block`,
          got.status !== 'pending' && BigInt(got.block_number) === sample.block,
          `${got.status} block ${got.block_number}`,
        );
      } catch (e: any) {
        check(`${name}: ${age} old transaction`, false, e?.message ?? String(e));
      }
    }
  }

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
  check('gas defaults to Base when no chain is named', validateGasPriceInput({}).chain === 'base');

  // Telegraph V2 response format (GET /engine/v1/intents/GAS_PRICE): chain, gas_price_gwei (scored), as_of
  check(
    'V2 gas_price_gwei is a JSON number equal to gasPriceWei',
    typeof gas.gas_price_gwei === 'number' && Math.abs(gas.gas_price_gwei * 1e9 - Number(gas.gasPriceWei)) < 1,
    String(gas.gas_price_gwei),
  );
  const anchor = await client.getBlock({ blockNumber: BigInt(gas.blockNumber) });
  check('V2 as_of is the anchoring block time', gas.as_of === new Date(Number(anchor.timestamp) * 1000).toISOString(), gas.as_of);
  for (const name of SUPPORTED_CHAINS) {
    try {
      const g = await handleGasPrice(validateGasPriceInput({ chain: name }));
      check(`${name}: gas snapshot`, g.gas_price_gwei >= 0 && BigInt(g.blockNumber) > 0n && g.chain === name, `${g.gas_price_gwei} gwei`);
    } catch (e: any) {
      check(`${name}: gas snapshot`, false, e?.message ?? String(e));
    }
  }

  // --- HTTP surface: the exact bodies the node reads through intent_mapping ---
  console.log('');
  const app = buildServer();
  const viaHttp = await app.inject({ method: 'GET', url: `/tx?tx_hash=${sampleHash}&chain=base` });
  const body = viaHttp.json();
  check('GET /tx returns the V2 fields at top level', viaHttp.statusCode === 200 && body.tx_hash === sampleHash.toLowerCase()
    && body.status === 'confirmed' && typeof body.block_number === 'number' && typeof body.value_eth === 'number');
  const gone = await app.inject({ method: 'GET', url: `/tx?tx_hash=0x${'ab'.repeat(32)}&chain=base` });
  const goneBody = gone.json();
  check('GET /tx for an unknown hash returns 200 with status not_found and answer text',
    gone.statusCode === 200 && goneBody.status === 'not_found' && goneBody.tx_hash === `0x${'ab'.repeat(32)}`
      && goneBody.block_number === null && typeof goneBody.answer === 'string' && goneBody.answer.length > 40);
  const gasHttp = await app.inject({ method: 'GET', url: '/gas?chain=ethereum' });
  const gasBody = gasHttp.json();
  check('GET /gas returns the V2 fields at top level', gasHttp.statusCode === 200 && gasBody.chain === 'ethereum'
    && typeof gasBody.gas_price_gwei === 'number' && typeof gasBody.as_of === 'string');
  await app.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
