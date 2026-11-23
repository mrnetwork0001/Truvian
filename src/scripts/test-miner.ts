/**
 * Live verification of the intent handlers against public RPC.
 * Picks a real recent Base transaction, runs ONCHAIN_TX_LOOKUP on it and
 * checks the default reply's shape and provenance, then the raw fields of
 * ?detail=full, including the fee-math invariant, against the raw receipt;
 * then GAS_PRICE, WALLET_BALANCE_CHECK and TOKEN_TOTAL_SUPPLY_VERIFY.
 * Exits non-zero on any failure.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PUBLIC_RPC_TERMS, SUPPORTED_CHAINS, chainMeta, getClient, getRpcClients, type SupportedChain } from '../config/chains.js';
import { buildServer } from '../miner/server.js';
import {
  contractAnswered, handleBalance, handleSupply, parseTokenRef, readText, validateBalanceInput, validateSupplyInput,
} from '../miner/holdings.js';
import {
  LIST_BACKOFF_MS, LIST_TTL_MS, TokenListCache, TokenListUnavailable, fetchTokenList, findListedToken, listedTokens, symbolKey,
} from '../miner/tokenList.js';
import { nameAgreement, nameWords, type Agreement } from '../miner/tokenNames.js';
import { KNOWN_TOKENS, KNOWN_TOKEN_NAMES } from '../config/tokens.js';
import { createPublicClient, encodeAbiParameters, formatEther, formatUnits, http, parseAbi, stringToHex, type PublicClient } from 'viem';
import {
  SEARCH_CHAINS, chainFromText, executionOf, handleTxLookup, normalizeChain, searchRpcs, validateTxLookupInput,
} from '../miner/txLookup.js';
import { handleGasPrice, validateGasPriceInput } from '../miner/gasPrice.js';
import { parseTxStatus } from '../shield/verdict.js';
import { IntentError } from '../types/index.js';

let passes = 0;
let failures = 0;
let skips = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (cond) passes++;
  else failures++;
}

/** A check that could not be run, with why: counted apart from passes and failures. */
function skip(name: string, reason: string) {
  console.log(`⏭️  ${name} - skipped: ${reason}`);
  skips++;
}

/**
 * Whether CoinGecko refused this client (HTTP 429 or an HTML page) for a list
 * the check needs. Such a check is skipped, not failed: the refusal is about
 * how often the list was asked for, not about the miner.
 */
function listRefused(e: unknown): e is TokenListUnavailable {
  return e instanceof TokenListUnavailable && e.rateLimited;
}

interface StandInReply { status: number; type: string; body: string; headers?: Record<string, string> }
type StandInAnswer = StandInReply | 'hang';

/**
 * A stand-in for tokens.coingecko.com on a local port: each path answers as
 * `answers` says ('hang' never answers), and every request is counted.
 */
async function standInListHost() {
  const answers = new Map<string, StandInAnswer>();
  const asked = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    asked.set(path, (asked.get(path) ?? 0) + 1);
    const answer = answers.get(path);
    if (answer === 'hang') return;
    if (!answer) { res.writeHead(404).end(); return; }
    res.writeHead(answer.status, { 'content-type': answer.type, ...answer.headers }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    answers,
    asked: (path: string) => asked.get(path) ?? 0,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** What a stand-in JSON-RPC endpoint answers for eth_call to one contract. */
type RpcAnswer = { result: `0x${string}` } | { error: { code: number; message: string; data?: string } } | { http: number };

/**
 * A JSON-RPC endpoint on a local port. Each eth_call is answered as `answers`
 * says for the contract called (a result, a JSON-RPC error, or an HTTP
 * status), and calls are counted by contract.
 */
async function standInRpc(answers: Record<string, RpcAnswer>) {
  const calls = new Map<string, number>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      const to = String(msg.params?.[0]?.to ?? '').toLowerCase();
      calls.set(to, (calls.get(to) ?? 0) + 1);
      const answer = answers[to];
      if (!answer || 'http' in answer) { res.writeHead(answer ? answer.http : 404).end('unavailable'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    client: createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }) }) as unknown as PublicClient,
    calls: (address: string) => calls.get(address.toLowerCase()) ?? 0,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** How tokens.coingecko.com refused on 2026-11-21: HTTP 429 with an HTML page. */
const RATE_LIMIT_PAGE: StandInReply = {
  status: 429, type: 'text/html; charset=UTF-8',
  body: '<!DOCTYPE html><html><head><title>Too Many Requests</title></head><body>error code: 1015</body></html>',
};

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

  // The HTTP surface is the contract: ?detail=full is how the raw fields are reached.
  const app = buildServer();
  app.log.level = 'warn';
  const fullTx = async (chain: string, hash: string) =>
    (await app.inject({ method: 'GET', url: `/tx?chain=${chain}&tx_hash=${hash}&detail=full` })).json();

  // --- ONCHAIN_TX_LOOKUP: the default reply ---
  const txInput = validateTxLookupInput({ chain: 'base', txHash: sampleHash });
  const tx = await handleTxLookup(txInput);
  console.log(JSON.stringify(tx, null, 2), '\n');
  if (tx.status !== 'confirmed') throw new Error(`a mined, successful sample transaction was reported ${tx.status}`);

  const rawReceipt = await client.getTransactionReceipt({ hash: sampleHash });
  const rawL1Fee = BigInt((rawReceipt as any).l1Fee ?? 0);
  const rawTx = await client.getTransaction({ hash: sampleHash });

  // Telegraph V2 response format (GET /engine/v1/intents/ONCHAIN_TX_LOOKUP):
  // tx_hash, status, from, to, block_number (scored), value_eth
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
  check('V2 from/to are the receipt addresses, in lower case', tx.from === rawReceipt.from.toLowerCase()
    && tx.to === (rawReceipt.to ? rawReceipt.to.toLowerCase() : null), `${tx.from} -> ${tx.to}`);

  // concise: the intent's fields, the answer, verdict, confidence, time, the
  // receipt's outcome and cost, provenance; nothing raw
  const NOT_FOUND_KEYS = ['answer', 'block_number', 'chain', 'checked_at', 'confidence', 'from', 'provenance', 'status', 'to', 'tx_hash', 'value_eth', 'verdict'];
  const DEFAULT_KEYS = [...NOT_FOUND_KEYS, 'receipt'].sort();
  check('default reply has exactly the concise keys', JSON.stringify(Object.keys(tx).sort()) === JSON.stringify(DEFAULT_KEYS), Object.keys(tx).sort().join(','));
  check('default reply carries no raw fields or duplicates (signal, source, inputData, erc20Transfers, camelCase)',
    !Object.keys(tx).some((k) => /[A-Z]/.test(k) || ['signal', 'source', 'inputData', 'erc20Transfers'].includes(k)));
  check('default reply is concise: under 1,300 bytes', JSON.stringify(tx).length < 1_300, `${JSON.stringify(tx).length} bytes`);
  check('verdict and confidence state a successful mined transaction', tx.verdict === 'succeeded' && tx.confidence === 0.99, `${tx.verdict} ${tx.confidence}`);
  check('receipt summary is the receipt\'s status, gas used and total fee incl. the L1 fee',
    tx.receipt.execution_status === 'success' && tx.receipt.gas_used === rawReceipt.gasUsed.toString()
      && BigInt(tx.receipt.total_fee_wei) === rawReceipt.gasUsed * rawReceipt.effectiveGasPrice + rawL1Fee,
    `${tx.receipt.gas_used} gas, ${tx.receipt.total_fee_wei} wei`);
  const isIsoUtc = (s: unknown) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s);
  check('checked_at and provenance.read_at are ISO UTC times, read before checked',
    isIsoUtc(tx.checked_at) && isIsoUtc(tx.provenance.read_at) && tx.provenance.read_at <= tx.checked_at,
    `${tx.provenance.read_at} .. ${tx.checked_at}`);

  // provenance: which endpoints answered, which methods, the block hash, the terms
  const hostsOf = (name: SupportedChain) => new Set(getRpcClients(name).map(({ url }) => new URL(url).host));
  check('provenance block_hash is the receipt block hash', tx.provenance.block_hash === rawReceipt.blockHash.toLowerCase());
  check('provenance hosts are Base endpoints from src/config/chains.ts',
    tx.provenance.hosts.length > 0 && tx.provenance.hosts.every((h) => hostsOf('base').has(h)), tx.provenance.hosts.join(', '));
  check('provenance methods are the two reads the reply states',
    JSON.stringify(tx.provenance.methods) === JSON.stringify(['eth_getTransactionByHash', 'eth_getTransactionReceipt']), tx.provenance.methods.join(', '));
  check('provenance states the registry terms', JSON.stringify(tx.provenance.terms) === JSON.stringify(PUBLIC_RPC_TERMS));
  check('provenance lists no search when a chain was named', !('chains_searched' in tx.provenance) && !('reads' in tx.provenance));

  // answer: the outcome and block first, then sender, recipient and exact value
  check('answer present and number-first',
    tx.answer.startsWith(`Transaction ${tx.tx_hash} on Base (chain id 8453) succeeded in block ${tx.block_number}.`), tx.answer);
  check('answer names sender and recipient', tx.answer.includes(tx.from) && (tx.to === null || tx.answer.includes(tx.to)));
  check('answer states the exact value, in ETH and in wei', tx.answer.includes(`${formatEther(rawTx.value)} ETH (${rawTx.value} wei)`));
  check('Shield reads the answer as a success', parseTxStatus(tx.answer) === 'success');

  // --- ?detail=full: the default reply plus every raw field ---
  const full = await fullTx('base', sampleHash);
  check('detail=full keeps every default field', DEFAULT_KEYS.filter((k) => !['checked_at', 'provenance'].includes(k))
    .every((k) => JSON.stringify(full[k]) === JSON.stringify((tx as any)[k])));
  check('detail=full execution_status matches raw receipt', full.execution_status === rawReceipt.status, full.execution_status);
  check('detail=full blockNumber matches', full.blockNumber === rawReceipt.blockNumber.toString());
  check(
    'fee invariant: totalFee = gasUsed*effectiveGasPrice + l1Fee',
    BigInt(full.totalFeeWei) === rawReceipt.gasUsed * rawReceipt.effectiveGasPrice + rawL1Fee,
    `total=${full.totalFeeWei} l1=${full.l1FeeWei}`,
  );
  check('l1Fee captured on OP-stack chain', BigInt(full.l1FeeWei) === rawL1Fee, full.l1FeeWei);
  check('gasUsed and effectiveGasPrice are the receipt figures',
    full.gasUsed === rawReceipt.gasUsed.toString() && full.effectiveGasPrice === rawReceipt.effectiveGasPrice.toString());
  check('logCount matches', full.logCount === rawReceipt.logs.length, String(full.logCount));
  check('no JS numbers in wei fields', /^[0-9]+$/.test(full.totalFeeWei) && /^[0-9]+$/.test(full.valueWei));
  check(
    'transfer amounts are decimal strings',
    Array.isArray(full.erc20Transfers) && full.erc20Transfers.every((t: { amount: string }) => /^[0-9]+$/.test(t.amount)),
    `${full.erc20Transfers?.length} transfers decoded`,
  );
  check('detail=full inputData is the raw calldata', full.inputData === rawTx.input);
  check('detail=full signal is the answer plus the function selector', full.signal.startsWith(tx.answer)
    && (full.inputData === '0x' || full.signal.includes(`function selector ${full.inputData.slice(0, 10)}`)));
  check('detail=full keeps the receipt summary and its parts agree', JSON.stringify(full.receipt) === JSON.stringify(tx.receipt)
    && full.totalFeeWei === tx.receipt.total_fee_wei && full.gasUsed === tx.receipt.gas_used);
  check('scored answer stays in ground-truth scope (no fee numerics)', !tx.answer.includes(full.totalFeeWei));
  check('detail=full provenance adds each read, the tip read included',
    Array.isArray(full.provenance.reads) && full.provenance.reads.some((r: { method: string }) => r.method === 'eth_blockNumber')
    && full.provenance.methods.includes('eth_blockNumber'));

  // flexible input aliases
  const viaAlias = validateTxLookupInput({ chain: 'BASE', tx_hash: sampleHash });
  check('input aliases: tx_hash + case-insensitive chain', viaAlias.chain === 'base' && viaAlias.txHash === sampleHash.toLowerCase());
  const viaQuery = validateTxLookupInput({ query: `look up ${sampleHash} on base please` });
  check('input via natural-language query', viaQuery.txHash === sampleHash.toLowerCase());
  check('detail defaults to the concise reply; "full" is accepted in any case',
    viaAlias.detail === 'default' && validateTxLookupInput({ chain: 'base', tx_hash: sampleHash, detail: 'FULL' }).detail === 'full');

  // determinism: same input twice -> identical facts (the read times and the
  // answering endpoint are provenance, not facts)
  const tx2 = await handleTxLookup(txInput);
  const facts = ({ checked_at, provenance, ...rest }: Record<string, unknown>) => JSON.stringify(rest);
  check('deterministic: identical facts on repeat call', facts(tx as any) === facts(tx2 as any)
    && tx2.provenance.block_hash === tx.provenance.block_hash);

  // unknown tx: an answer in the intent's vocabulary, with the reads that prove it
  const missing = await handleTxLookup(validateTxLookupInput({ chain: 'base', txHash: `0x${'ab'.repeat(32)}` }));
  check('unknown tx -> status not_found with the hash and null fields', missing.status === 'not_found'
    && missing.tx_hash === `0x${'ab'.repeat(32)}` && missing.block_number === null && missing.from === null
    && missing.value_eth === null && missing.verdict === 'not_found' && missing.chain === 'base');
  check('not_found names the endpoints that proved absence',
    missing.provenance.hosts.length > 0 && missing.provenance.hosts.every((h) => hostsOf('base').has(h))
    && missing.provenance.methods.includes('eth_getTransactionByHash') && !('block_hash' in missing.provenance),
    missing.provenance.hosts.join(', '));
  check('Shield reads the not-found answer as not found', parseTxStatus(missing.answer) === 'not_found', missing.answer);

  // A reverted transaction keeps its block and says so in the intent's words
  // (Ethereum, block 26462180, found 2026-11-21).
  const rev = await handleTxLookup(validateTxLookupInput({ chain: 'ethereum', tx_hash: '0x67e131e375de08f4f4702d9cc8eb21f0a6ddb1f98789e773a941265f67942eaf' }));
  check('reverted tx: status reverted, verdict reverted, its block kept', rev.status === 'reverted' && rev.verdict === 'reverted'
    && rev.block_number === 26462180 && parseTxStatus(rev.answer) === 'reverted', `${rev.status} ${rev.block_number}`);
  check('a reverted tx is not said to have transferred anything',
    !/transferred|created contract/.test(rev.answer) && /execution was rolled back/.test(rev.answer)
      && rev.status === 'reverted' && rev.receipt.execution_status === 'reverted', rev.answer);

  // Before Byzantium (Ethereum block 4,370,000) receipts had no status field.
  // The first Ethereum transaction (block 46147) used to be reported reverted.
  const firstTx = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';
  const preByzantium = await handleTxLookup(validateTxLookupInput({ chain: 'ethereum', tx_hash: firstTx }));
  check('pre-Byzantium tx is confirmed with no recorded execution result, not reverted',
    preByzantium.status === 'confirmed' && preByzantium.block_number === 46147 && preByzantium.verdict === 'no_execution_result',
    `${preByzantium.status} ${preByzantium.verdict}`);
  check('pre-Byzantium answer says the receipt records no execution result, and Shield reads it as confirmed',
    /records no execution result/.test(preByzantium.answer) && !/revert|fail/i.test(preByzantium.answer)
    && parseTxStatus(preByzantium.answer) === 'success', preByzantium.answer);
  const preByzantiumFull = await fullTx('ethereum', firstTx);
  check('pre-Byzantium detail=full execution_status is not_recorded', preByzantiumFull.execution_status === 'not_recorded', preByzantiumFull.execution_status);
  // Endpoints disagree about that receipt: geth-style ones return `root` and no
  // `status`, others fill a status in from re-execution. Neither may change the answer.
  const statuses: string[] = [];
  for (const { url, client: c } of getRpcClients('ethereum')) {
    const r = await c.getTransactionReceipt({ hash: firstTx }).catch(() => null);
    if (r) statuses.push(`${new URL(url).host}: ${String(r.status)}`);
  }
  console.log(`   the block-46147 receipt's status per endpoint: ${statuses.join('; ') || 'none answered'}`);
  check('a receipt with no status is not recorded, on any chain, and never reads as a revert',
    executionOf('ethereum', { status: null, blockNumber: 46147n }) === 'not_recorded'
    && executionOf('base', { status: null, blockNumber: 30_000_000n }) === 'not_recorded');
  check('a status an endpoint fills in for a pre-Byzantium block is not taken as recorded',
    executionOf('ethereum', { status: 'success', blockNumber: 4_369_999n }) === 'not_recorded'
    && executionOf('ethereum', { status: 'reverted', blockNumber: 46147n }) === 'not_recorded');
  check('from Byzantium on, the receipt status is the outcome',
    executionOf('ethereum', { status: 'reverted', blockNumber: 4_370_000n }) === 'reverted'
    && executionOf('ethereum', { status: 'success', blockNumber: 26_000_000n }) === 'success'
    && executionOf('base', { status: 'reverted', blockNumber: 1_000n }) === 'reverted');

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

  // PUBLIC_RPC_TERMS says every endpoint is used without a key, account or payment
  const keyed = SUPPORTED_CHAINS.flatMap((name) => getRpcClients(name).map(({ url }) => new URL(url)))
    .filter((u) => u.username !== '' || u.password !== '' || u.search !== '' || /[A-Za-z0-9_-]{24,}/.test(u.pathname));
  check(`every registry endpoint is a public keyless URL, as PUBLIC_RPC_TERMS states ("${PUBLIC_RPC_TERMS.access}")`,
    keyed.length === 0, keyed.map(String).join(', '));

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
        `${name}: lookup by chain id returns the receipt's block, named endpoints and the value in ${chainMeta(name).nativeSymbol}`,
        got.block_number !== null && BigInt(got.block_number) === raw.blockNumber && got.chain === name
          && got.answer.includes(` ${chainMeta(name).nativeSymbol} (`)
          && got.provenance.hosts.length > 0 && got.provenance.hosts.every((h) => hostsOf(name).has(h)),
        `${got.status} block ${got.block_number} from ${got.provenance.hosts.join(', ')}`,
      );
      // the receipt's own l1Fee, where it has one, belongs in the total (OP-stack chains and Scroll)
      const rawL1 = BigInt((raw as any).l1Fee ?? 0);
      const gotFull = await fullTx(name, hash);
      check(
        `${name}: detail=full total fee = gasUsed * effectiveGasPrice + the receipt's L1 fee, as the default receipt states it`,
        gotFull.totalFeeWei !== undefined && BigInt(gotFull.totalFeeWei) === raw.gasUsed * raw.effectiveGasPrice + rawL1
          && got.status !== 'not_found' && got.status !== 'pending' && got.receipt.total_fee_wei === gotFull.totalFeeWei,
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
  const ep = (url: string, fullHistory: boolean, read: () => Promise<string>) => ({ url, fullHistory, client: { read } as any });
  const ask = (c: any) => c.read() as Promise<string>;
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const prunedThenFull = await searchRpcs([ep('a', false, notFound), ep('b', true, async () => 'record')], ask);
  check('a pruned endpoint\'s "not found" falls through to the next endpoint, which is named as the source',
    prunedThenFull.found === 'record' && same(prunedThenFull.answeredBy, ['b']));
  const laggingFull = await searchRpcs([ep('a', true, notFound), ep('b', false, async () => 'record')], ask);
  check('a record found by a later endpoint overrides a full-history "not found" (a lagging node)', laggingFull.found === 'record');
  const twoAgree = await searchRpcs([ep('a', true, notFound), ep('b', false, notFound), ep('c', true, async () => 'never asked')], ask);
  check('two "not found" answers, one from full history, prove absence, and both are named',
    twoAgree.found === null && twoAgree.provenAbsent && same(twoAgree.answeredBy, ['a', 'b']));
  const prunedFirstThenFull = await searchRpcs([ep('a', false, notFound), ep('b', true, notFound)], ask);
  check('the order of the two agreeing answers does not matter', prunedFirstThenFull.found === null && prunedFirstThenFull.provenAbsent);
  const fullAloneOthersDown = await searchRpcs([ep('a', true, notFound), ep('b', true, broken)], ask);
  check('a single full-history "not found" stands when no other endpoint answers',
    fullAloneOthersDown.found === null && fullAloneOthersDown.provenAbsent && same(fullAloneOthersDown.answeredBy, ['a']));
  const onlyPrunedAnswered = await searchRpcs([ep('a', true, broken), ep('b', false, notFound)], ask);
  check(
    'absence is not claimed when only a pruned endpoint answered, and no endpoint is named for it',
    onlyPrunedAnswered.found === null && !onlyPrunedAnswered.provenAbsent && onlyPrunedAnswered.error instanceof Error
      && onlyPrunedAnswered.answeredBy.length === 0,
  );
  const errorThenFound = await searchRpcs([ep('a', true, broken), ep('b', true, async () => 'record')], ask);
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
        // answers 4444 "pruned history unavailable" below about block
        // 48,000,000), and free tiers drop requests, so try several
        // neighbouring blocks.
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
          got.block_number !== null && BigInt(got.block_number) === sample.block,
          `${got.status} block ${got.block_number}`,
        );
        // A "not found" from an endpoint marked full history proves absence
        // (searchRpcs), so each one must still serve the year-old transaction
        // and its receipt. An error (a rate limit, a timeout) says nothing
        // about its history; only a "not found" makes the flag false. On
        // 2026-11-21 base-sepolia.drpc.org, then marked full history,
        // answered null for every Base Sepolia transaction older than about
        // 300 days, which could have turned a real transaction into not_found.
        if (days === 365) {
          const forgot: string[] = [];
          for (const e of getRpcClients(name).filter((r) => r.fullHistory)) {
            for (const read of [() => e.client.getTransaction({ hash: sample!.hash }), () => e.client.getTransactionReceipt({ hash: sample!.hash })]) {
              const err = await read().then(() => null, (x) => x);
              if (err?.name === 'TransactionNotFoundError' || err?.name === 'TransactionReceiptNotFoundError') forgot.push(`${new URL(e.url).host} (${err.name})`);
            }
          }
          check(`${name}: no endpoint marked full history calls the ${age} old transaction or its receipt absent`, forgot.length === 0, forgot.join(', '));
        }
      } catch (e: any) {
        check(`${name}: ${age} old transaction`, false, e?.message ?? String(e));
      }
    }
  }

  // speed: a dead endpoint must not stall a lookup (validators score on a deadline)
  const timed = async (input: Record<string, string>) => {
    const started = Date.now();
    const reply = await handleTxLookup(validateTxLookupInput(input)).catch((e) => e);
    const outcome: string = reply instanceof IntentError ? reply.code : reply instanceof Error ? 'error' : reply.status;
    return { reply, outcome, ms: Date.now() - started };
  };
  const knownHash = '0xa1c4b88b9ab5f6efc19a52f9d9d0c8ebd63023598f0bbbb7654bcdf44f7e2a36';
  const foundNoChain = await timed({ hash: knownHash });
  check('a known hash with no chain named is found across all chains within 5 s',
    foundNoChain.outcome === 'confirmed' && foundNoChain.reply.chain === 'ethereum' && foundNoChain.ms < 5_000,
    `${foundNoChain.outcome} in ${foundNoChain.ms} ms`);
  const unknownNoChain = await timed({ hash: `0x${'e1'.repeat(32)}` });
  check('an unknown hash with no chain named is answered not_found within 8 s',
    unknownNoChain.outcome === 'not_found' && unknownNoChain.ms < 8_000, `${unknownNoChain.outcome} in ${unknownNoChain.ms} ms`);
  if (unknownNoChain.outcome === 'not_found') {
    const p = unknownNoChain.reply.provenance;
    check('a no-chain not_found lists every chain searched and endpoints from more than one chain',
      unknownNoChain.reply.chain === null && JSON.stringify(p.chains_searched) === JSON.stringify(SEARCH_CHAINS)
        && p.hosts.some((h: string) => hostsOf('base').has(h)) && p.hosts.some((h: string) => hostsOf('ethereum').has(h)),
      `${p.hosts.length} hosts`);
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

  // --- WALLET_BALANCE_CHECK_GENERAL and TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL ---
  console.log('');
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function name() view returns (string)']);
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
  // a word given alone is answered from the verified table or refused, so a list refusal here would itself be a failure
  const unknownToken = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: 'ethereum', token: 'NOTATOKEN' })).then(() => null, (e) => e);
  check('an unknown token symbol is refused, not guessed', unknownToken instanceof IntentError && unknownToken.code === 'INVALID_INPUT'
    && unknownToken.message.includes('in parentheses'), unknownToken?.message);

  // A native symbol is the native coin only on its own chain. A "POL" balance
  // on Ethereum was answered in ETH; POL there is an ERC-20, found the way
  // total supply finds it (a word given alone: the verified table, which has
  // no POL on Ethereum, so it is refused).
  const holder = '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';
  const balanceOf = (chain: string, token: string) => handleBalance(validateBalanceInput({ address: holder, chain, token }))
    .then((r) => ({ symbol: r.token_symbol, address: r.token_address, err: null }), (err) => ({ symbol: null, address: null, err }));
  const [polOnEthereum, polOnPolygon, maticOnPolygon, ethOnPolygon, ethOnBase, bnbOnBsc, bnbOnEthereum] = await Promise.all([
    balanceOf('ethereum', 'POL'), balanceOf('polygon', 'POL'), balanceOf('polygon', 'MATIC'), balanceOf('polygon', 'ETH'),
    balanceOf('base', 'ETH'), balanceOf('bsc', 'BNB'), balanceOf('ethereum', 'BNB'),
  ]);
  check('a "POL" balance on Ethereum is not read as ETH: POL there is an ERC-20 the verified table lacks, so it is refused',
    polOnEthereum.err instanceof IntentError && polOnEthereum.err.code === 'INVALID_INPUT' && polOnEthereum.err.message.includes('in parentheses'),
    polOnEthereum.err?.message ?? `${polOnEthereum.symbol}`);
  check('"POL" and "MATIC" balances on Polygon are its native coin', polOnPolygon.symbol === 'POL' && polOnPolygon.address === null
    && maticOnPolygon.symbol === 'POL' && maticOnPolygon.address === null, `${polOnPolygon.symbol} ${maticOnPolygon.symbol}`);
  check('"ETH" is native on Base and "BNB" on BNB Smart Chain', ethOnBase.symbol === 'ETH' && ethOnBase.address === null
    && bnbOnBsc.symbol === 'BNB' && bnbOnBsc.address === null, `${ethOnBase.symbol} ${bnbOnBsc.symbol}`);
  check('"ETH" on Polygon and "BNB" on Ethereum are not read as those chains\' coins',
    ethOnPolygon.err instanceof IntentError && ethOnPolygon.err.code === 'INVALID_INPUT'
      && bnbOnEthereum.err instanceof IntentError && bnbOnEthereum.err.code === 'INVALID_INPUT',
    `${ethOnPolygon.err?.message ?? ethOnPolygon.symbol} | ${bnbOnEthereum.err?.message ?? bnbOnEthereum.symbol}`);
  const polByName = await handleBalance(validateBalanceInput({ address: holder, chain: 'ethereum', token: 'Polygon Ecosystem Token (POL)' }))
    .then((r) => r, (e) => e);
  const polName = 'a "Polygon Ecosystem Token (POL)" balance on Ethereum reads the POL ERC-20, the contract total supply reads';
  if (listRefused(polByName)) skip(polName, polByName.message);
  else check(polName, !(polByName instanceof Error) && polByName.token_address === '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'
    && polByName.token_symbol === 'POL', polByName?.message ?? polByName?.token_address);

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
  // [token, chain, address, symbol, symbol given alone (bare), name]
  const refCases: Array<[string, SupportedChain, string | null, string | null, boolean, string | null]> = [
    ['Kelp DAO Restaked ETH (rsETH) on Ethereum', 'ethereum', null, 'rsETH', false, 'Kelp DAO Restaked ETH'],
    ['Bancor (BNT) on Ethereum', 'ethereum', null, 'BNT', false, 'Bancor'],
    ['0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6 on Polygon', 'polygon', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', null, false, null],
    ['USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum', 'ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', true, null],
    ['USD Coin (USDC) (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Arbitrum', 'arbitrum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', false, 'USD Coin'],
    ['Arbitrum (ARB) on Ethereum', 'ethereum', null, 'ARB', false, 'Arbitrum'],
    ['Brett (ETH) (BRETT) on Base', 'base', null, 'BRETT', false, 'Brett (ETH)'],
    ['What is the current total supply of Bancor (BNT) on Ethereum, in whole tokens?', 'ethereum', null, 'BNT', false, 'Bancor'],
    ['(rsETH) on Ethereum', 'ethereum', null, 'rsETH', false, null],
    ['USDC on Arbitrum', 'arbitrum', null, 'USDC', true, null],
    ['Bitcoin on Ethereum', 'ethereum', null, 'Bitcoin', true, null],
    ['Kelp DAO Restaked ETH on Ethereum', 'ethereum', null, null, false, 'Kelp DAO Restaked ETH'],
  ];
  const refMisses = refCases.filter(([token, chain, address, symbol, bare, name]) => {
    const got = validateSupplyInput({ token });
    return got.chain !== chain || got.ref.address !== address || got.ref.symbol !== symbol || got.ref.bare !== bare || got.ref.name !== name;
  });
  check('a token reference splits into address, or symbol and name, and the chain after its last " on "',
    refMisses.length === 0, refMisses.map(([t]) => t).join(' | '));

  // A word given alone is answered only from the verified table, since it may
  // be a name as well as a symbol: "Bitcoin on Ethereum" was answered for the
  // meme token whose symbol is BITCOIN (0x72e4f9F8…, supply 1,000,000,000).
  // Words with no symbol at all are not looked up either.
  for (const question of ['Bitcoin on Ethereum', 'BNT on Ethereum', 'Kelp DAO Restaked ETH on Ethereum']) {
    const refused = await handleSupply(validateSupplyInput({ token: question })).then(() => null, (e) => e);
    check(`"${question}" is refused, asking for the symbol in parentheses or the contract address`,
      refused instanceof IntentError && refused.code === 'INVALID_INPUT' && refused.message.includes('in parentheses')
        && refused.message.includes('contract address'), refused?.message);
  }
  const listForWords = await listedTokens('ethereum').catch((e) => e);
  const wordsListed = 'CoinGecko\'s Ethereum list has the symbols BITCOIN and BNT, so those refusals are not for want of a listing';
  if (listRefused(listForWords)) skip(wordsListed, listForWords.message);
  else check(wordsListed, Array.isArray(listForWords) && ['BITCOIN', 'BNT'].every((s) => listForWords.some((t) => symbolKey(t.symbol) === s)));

  // A name given beside a symbol must agree with the token the symbol finds
  // (src/miner/tokenNames.ts): the same words 3, one a run of whole words
  // within the other 2, the same first word past the/wrapped/bridged 1.
  const agreementCases: Array<[string, string[], Agreement]> = [
    ['Kelp DAO Restaked ETH', ['Kelp DAO Restaked ETH'], 3],
    ['kelp-dao  restaked ETH', ['Kelp DAO Restaked ETH'], 3],
    ['Bancor', ['Bancor Network'], 2],
    ['Bridged USDC', ['Arbitrum Bridged USDC (Arbitrum)'], 2],
    ['(PoS) Wrapped BTC', ['Wrapped BTC'], 2],
    ['Lido Staked ETH', ['Lido Staked Ether'], 1],
    ['Tether USDt', ['Tether USD'], 1],
    ['USD₮0', ['USDT0'], 3],
    ['Uniswap', ['Bancor Network', 'BNT'], 0],
    ['Uniswap', ['UNICORN'], 0],
    ['Uni', ['Uniswap'], 0],
    ['Wrapped Bitcoin', ['Wrapped Ether', 'WETH'], 0],
    ['Polygon Ecosystem Token', ['POL (ex-MATIC)', 'POL'], 0],
  ];
  const agreementMisses = agreementCases.filter(([given, names, want]) => nameAgreement(given, names) !== want);
  check('names agree by the stated rule, and contradicting names do not', agreementMisses.length === 0,
    agreementMisses.map(([given, names, want]) => `${given} vs ${names.join('/')}: ${nameAgreement(given, names)}, wanted ${want}`).join(' | '));
  // "Uniswap (BNT)" gives Bancor's symbol with Uniswap's name; the verified
  // table's tokens are held to their names the same way.
  const contradictions: Array<[string, boolean]> = [
    ['Uniswap (BNT) on Ethereum', true], ['Uniswap (USDC) on Ethereum', false], ['Wrapped Bitcoin (WETH) on Base', false],
  ];
  for (const [question, needsList] of contradictions) {
    const refused = await handleSupply(validateSupplyInput({ token: question })).then(() => null, (e) => e);
    const name = `"${question}" is refused: the name contradicts the token its symbol finds`;
    if (needsList && listRefused(refused)) skip(name, refused.message);
    else check(name, refused instanceof IntentError && refused.code === 'INVALID_INPUT' && refused.message.includes('does not agree'), refused?.message);
  }
  for (const [question, address] of [['USD Coin (USDC) on Base', KNOWN_TOKENS.base!.USDC!.address],
    ['USDC (USDC) on Base', KNOWN_TOKENS.base!.USDC!.address], ['Tether (USDT) on Arbitrum', KNOWN_TOKENS.arbitrum!.USDT!.address],
    ['Wrapped Bitcoin (WBTC) on Polygon', KNOWN_TOKENS.polygon!.WBTC!.address]] as const) {
    const got = await handleSupply(validateSupplyInput({ token: question })).then((r) => r.token_address, (e) => `refused: ${e?.message}`);
    check(`"${question}" is answered from the verified table, its name agreeing`, got === address, got);
  }
  // The verified table holds one contract per symbol, so a name with words
  // added to the table's name is not taken for it: bridged twins are named
  // that way. Each was answered with the table contract's supply before
  // 2026-11-21. The table contract's own name(), read here directly, is not
  // the name given either, which is why the miner refuses.
  for (const [question, chain, symbol] of [['USD Coin (Wormhole) (USDC) on Ethereum', 'ethereum', 'USDC'],
    ['Tether USD (Wormhole) (USDT) on Ethereum', 'ethereum', 'USDT'], ['Bridged USDC (USDC) on Arbitrum', 'arbitrum', 'USDC']] as const) {
    const given = question.slice(0, question.lastIndexOf(` (${symbol})`));
    const ownName = await getClient(chain).readContract({ address: KNOWN_TOKENS[chain]![symbol]!.address, abi: erc20, functionName: 'name' })
      .catch((e) => `unread: ${e?.shortMessage ?? e}`);
    const refused = await handleSupply(validateSupplyInput({ token: question })).then((r) => r, (e) => e);
    check(`"${question}" is refused: the verified table's ${symbol} on ${chain} is named "${ownName}", not "${given}"`,
      nameAgreement(given, [String(ownName)]) !== 3 && refused instanceof IntentError && refused.code === 'INVALID_INPUT'
        && refused.message.includes('does not agree exactly'), refused?.message ?? `answered ${refused?.token_address}`);
  }
  const contradictedBalance = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: 'ethereum', token: 'Uniswap (USDC)' }))
    .then(() => null, (e) => e);
  check('a balance of "Uniswap (USDC)" is refused the same way', contradictedBalance instanceof IntentError
    && contradictedBalance.code === 'INVALID_INPUT' && contradictedBalance.message.includes('does not agree'), contradictedBalance?.message);
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
    // 2026-11-21 08:32:40 UTC: Ethereum's USDC address with Arbitrum named,
    // where that address has no code; the symbol is read from the verified table
    ['USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Arbitrum', 'arbitrum', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
    // a name chooses between two listed UNI tokens (UNICORN and Uniswap)
    ['Uniswap (UNI) on Ethereum', 'ethereum', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'],
    // POL is Polygon's coin, but on Ethereum it is an ERC-20
    ['Polygon Ecosystem Token (POL) on Ethereum', 'ethereum', '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'],
    // MKR's symbol() returns bytes32, not a string
    ['Maker (MKR) on Ethereum', 'ethereum', '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2'],
    // CoinGecko lists it as USDC.E; the contract's symbol() says USDC
    ['Bridged USDC (USDC.e) on Arbitrum', 'arbitrum', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'],
    // two listed LUSD tokens: Liquity's is "Liquity USD" in the list and
    // "LUSD Stablecoin" by its name(); the list names alone chose 0x31a2E08F… ("LUSD")
    ['LUSD Stablecoin (LUSD) on Ethereum', 'ethereum', '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0'],
    // 2026-11-23 02:15 UTC and earlier: words given alone, answered from the
    // verified table (they were refused until AAVE, PEPE and STORJ were added)
    ['Aave on Ethereum', 'ethereum', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9'],
    ['PEPE on Ethereum', 'ethereum', '0x6982508145454Ce325dDbE47a25d4ec3d2311933'],
    ['STORJ on Ethereum', 'ethereum', '0xB64ef51C888972c908CFacf59B47C1AfBC0Ab8aC'],
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
      if (listRefused(e)) skip(`"${question}"`, e.message);
      else check(`"${question}"`, false, e?.message ?? String(e));
    }
  }

  // Why LUSD Stablecoin is Liquity's: read directly, at the answer's block,
  // its name() is the name given and the other listed LUSD's is not.
  const lusd = await handleSupply(validateSupplyInput({ token: 'LUSD Stablecoin (LUSD) on Ethereum' })).then((r) => r, (e) => e);
  const lusdName = 'the listed LUSD chosen is the one whose own name() is "LUSD Stablecoin" at the answer\'s block, and the source says so';
  if (listRefused(lusd)) {
    skip(lusdName, lusd.message);
  } else if (lusd instanceof Error) {
    check(lusdName, false, lusd.message);
  } else {
    const at = BigInt(lusd.blockNumber);
    const [liquity, other] = await Promise.all(['0x5f98805A4E8be255a32880FDeC7F6728C6568bA0', '0x31a2E08F4232329e4EddB025C0275f43c9cD56D7']
      .map((address) => eth.readContract({ address: address as `0x${string}`, abi: erc20, functionName: 'name', blockNumber: at })));
    check(lusdName, nameAgreement('LUSD Stablecoin', [liquity!]) === 3 && nameAgreement('LUSD Stablecoin', [other!]) !== 3
      && lusd.source.includes('by its name() "LUSD Stablecoin"'), `${liquity} / ${other}; ${lusd.source}`);
  }

  // Choosing between listed tokens that share a symbol, against a stand-in
  // list and stand-in name() answers: an exact name() chooses, two exact
  // names are refused, and a chain that does not answer is an upstream error.
  {
    const twinsHost = await standInListHost();
    const a = '0x00000000000000000000000000000000000000a1';
    const b = '0x00000000000000000000000000000000000000b2';
    twinsHost.answers.set('/ethereum/all.json', { status: 200, type: 'application/json', body: JSON.stringify({ tokens: [
      { chainId: 1, address: a, name: 'Alpha Dollar', symbol: 'TWIN', decimals: 18 },
      { chainId: 1, address: b, name: 'TWIN', symbol: 'TWIN', decimals: 18 },
    ] }) });
    const twinLists = new TokenListCache(twinsHost.base);
    const ownNames = (names: Record<string, string | null | Error>) => async (address: `0x${string}`) => {
      const n = names[address.toLowerCase()];
      if (n instanceof Error) throw n;
      return n ?? null;
    };
    const pick = (name: string, names: Record<string, string | null | Error>) =>
      findListedToken('ethereum', 'TWIN', name, twinLists, ownNames(names)).then((m) => m, (e) => e);
    const byOwnName = await pick('Twin Stablecoin', { [a]: 'Twin Stablecoin', [b]: 'twin' });
    check('a name() that is exactly the name given chooses among tokens sharing a symbol, over a list name that only contains it',
      !(byOwnName instanceof Error) && byOwnName.token.address.toLowerCase() === a && byOwnName.chosenByName === 'Twin Stablecoin',
      byOwnName?.message ?? byOwnName?.token?.address);
    const twoExact = await pick('Twin Stablecoin', { [a]: 'Twin Stablecoin', [b]: 'TWIN-STABLECOIN' });
    check('two tokens whose names are exactly the name given are refused, naming both',
      twoExact instanceof IntentError && twoExact.code === 'INVALID_INPUT' && twoExact.message.toLowerCase().includes(a)
        && twoExact.message.toLowerCase().includes(b.slice(2)), twoExact?.message);
    const chainSilent = await pick('Twin Stablecoin', { [a]: 'Twin Stablecoin', [b]: new IntentError('UPSTREAM_RPC_ERROR', 'no endpoint answered') });
    check('a name() the chain did not answer is an upstream error, not a choice made without it',
      chainSilent instanceof IntentError && chainSilent.code === 'UPSTREAM_RPC_ERROR', chainSilent?.message);
    const noExact = await pick('Alpha', { [a]: 'Something Else', [b]: null });
    check('with no exact name, the list names still choose as before ("Alpha" in "Alpha Dollar")',
      !(noExact instanceof Error) && noExact.token.address.toLowerCase() === a && noExact.chosenByName === null, noExact?.message);
    await twinsHost.close();
  }

  // A given address with no code on the named chain is no contract there.
  // A symbol beside it is then read from the verified table only, and the
  // answer says so; without a symbol the table holds, the question is refused.
  const ethUsdcOnArbitrum = await handleSupply(validateSupplyInput({ token: 'USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Arbitrum' }))
    .then((r) => r.answer, (e) => `refused: ${e?.message}`);
  check('the answer says the given address is not a contract on Arbitrum, so the symbol was used',
    ethUsdcOnArbitrum.includes('The given address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 is not a contract on Arbitrum One, so the symbol USDC was used'),
    ethUsdcOnArbitrum);
  const balanceOnArbitrum = await handleBalance(validateBalanceInput({ address: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', chain: 'arbitrum', token: 'USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)' }))
    .then((r) => r, (e) => e);
  check('a balance by another chain\'s address reads the verified table\'s contract for the symbol, saying so',
    !(balanceOnArbitrum instanceof Error) && balanceOnArbitrum.token_address === KNOWN_TOKENS.arbitrum!.USDC!.address
      && balanceOnArbitrum.answer.includes('is not a contract on Arbitrum One'), balanceOnArbitrum?.answer ?? balanceOnArbitrum?.message);
  for (const [question, says] of [['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on Arbitrum', 'has no code there'],
    ['BNT (0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C) on Arbitrum', 'BNT is not in the verified token table for Arbitrum One'],
    ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D on Ethereum', 'does not answer decimals() and symbol() like an ERC-20']] as const) {
    const refused = await handleSupply(validateSupplyInput({ token: question })).then(() => null, (e) => e);
    check(`"${question}" is refused: ${says}`, refused instanceof IntentError && refused.code === 'INVALID_INPUT' && refused.message.includes(says), refused?.message);
  }

  // A symbol the list gives to several tokens is refused, naming them, when
  // the name does not tell them apart. The case is taken from the live list,
  // so it holds while CoinGecko's entries change.
  const listed = await listedTokens('ethereum').catch((e) => e);
  if (listRefused(listed)) {
    skip('a symbol and name shared by two listed tokens is refused, naming each', listed.message);
  } else if (!Array.isArray(listed)) {
    check('the Ethereum token list is held', false, listed?.message ?? String(listed));
  } else {
    const bySymbol = new Map<string, typeof listed>();
    for (const t of listed) bySymbol.set(symbolKey(t.symbol), [...(bySymbol.get(symbolKey(t.symbol)) ?? []), t]);
    const twins = [...bySymbol.entries()].find(([sym, sharing]) => /^[A-Z0-9]{2,10}$/.test(sym)
      && sym !== chainMeta('ethereum').nativeSymbol && sym !== 'NATIVE' && !KNOWN_TOKENS.ethereum?.[sym]
      && new Set(sharing.map((t) => t.address.toLowerCase())).size > 1
      && sharing.every((t) => /^[A-Za-z0-9 .-]+$/.test(t.name) && nameWords(t.name).join(' ') === nameWords(sharing[0]!.name).join(' ')))?.[1];
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
  }
  const unlisted = await handleSupply(validateSupplyInput({ token: 'Not A Token (ZZNOTATOKEN9) on Ethereum' })).then(() => null, (e) => e);
  if (listRefused(unlisted)) skip('a symbol no list holds is refused, not guessed', unlisted.message);
  else check('a symbol no list holds is refused, not guessed', unlisted instanceof IntentError && unlisted.code === 'INVALID_INPUT', unlisted?.message);
  const noList = await handleSupply(validateSupplyInput({ token: 'Foo (FOO) on Sepolia' })).then(() => null, (e) => e);
  check('a symbol on a chain with no token list asks for the address', noList instanceof IntentError && noList.code === 'INVALID_INPUT', noList?.message);

  // Token list downloads that fail, against a local stand-in for the host.
  const host = await standInListHost();
  const listBody = (chainId: number) => JSON.stringify({
    tokens: [{ chainId, address: '0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c', name: 'Bancor Network', symbol: 'BNT', decimals: 18 }],
  });
  const unavailable = (e: unknown): e is TokenListUnavailable => e instanceof TokenListUnavailable && e.code === 'UPSTREAM_RPC_ERROR';
  const fetchError = (path: string, timeoutMs?: number) => fetchTokenList(`${host.base}${path}`, 1, timeoutMs).then(() => null, (e) => e);
  host.answers.set('/denied.json', { status: 403, type: 'application/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>' });
  const denied = await fetchError('/denied.json');
  check('a list answered with HTTP 403 is an upstream error with its reason, and no rate limit', unavailable(denied)
    && denied.message.includes('HTTP 403') && !denied.rateLimited, denied?.message);
  host.answers.set('/limited.json', RATE_LIMIT_PAGE);
  const limited = await fetchError('/limited.json');
  check('HTTP 429 with an HTML page is a rate limit', unavailable(limited) && limited.rateLimited && limited.message.includes('HTTP 429'), limited?.message);
  host.answers.set('/challenge.json', { status: 200, type: 'text/html', body: '<html><body>Just a moment...</body></html>' });
  const challenge = await fetchError('/challenge.json');
  check('an HTML page answered with 200 is a refusal, not a list', unavailable(challenge) && challenge.rateLimited && challenge.message.includes('HTML page'), challenge?.message);
  host.answers.set('/text.json', { status: 200, type: 'text/plain', body: 'tokens: none' });
  const notJson = await fetchError('/text.json');
  check('a body that is not JSON is a failure, and no rate limit', unavailable(notJson) && !notJson.rateLimited && notJson.message.includes('not JSON'), notJson?.message);
  host.answers.set('/silent.json', 'hang');
  const silentStarted = Date.now();
  const silent = await fetchError('/silent.json', 500);
  check('a download is abandoned at its timeout', unavailable(silent) && Date.now() - silentStarted < 2_000,
    `${Date.now() - silentStarted} ms: ${silent?.message}`);

  // The cache, on a clock the test moves: a failed download is not repeated
  // until its backoff has passed, and a stale copy answers meanwhile.
  let clock = 1_800_000_000_000;
  const lists = new TokenListCache(host.base, () => clock);
  const listError = (chain: SupportedChain) => lists.get(chain).then(() => null, (e) => e);
  host.answers.set('/ethereum/all.json', RATE_LIMIT_PAGE);
  const refusedFirst = await listError('ethereum');
  const refusedStarted = Date.now();
  const refusedAgain = await listError('ethereum');
  check('after a 429 the list is not asked for again within the backoff, and the refusal says for how long',
    unavailable(refusedFirst) && unavailable(refusedAgain) && refusedAgain.rateLimited && host.asked('/ethereum/all.json') === 1
      && refusedAgain.message.includes(`not asked for again for another ${LIST_BACKOFF_MS / 1000} s`) && Date.now() - refusedStarted < 100,
    refusedAgain?.message);
  const otherChain = await listError('base');
  check('a 429 holds back every chain\'s list, since it refuses this client', unavailable(otherChain) && otherChain.rateLimited
    && host.asked('/base/all.json') === 0, otherChain?.message);
  clock += LIST_BACKOFF_MS;
  host.answers.set('/ethereum/all.json', { status: 200, type: 'application/json', body: listBody(1) });
  const recovered = await lists.get('ethereum');
  check('once the backoff has passed the list is asked for again', recovered.tokens.length === 1 && host.asked('/ethereum/all.json') === 2);
  clock += LIST_TTL_MS;
  host.answers.set('/ethereum/all.json', RATE_LIMIT_PAGE);
  const staleFirst = await lists.get('ethereum');
  await new Promise((resolve) => setTimeout(resolve, 200)); // the refresh it started is refused meanwhile
  const staleAgain = await lists.get('ethereum');
  check('a stale copy answers through a refused refresh, which is not repeated within the backoff',
    staleFirst === recovered && staleAgain === recovered && host.asked('/ethereum/all.json') === 3);
  host.answers.set('/arbitrum-one/all.json', { ...RATE_LIMIT_PAGE, headers: { 'retry-after': '300' } });
  const lists2 = new TokenListCache(host.base, () => clock);
  await lists2.get('arbitrum').catch(() => undefined);
  clock += LIST_BACKOFF_MS + 1_000;
  const withinRetryAfter = await lists2.get('arbitrum').then(() => null, (e) => e);
  clock += 300_000 - LIST_BACKOFF_MS;
  host.answers.set('/arbitrum-one/all.json', { status: 200, type: 'application/json', body: listBody(42161) });
  const afterRetryAfter = await lists2.get('arbitrum').then((l) => l.tokens.length, (e) => e);
  check('a Retry-After longer than the backoff is honoured', unavailable(withinRetryAfter) && afterRetryAfter === 1
    && host.asked('/arbitrum-one/all.json') === 2, withinRetryAfter?.message);
  host.answers.set('/polygon-pos/all.json', { status: 403, type: 'application/xml', body: '<Error/>' });
  host.answers.set('/binance-smart-chain/all.json', { status: 200, type: 'application/json', body: listBody(56) });
  const lists3 = new TokenListCache(host.base, () => clock);
  await lists3.get('polygon').catch(() => undefined);
  const unaffected = await lists3.get('bsc').then((l) => l.tokens.length, (e) => e);
  check('a failure that is no refusal of this client holds back only its own list', unaffected === 1, String(unaffected));
  await host.close();

  // symbol() is read again as bytes32 only when its answer did not decode as
  // a string, and only the contract's own answer counts against the token.
  const contract = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
  const rpc = await standInRpc({
    [contract(1)]: { result: encodeAbiParameters([{ type: 'string' }], ['USDC']) },
    [contract(2)]: { result: stringToHex('MKR', { size: 32 }) },
    [contract(3)]: { error: { code: -32000, message: 'header not found' } },
    [contract(4)]: { http: 503 },
    [contract(5)]: { error: { code: 3, message: 'execution reverted', data: '0x' } },
    [contract(6)]: { result: '0x' },
  });
  const symbolOf = (n: number) => readText(rpc.client, contract(n), 'symbol', 1n).then((text) => ({ text, err: null }), (err) => ({ text: null, err }));
  const [asText, asWord, rpcError, httpError, reverted, empty] = await Promise.all([1, 2, 3, 4, 5, 6].map(symbolOf));
  check('a string symbol() is read in one call', asText!.text === 'USDC' && rpc.calls(contract(1)) === 1, String(asText!.text));
  check('a bytes32 symbol() is read again as bytes32 after the string fails to decode', asWord!.text === 'MKR' && rpc.calls(contract(2)) === 2,
    String(asWord!.text ?? asWord!.err?.shortMessage));
  check('a JSON-RPC error is not retried as bytes32 and says nothing about the contract',
    rpcError!.err !== null && !contractAnswered(rpcError!.err) && rpc.calls(contract(3)) === 1, rpcError!.err?.shortMessage);
  check('an HTTP failure is not retried as bytes32 and says nothing about the contract',
    httpError!.err !== null && !contractAnswered(httpError!.err) && rpc.calls(contract(4)) === 1, httpError!.err?.shortMessage);
  check('a revert is not retried as bytes32 and is the contract\'s own answer',
    reverted!.err !== null && contractAnswered(reverted!.err) && rpc.calls(contract(5)) === 1, reverted!.err?.shortMessage);
  check('an empty answer is not retried as bytes32 and is the contract\'s own answer',
    empty!.err !== null && contractAnswered(empty!.err) && rpc.calls(contract(6)) === 1, empty!.err?.shortMessage);
  await rpc.close();
  const mkrSymbol = await readText(getClient('ethereum'), '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', 'symbol', await eth.getBlockNumber())
    .catch((e) => `failed: ${e?.shortMessage ?? e}`);
  check('MKR\'s bytes32 symbol() reads as MKR on Ethereum', mkrSymbol === 'MKR', mkrSymbol);

  // every known token address still answers with the symbol and decimals in
  // the table, and with a name() that agrees with the table's names for it
  let tokenMismatches: string[] = [];
  for (const [chain, tokens] of Object.entries(KNOWN_TOKENS)) {
    for (const [sym, t] of Object.entries(tokens!)) {
      const c = getClient(chain as SupportedChain);
      const [onSym, onDec, onName] = await Promise.all([
        c.readContract({ address: t.address, abi: erc20, functionName: 'symbol' }),
        c.readContract({ address: t.address, abi: erc20, functionName: 'decimals' }),
        c.readContract({ address: t.address, abi: erc20, functionName: 'name' }),
      ]).catch(() => ['?', -1, '?'] as const);
      // keys are symbolKey()s, as the lookup makes them: stETH and cbETH are keyed STETH and CBETH
      const symOk = symbolKey(String(onSym)) === sym || (sym === 'USDT' && /^USD(₮|T)0$/.test(String(onSym)));
      const nameOk = nameAgreement(String(onName), KNOWN_TOKEN_NAMES[sym] ?? []) > 0;
      if (!symOk || !nameOk || Number(onDec) !== t.decimals) tokenMismatches.push(`${chain} ${sym}: ${onSym}/${onDec}/${onName}`);
    }
  }
  check('the known-token table matches every contract on-chain', tokenMismatches.length === 0, tokenMismatches.join(', '));

  // --- HTTP surface: the exact bodies the node reads through intent_mapping ---
  console.log('');
  const viaHttp = await app.inject({ method: 'GET', url: `/tx?tx_hash=${sampleHash}&chain=base` });
  const body = viaHttp.json();
  check('GET /tx returns the V2 fields at top level', viaHttp.statusCode === 200 && body.tx_hash === sampleHash.toLowerCase()
    && body.status === 'confirmed' && typeof body.block_number === 'number' && typeof body.value_eth === 'number');
  check('GET /tx returns the concise reply by default', JSON.stringify(Object.keys(body).sort()) === JSON.stringify(DEFAULT_KEYS)
    && typeof body.provenance?.block_hash === 'string', Object.keys(body).sort().join(','));
  const gone = await app.inject({ method: 'GET', url: `/tx?tx_hash=0x${'ab'.repeat(32)}&chain=base` });
  const goneBody = gone.json();
  check('GET /tx for an unknown hash returns 200 with status not_found, answer text and provenance',
    gone.statusCode === 200 && goneBody.status === 'not_found' && goneBody.tx_hash === `0x${'ab'.repeat(32)}`
      && goneBody.block_number === null && typeof goneBody.answer === 'string' && goneBody.answer.length > 40
      && JSON.stringify(Object.keys(goneBody).sort()) === JSON.stringify(NOT_FOUND_KEYS) && goneBody.provenance.hosts.length > 0);
  const goneFull = await fullTx('base', `0x${'ab'.repeat(32)}`);
  check('GET /tx?detail=full for an unknown hash adds the raw fields it has', goneFull.status === 'not_found'
    && goneFull.chainId === 8453 && goneFull.txHash === `0x${'ab'.repeat(32)}` && Array.isArray(goneFull.provenance.reads));
  const typo = await app.inject({ method: 'GET', url: `/tx?tx_hash=${sampleHash}&chain=base&detail=everything` });
  check('an unknown detail value is refused with answer text, not ignored', typo.statusCode === 200 && typo.json().error === 'INVALID_INPUT');
  const gasHttp = await app.inject({ method: 'GET', url: '/gas?chain=ethereum' });
  const gasBody = gasHttp.json();
  check('GET /gas returns the V2 fields at top level', gasHttp.statusCode === 200 && gasBody.chain === 'ethereum'
    && typeof gasBody.gas_price_gwei === 'number' && typeof gasBody.as_of === 'string');
  // The routes share this process's lists: when CoinGecko refuses the
  // Ethereum list, the two requests that need it are skipped.
  const ethListForHttp = await listedTokens('ethereum').then(() => null, (e) => e);
  // the node's own request, encoded as it sent it
  const kelpName = 'GET /total-supply answers the node\'s rsETH question with total_supply as a JSON number';
  if (listRefused(ethListForHttp)) {
    skip(kelpName, ethListForHttp.message);
  } else {
    const kelpHttp = await app.inject({ method: 'GET', url: '/total-supply?token=Kelp+DAO+Restaked+ETH+%28rsETH%29+on+Ethereum' });
    const kelpBody = kelpHttp.json();
    check(kelpName, kelpHttp.statusCode === 200 && kelpBody.token_address === '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7'
      && typeof kelpBody.total_supply === 'number' && kelpBody.total_supply > 0, `${kelpBody.total_supply} ${kelpBody.token}`);
  }
  // a refusal says what the route needed, in the route's own terms
  const supplyRefusalName = 'a refused total-supply request is worded about a token, not a transaction';
  if (listRefused(ethListForHttp)) {
    skip(supplyRefusalName, ethListForHttp.message);
  } else {
    const supplyRefusal = (await app.inject({ method: 'GET', url: '/total-supply?token=Not+A+Token+%28ZZNOTATOKEN9%29+on+Ethereum' })).json();
    check(supplyRefusalName, supplyRefusal.error === 'INVALID_INPUT'
      && supplyRefusal.answer.startsWith('The request did not identify an ERC-20 token whose total supply can be read.')
      && !/transaction/i.test(supplyRefusal.answer), supplyRefusal.answer);
  }
  const bitcoinHttp = await app.inject({ method: 'GET', url: '/total-supply?token=Bitcoin+on+Ethereum' });
  const bitcoinBody = bitcoinHttp.json();
  check('GET /total-supply for "Bitcoin on Ethereum" answers 200 with a refusal that asks for the symbol in parentheses',
    bitcoinHttp.statusCode === 200 && bitcoinBody.resolved === false && bitcoinBody.error === 'INVALID_INPUT'
      && bitcoinBody.total_supply === undefined && bitcoinBody.answer.includes('in parentheses'), bitcoinBody.answer);
  const balanceRefusal = (await app.inject({ method: 'GET', url: '/balance?address=0x123&chain=ethereum' })).json();
  check('a refused balance request is worded about a wallet balance, not a transaction', balanceRefusal.error === 'INVALID_INPUT'
    && balanceRefusal.answer.startsWith('The request did not identify a wallet and a token whose balance can be read.')
    && !/transaction/i.test(balanceRefusal.answer), balanceRefusal.answer);
  const txRefusal = (await app.inject({ method: 'GET', url: '/tx?tx_hash=0x123' })).json();
  check('a refused transaction lookup keeps its own wording', txRefusal.error === 'INVALID_INPUT'
    && txRefusal.answer.startsWith('The request did not identify a transaction to look up.'), txRefusal.answer);

  // --- CRYPTO_TRANSFER_VERIFY: every figure against the chain, read here directly ---
  console.log('');
  const erc20Meta = parseAbi(['function decimals() view returns (uint8)']);
  // 2026-11-23: a SKY transfer on Ethereum, and a Base transaction that pays an L1 data fee
  const transferCases: Array<[string, SupportedChain]> = [
    ['0xcb9fc3f74716db681a532d561c0010e47921fa1223c427af39b9ba64bec05ac6', 'ethereum'],
    ['0xe7eb427edfb13ceb9360010478848821107f50e5154dca03bf24225927d3d7a6', 'base'],
  ];
  for (const [hash, chain] of transferCases) {
    const got = (await app.inject({ method: 'GET', url: `/transfer?tx_hash=${hash}&chain=${chain}` })).json();
    const c = getClient(chain);
    const receipt = await c.getTransactionReceipt({ hash: hash as `0x${string}` });
    const block = await c.getBlock({ blockHash: receipt.blockHash });
    const l1 = BigInt((receipt as any).l1Fee ?? 0);
    const total = receipt.gasUsed * receipt.effectiveGasPrice + l1;
    const burned = block.baseFeePerGas === null || block.baseFeePerGas === undefined ? null : receipt.gasUsed * block.baseFeePerGas;
    check(`/transfer ${chain}: settled, block, sender and recipient match the receipt`,
      got.status === 'confirmed' && got.settled === true && got.block_number === Number(receipt.blockNumber)
        && got.from === receipt.from.toLowerCase() && got.to === receipt.to?.toLowerCase(), got.answer);
    check(`/transfer ${chain}: the fee is gasUsed x effectiveGasPrice + l1Fee, and the burned part is baseFee x gasUsed`,
      got.fee_total_native === formatEther(total) && got.fee_l1_native === formatEther(l1)
        && got.fee_burned_native === (burned === null ? null : formatEther(burned)), `${got.fee_total_native} / burned ${got.fee_burned_native}`);
    check(`/transfer ${chain}: confirmations count the block itself and are at least 1`, Number.isInteger(got.confirmations) && got.confirmations >= 1, String(got.confirmations));
    const first = got.token_transfers?.[0];
    if (first) {
      const dec = await c.readContract({ address: first.token, abi: erc20Meta, functionName: 'decimals' });
      check(`/transfer ${chain}: a token amount is its raw amount with the token's decimals() applied`,
        first.amount === formatUnits(BigInt(first.amount_raw), dec) && got.answer.includes(first.amount), `${first.amount} ${first.symbol}`);
    }
  }
  const noHash = (await app.inject({ method: 'GET', url: '/transfer?question=did%20my%20payment%20arrive' })).json();
  check('/transfer with no hash answers 200 with a refusal about a transfer, not a transaction lookup',
    noHash.error === 'INVALID_INPUT' && noHash.answer.startsWith('The request did not identify a transfer to verify.'), noHash.answer);
  const inText = (await app.inject({ method: 'GET', url: `/transfer?question=${encodeURIComponent(`Did ${transferCases[0]![0]} on Ethereum settle?`)}` })).json();
  check('/transfer finds a hash in free text under any parameter name', inText.settled === true && inText.chain === 'ethereum', inText.answer);
  const unknown = (await app.inject({ method: 'GET', url: `/transfer?tx_hash=0x${'0'.repeat(63)}1&chain=ethereum` })).json();
  check('/transfer for an unknown hash says it cannot be verified as settled', unknown.settled === false && unknown.status === 'not_found'
    && unknown.answer.includes('cannot be verified as settled'), unknown.answer);

  // --- LIQUIDITY_DEPTH_VERIFY: the figure is the reserves it reports, priced; the index agrees ---
  console.log('');
  const poolErc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const liqCases: Array<[string, SupportedChain]> = [
    ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', 'ethereum'], // WETH / USDC 0.05%, Uniswap v3
    ['0xcDAC0d6c6C59727a65F871236188350531885C43', 'base'], // USDC / WETH, Aerodrome
  ];
  for (const [pool, chain] of liqCases) {
    const res = await app.inject({ method: 'GET', url: `/liquidity?pool=${pool}&chain=${chain}` });
    const got = res.json();
    if (res.statusCode === 502) { skip(`/liquidity ${chain} ${pool}`, got.message); continue; }
    const raws = await Promise.all(got.reserves.map(async (r: any) => {
      const [raw, dec] = await Promise.all([
        getClient(chain).readContract({ address: r.token, abi: poolErc20, functionName: 'balanceOf', args: [pool as `0x${string}`], blockNumber: BigInt(got.block_number) }),
        getClient(chain).readContract({ address: r.token, abi: erc20Meta, functionName: 'decimals' }),
      ]);
      return formatUnits(raw, dec);
    }));
    const sum = got.reserves.reduce((a: number, r: any) => a + Number(r.value_usd), 0);
    check(`/liquidity ${chain}: each reserve is the pool's balanceOf() at the stated block`,
      got.reserves.every((r: any, i: number) => r.amount === raws[i]), `${got.reserves.map((r: any) => r.amount).join(' / ')} vs ${raws.join(' / ')}`);
    check(`/liquidity ${chain}: liquidity_usd is the sum of the priced reserves`, Math.abs(got.liquidity_usd - sum) < 0.01, `${got.liquidity_usd} vs ${sum}`);
    check(`/liquidity ${chain}: GeckoTerminal's figure for the pool is within 2%`,
      got.geckoterminal_reserve_usd === null || Math.abs(got.liquidity_usd - got.geckoterminal_reserve_usd) / got.geckoterminal_reserve_usd < 0.02,
      `${got.liquidity_usd} vs ${got.geckoterminal_reserve_usd}`);
  }
  const byName = await app.inject({ method: 'GET', url: '/liquidity?pool=WETH%20%2F%20USDC%200.05%25&chain=base' });
  if (byName.statusCode === 502) skip('/liquidity by name', byName.json().message);
  else {
    const n = byName.json();
    check('/liquidity by name picks a pool of exactly those two tokens at that fee, and says which',
      /^(WETH \/ USDC|USDC \/ WETH) 0\.05%/.test(n.pool_name) && n.answer.includes('was matched to') && n.liquidity_usd > 1000, n.answer);
  }
  const noPool = (await app.inject({ method: 'GET', url: '/liquidity?chain=base' })).json();
  check('/liquidity with no pool answers 200 with a refusal about a pool', noPool.error === 'INVALID_INPUT'
    && noPool.answer.startsWith('The request did not identify a DEX pool whose liquidity can be read'), noPool.answer);
  await app.close();

  const tally = `${passes} passed, ${failures} failed, ${skips} skipped`;
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${tally})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
