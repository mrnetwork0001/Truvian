/**
 * Live verification of both intent handlers against Base mainnet.
 * Picks a real recent transaction, runs ONCHAIN_TX_LOOKUP on it, checks the
 * fee-math invariant against the raw RPC receipt, then runs GAS_PRICE and
 * checks internal consistency. Exits non-zero on any failure.
 */
import { SUPPORTED_CHAINS, chainMeta, getClient, getRpcClients, type SupportedChain } from '../config/chains.js';
import { buildServer } from '../miner/server.js';
import { handleBalance, handleSupply, parseTokenRef, validateBalanceInput, validateSupplyInput } from '../miner/holdings.js';
import { fetchTokenList, nameKey, symbolKey } from '../miner/tokenList.js';
import { KNOWN_TOKENS, NATIVE_SYMBOLS } from '../config/tokens.js';
import { formatUnits, parseAbi } from 'viem';
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
  const laggingFull = await searchRpcs([ep(true, notFound), ep(false, async () => 'record')], ask);
  check('a record found by a later endpoint overrides a full-history "not found" (a lagging node)', laggingFull.found === 'record');
  const twoAgree = await searchRpcs([ep(true, notFound), ep(false, notFound), ep(true, async () => 'never asked')], ask);
  check('two "not found" answers, one from full history, prove absence', twoAgree.found === null && twoAgree.provenAbsent);
  const prunedFirstThenFull = await searchRpcs([ep(false, notFound), ep(true, notFound)], ask);
  check('the order of the two agreeing answers does not matter', prunedFirstThenFull.found === null && prunedFirstThenFull.provenAbsent);
  const fullAloneOthersDown = await searchRpcs([ep(true, notFound), ep(true, broken)], ask);
  check('a single full-history "not found" stands when no other endpoint answers',
    fullAloneOthersDown.found === null && fullAloneOthersDown.provenAbsent);
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

  // speed: a dead endpoint must not stall a lookup (validators score on a deadline)
  const timed = async (input: Record<string, string>) => {
    const started = Date.now();
    const outcome = await handleTxLookup(validateTxLookupInput(input)).then(() => 'found', (e) => (e instanceof IntentError ? e.code : 'error'));
    return { outcome, ms: Date.now() - started };
  };
  const knownHash = '0xa1c4b88b9ab5f6efc19a52f9d9d0c8ebd63023598f0bbbb7654bcdf44f7e2a36';
  const foundNoChain = await timed({ hash: knownHash });
  check('a known hash with no chain named is found across all chains within 5 s',
    foundNoChain.outcome === 'found' && foundNoChain.ms < 5_000, `${foundNoChain.ms} ms`);
  const unknownNoChain = await timed({ hash: `0x${'e1'.repeat(32)}` });
  check('an unknown hash with no chain named is answered within 8 s',
    unknownNoChain.outcome === 'TX_NOT_FOUND' && unknownNoChain.ms < 8_000, `${unknownNoChain.outcome} in ${unknownNoChain.ms} ms`);

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

  // --- WALLET_BALANCE_CHECK_GENERAL and TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL ---
  console.log('');
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
  // the node's own question keys for both intents
  const deposit = await handleBalance(validateBalanceInput({ address: '0x00000000219ab540356cBB839Cbe05303d7705Fa', chain: 'ethereum' }));
  const eth = getClient('ethereum');
  const depositRaw = await eth.getBalance({ address: '0x00000000219ab540356cBB839Cbe05303d7705Fa', blockNumber: BigInt(deposit.blockNumber) });
  check('native balance equals eth_getBalance at the anchoring block, decimals applied',
    deposit.balance_raw === depositRaw.toString() && deposit.balance_exact === formatUnits(depositRaw, 18) && deposit.token_symbol === 'ETH',
    `${deposit.balance_exact} ETH at block ${deposit.blockNumber}`);
  check('balance is a JSON number in whole units, as the intent types it', typeof deposit.balance === 'number' && Math.abs(deposit.balance - Number(formatUnits(depositRaw, 18))) < 1e-6);
  const ens = await handleBalance(validateBalanceInput({ address: 'vitalik.eth', chain: 'ethereum' }));
  const vitalik = await eth.getEnsAddress({ name: 'vitalik.eth' });
  check('an ENS name resolves on Ethereum before the read', ens.address.toLowerCase() === vitalik?.toLowerCase(), ens.address);
  const usdcBase = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: 'base', token: 'USDC' }));
  const usdcRaw = await getClient('base').readContract({ address: KNOWN_TOKENS.base!.USDC!.address, abi: erc20, functionName: 'balanceOf', args: ['0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A'], blockNumber: BigInt(usdcBase.blockNumber) });
  check('a token by symbol reads balanceOf on its contract, decimals applied', usdcBase.balance_raw === usdcRaw.toString()
    && usdcBase.balance_exact === formatUnits(usdcRaw, 6) && usdcBase.token_symbol === 'USDC', `${usdcBase.balance_exact} USDC`);
  const byAddr = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: '8453', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }));
  check('a token by contract address and chain id reads the same contract', byAddr.token_address === KNOWN_TOKENS.base!.USDC!.address && byAddr.token_symbol === 'USDC' && byAddr.chain === 'base', byAddr.token_symbol);
  const unknownToken = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: 'ethereum', token: 'NOTATOKEN' })).then(() => null, (e) => e);
  check('an unknown token symbol is refused, not guessed', unknownToken instanceof IntentError && unknownToken.code === 'INVALID_INPUT');

  for (const [key, address] of [['USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    ['WBTC (0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599) on Ethereum', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
    ['DAI (0x6B175474E89094C44Da98b954EedeAC495271d0F) on Ethereum', '0x6B175474E89094C44Da98b954EedeAC495271d0F']] as const) {
    const got = await handleSupply(validateSupplyInput({ token: key }));
    const [raw, dec] = await Promise.all([
      eth.readContract({ address, abi: erc20, functionName: 'totalSupply', blockNumber: BigInt(got.blockNumber) }),
      eth.readContract({ address, abi: erc20, functionName: 'decimals', blockNumber: BigInt(got.blockNumber) }),
    ]);
    check(`total supply for the node's key "${key.split(' ')[0]}" equals totalSupply() at the block, decimals applied`,
      got.total_supply_raw === raw.toString() && got.total_supply_exact === formatUnits(raw, dec) && typeof got.total_supply === 'number',
      `${got.total_supply_exact} ${got.token}`);
  }
  const supplyBySymbol = await handleSupply(validateSupplyInput({ token: 'USDC on Arbitrum' }));
  check('total supply by symbol and chain in words', supplyBySymbol.chain === 'arbitrum' && supplyBySymbol.token_address === KNOWN_TOKENS.arbitrum!.USDC!.address, `${supplyBySymbol.total_supply_exact} USDC on Arbitrum`);
  const nativeSupply = await handleSupply(validateSupplyInput({ token: 'ETH on Ethereum' })).then(() => null, (e) => e);
  check('a native coin is refused for total supply (no contract to read)', nativeSupply instanceof IntentError && nativeSupply.code === 'INVALID_INPUT');

  // How the node writes a token (nginx access log since registration 6146 went
  // active): "<name> (<symbol>) on <chain>", "<symbol> (<address>) on <chain>"
  // or "<address> on <chain>". The chain is the words after the last " on ".
  const refCases: Array<[string, SupportedChain, string | null, string | null, string | null]> = [
    ['Kelp DAO Restaked ETH (rsETH) on Ethereum', 'ethereum', null, 'rsETH', 'Kelp DAO Restaked ETH'],
    ['Bancor (BNT) on Ethereum', 'ethereum', null, 'BNT', 'Bancor'],
    ['0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6 on Polygon', 'polygon', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', null, null],
    ['USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', 'ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', null, null],
    ['Arbitrum (ARB) on Ethereum', 'ethereum', null, 'ARB', 'Arbitrum'],
    ['Brett (ETH) (BRETT) on Base', 'base', null, 'BRETT', 'Brett (ETH)'],
    ['What is the current total supply of Bancor (BNT) on Ethereum, in whole tokens?', 'ethereum', null, 'BNT', 'Bancor'],
    ['USDC on Arbitrum', 'arbitrum', null, 'USDC', 'USDC'],
  ];
  const refMisses = refCases.filter(([token, chain, address, symbol, name]) => {
    const got = validateSupplyInput({ token });
    return got.chain !== chain || got.ref.address !== address || got.ref.symbol !== symbol || got.ref.name !== name;
  });
  check('a token reference splits into address, or symbol and name, and the chain after its last " on "',
    refMisses.length === 0, refMisses.map(([t]) => t).join(' | '));
  check('a name in parentheses is not taken for a symbol', parseTokenRef('Polygon Bridged WBTC (Polygon POS)').symbol === null);
  const solana = (() => { try { validateSupplyInput({ token: 'Wrapped SOL (SOL) on Solana' }); return null; } catch (e) { return e; } })();
  check('a token on a chain this miner does not serve is refused, not read on Ethereum', solana instanceof IntentError && solana.code === 'CHAIN_UNSUPPORTED');

  // The node's real questions, each read here from the contract at the
  // answer's block: the figure must be totalSupply() with decimals() applied,
  // and the scored total_supply within the comparator's 50 bps.
  const nodeQuestions: Array<[string, SupportedChain, `0x${string}`]> = [
    ['Kelp DAO Restaked ETH (rsETH) on Ethereum', 'ethereum', '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7'],
    ['Bancor (BNT) on Ethereum', 'ethereum', '0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C'],
    ['0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6 on Polygon', 'polygon', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6'],
    ['USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', 'ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    // a name chooses between two listed UNI tokens (UNICORN and Uniswap)
    ['Uniswap (UNI) on Ethereum', 'ethereum', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'],
    // POL is Polygon's coin, but on Ethereum it is an ERC-20
    ['Polygon Ecosystem Token (POL) on Ethereum', 'ethereum', '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'],
    // MKR's symbol() returns bytes32, not a string
    ['Maker (MKR) on Ethereum', 'ethereum', '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2'],
    // CoinGecko lists it as USDC.E; the contract's symbol() says USDC
    ['Bridged USDC (USDC.e) on Arbitrum', 'arbitrum', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'],
  ];
  for (const [question, chain, address] of nodeQuestions) {
    try {
      const got = await handleSupply(validateSupplyInput({ token: question }));
      const c = getClient(chain);
      const [raw, dec] = await Promise.all([
        c.readContract({ address, abi: erc20, functionName: 'totalSupply', blockNumber: BigInt(got.blockNumber) }),
        c.readContract({ address, abi: erc20, functionName: 'decimals', blockNumber: BigInt(got.blockNumber) }),
      ]);
      const whole = Number(formatUnits(raw, dec));
      check(`"${question}" is totalSupply() of ${address} on ${chain} at the block, decimals applied`,
        got.chain === chain && got.token_address === address && got.total_supply_raw === raw.toString() && got.decimals === dec
          && got.total_supply_exact === formatUnits(raw, dec) && Math.abs(got.total_supply - whole) <= whole * 0.005,
        `${got.total_supply_exact} ${got.token} at block ${got.blockNumber}`);
    } catch (e: any) {
      check(`"${question}"`, false, e?.message ?? String(e));
    }
  }

  // A symbol the list gives to several tokens is refused, naming them, when
  // the name does not tell them apart. The case is taken from the live list,
  // so it holds while CoinGecko's entries change.
  const listed = await fetchTokenList('https://tokens.coingecko.com/ethereum/all.json', 1);
  const bySymbol = new Map<string, typeof listed>();
  for (const t of listed) bySymbol.set(symbolKey(t.symbol), [...(bySymbol.get(symbolKey(t.symbol)) ?? []), t]);
  const twins = [...bySymbol.entries()].find(([sym, sharing]) => /^[A-Z0-9]{2,10}$/.test(sym)
    && !NATIVE_SYMBOLS.has(sym) && !KNOWN_TOKENS.ethereum?.[sym]
    && new Set(sharing.map((t) => t.address.toLowerCase())).size > 1
    && sharing.every((t) => /^[A-Za-z0-9 .-]+$/.test(t.name) && nameKey(t.name) === nameKey(sharing[0]!.name)))?.[1];
  if (!twins) {
    check('found two listed Ethereum tokens with the same symbol and name', false);
  } else {
    const [twin] = twins as [typeof listed[number]];
    const addresses = [...new Set(twins.map((t) => t.address.toLowerCase()))];
    const refused = await handleSupply(validateSupplyInput({ token: `${twin.name} (${twin.symbol}) on Ethereum` })).then(() => null, (e) => e);
    check(`"${twin.name} (${twin.symbol}) on Ethereum", the symbol and name of ${addresses.length} listed tokens, is refused naming each`,
      refused instanceof IntentError && refused.code === 'INVALID_INPUT'
        && addresses.every((a) => refused.message.toLowerCase().includes(a)), refused?.message);
  }
  const unlisted = await handleSupply(validateSupplyInput({ token: 'Not A Token (ZZNOTATOKEN9) on Ethereum' })).then(() => null, (e) => e);
  check('a symbol no list holds is refused, not guessed', unlisted instanceof IntentError && unlisted.code === 'INVALID_INPUT', unlisted?.message);
  const noList = await handleSupply(validateSupplyInput({ token: 'Foo (FOO) on Sepolia' })).then(() => null, (e) => e);
  check('a symbol on a chain with no token list asks for the address', noList instanceof IntentError && noList.code === 'INVALID_INPUT', noList?.message);
  const listDown = await fetchTokenList('https://tokens.coingecko.com/no-such-platform/all.json', 1).then(() => null, (e) => e);
  check('a token list that cannot be fetched is an upstream error with its reason', listDown instanceof IntentError
    && listDown.code === 'UPSTREAM_RPC_ERROR' && listDown.message.includes('HTTP 403'), listDown?.message);
  const listStarted = Date.now();
  const listSilent = await fetchTokenList('http://10.255.255.1/all.json', 1, 1_000).then(() => null, (e) => e);
  check('a token list download is abandoned at its timeout', listSilent instanceof IntentError
    && listSilent.code === 'UPSTREAM_RPC_ERROR' && Date.now() - listStarted < 3_000, `${Date.now() - listStarted} ms: ${listSilent?.message}`);

  // every known token address still answers with the symbol and decimals in the table
  let tokenMismatches: string[] = [];
  for (const [chain, tokens] of Object.entries(KNOWN_TOKENS)) {
    for (const [sym, t] of Object.entries(tokens!)) {
      const c = getClient(chain as SupportedChain);
      const [onSym, onDec] = await Promise.all([
        c.readContract({ address: t.address, abi: erc20, functionName: 'symbol' }),
        c.readContract({ address: t.address, abi: erc20, functionName: 'decimals' }),
      ]).catch(() => ['?', -1] as const);
      const symOk = onSym === sym || (sym === 'USDT' && /^USD(₮|T)0$/.test(String(onSym)));
      if (!symOk || Number(onDec) !== t.decimals) tokenMismatches.push(`${chain} ${sym}: ${onSym}/${onDec}`);
    }
  }
  check('the known-token table matches every contract on-chain', tokenMismatches.length === 0, tokenMismatches.join(', '));

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
  // the node's own request, encoded as it sent it
  const kelpHttp = await app.inject({ method: 'GET', url: '/total-supply?token=Kelp+DAO+Restaked+ETH+%28rsETH%29+on+Ethereum' });
  const kelpBody = kelpHttp.json();
  check('GET /total-supply answers the node\'s rsETH question with total_supply as a JSON number', kelpHttp.statusCode === 200
    && kelpBody.token_address === '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7' && typeof kelpBody.total_supply === 'number' && kelpBody.total_supply > 0,
  `${kelpBody.total_supply} ${kelpBody.token}`);
  // a refusal says what the route needed, in the route's own terms
  const supplyRefusal = (await app.inject({ method: 'GET', url: '/total-supply?token=Not+A+Token+%28ZZNOTATOKEN9%29+on+Ethereum' })).json();
  check('a refused total-supply request is worded about a token, not a transaction', supplyRefusal.error === 'INVALID_INPUT'
    && supplyRefusal.answer.startsWith('The request did not identify an ERC-20 token whose total supply can be read.')
    && !/transaction/i.test(supplyRefusal.answer), supplyRefusal.answer);
  const balanceRefusal = (await app.inject({ method: 'GET', url: '/balance?address=0x123&chain=ethereum' })).json();
  check('a refused balance request is worded about a wallet balance, not a transaction', balanceRefusal.error === 'INVALID_INPUT'
    && balanceRefusal.answer.startsWith('The request did not identify a wallet and a token whose balance can be read.')
    && !/transaction/i.test(balanceRefusal.answer), balanceRefusal.answer);
  const txRefusal = (await app.inject({ method: 'GET', url: '/tx?tx_hash=0x123' })).json();
  check('a refused transaction lookup keeps its own wording', txRefusal.error === 'INVALID_INPUT'
    && txRefusal.answer.startsWith('The request did not identify a transaction to look up.'), txRefusal.answer);
  await app.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
