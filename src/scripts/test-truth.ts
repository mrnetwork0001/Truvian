/**
 * Tests for the truth API (src/truth). Rules first, with stand-in endpoints;
 * then live reads (balances at a block on Ethereum, Polygon and Arbitrum;
 * total supply, wallet balance and transaction block on Ethereum, Base,
 * Arbitrum, OP Mainnet and Polygon) checked against every endpoint's own
 * read; then the HTTP surface. Exits non-zero on any failure.
 * Run: npm run test:truth
 */
import { TransactionNotFoundError, TransactionReceiptNotFoundError, getAddress, parseAbi } from 'viem';
import { getClient, type RpcClient, type SupportedChain } from '../config/chains.js';
import { TRUTH_CHAINS, TruthError, balanceAt, parseBalanceQuery, stateArchives } from '../truth/balance.js';
import { CURRENT_CHAINS, receiptArchives, stateEndpoints, type CurrentChain } from '../truth/endpoints.js';
import { buildTruthServer } from '../truth/server.js';
import { parseSupplyQuery, parseWalletQuery, totalSupply, walletBalance } from '../truth/state.js';
import { parseTxQuery, txBlock } from '../truth/tx.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!cond) failures++;
}
const code = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof TruthError ? `${e.status} ${e.code}` : 'other'; }
};
const codeOf = async (p: Promise<unknown>): Promise<string | null> =>
  p.then(() => null, (e) => (e instanceof TruthError ? `${e.status} ${e.code}` : `other: ${e?.message}`));

const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

/** A stand-in endpoint: fixed tip, fixed reading, or a failure. */
function stub(url: string, opts: { tip?: bigint; balance?: bigint; nonce?: number; fail?: boolean; fullHistory?: boolean }): RpcClient {
  const fail = () => Promise.reject(new Error('endpoint down'));
  return {
    url,
    fullHistory: opts.fullHistory ?? true,
    client: {
      getBlockNumber: () => (opts.fail ? fail() : Promise.resolve(opts.tip ?? 1000n)),
      getBalance: () => (opts.fail ? fail() : Promise.resolve(opts.balance ?? 5n)),
      getTransactionCount: () => (opts.fail ? fail() : Promise.resolve(opts.nonce ?? 1)),
    } as any,
  };
}

async function rules() {
  check('chain names, ids and CAIP-2 parse', parseBalanceQuery({ chain: 'Polygon', address: ADDR, block: '1' }).chain === 'polygon'
    && parseBalanceQuery({ chain: '42161', address: ADDR, block: '1' }).chain === 'arbitrum'
    && parseBalanceQuery({ chain: 'eip155:1', address: ADDR, block: '1' }).chain === 'ethereum');
  check('chain defaults to ethereum, as the intent does', parseBalanceQuery({ address: ADDR, block: '1' }).chain === 'ethereum');
  check('blockno is accepted as an alias of block', parseBalanceQuery({ address: ADDR, blockno: '7' }).block === 7n);
  check('an unserved chain is refused', code(() => parseBalanceQuery({ chain: 'base', address: ADDR, block: '1' })) === '400 CHAIN_UNSUPPORTED');
  check('a malformed address is refused', code(() => parseBalanceQuery({ address: '0x123', block: '1' })) === '400 INVALID_ADDRESS');
  check('a non-decimal block is refused', code(() => parseBalanceQuery({ address: ADDR, block: '0x10' })) === '400 INVALID_BLOCK');

  const q = { chain: 'polygon' as const, address: getAddress(ADDR), block: 100n };
  const agreed = await balanceAt({ ...q, block: 101n }, [stub('https://a.example', {}), stub('https://b.example', {})]);
  check('two agreeing endpoints give the value', agreed.balance_wei === '5' && agreed.tx_count === 1 && agreed.agreed_by.join() === 'a.example,b.example');
  check('gwei is the exact decimal of wei', (await balanceAt({ ...q, block: 102n }, [stub('https://a.example', { balance: 1234567891n }), stub('https://b.example', { balance: 1234567891n })])).balance_gwei === '1.234567891');
  check('disagreeing endpoints give no value (502)',
    await codeOf(balanceAt({ ...q, block: 103n }, [stub('https://a.example', { balance: 5n }), stub('https://b.example', { balance: 6n })])) === '502 SOURCES_DISAGREE');
  check('a failed endpoint is skipped for the next one',
    (await balanceAt({ ...q, block: 104n }, [stub('https://a.example', {}), stub('https://down.example', { fail: true }), stub('https://c.example', {})])).agreed_by.join() === 'a.example,c.example');
  check('one answer alone gives no value (503)',
    await codeOf(balanceAt({ ...q, block: 105n }, [stub('https://a.example', {}), stub('https://down.example', { fail: true })])) === '503 NOT_ENOUGH_SOURCES');
  check('pruned endpoints are never used',
    await codeOf(balanceAt({ ...q, block: 106n }, [stub('https://a.example', {}), stub('https://pruned.example', { fullHistory: false })])) === '503 NOT_ENOUGH_SOURCES');
  check('a block beyond the tip is refused (422), not answered with the latest balance',
    await codeOf(balanceAt({ ...q, block: 2000n }, [stub('https://a.example', { tip: 1000n }), stub('https://b.example', { tip: 1000n })])) === '422 BLOCK_IN_FUTURE');
}

/** A stand-in for current-state reads: a fixed tip, block hash and contract. */
function stateStub(url: string, opts: {
  tip?: bigint; hash?: string; code?: string; decimals?: number; symbol?: string; name?: string; supply?: bigint; held?: bigint; wei?: bigint; fail?: boolean;
} = {}): RpcClient {
  const fail = () => Promise.reject(new Error('endpoint down'));
  const v = { tip: 1000n, hash: '0xaa', code: '0x6080', decimals: 6, symbol: 'USDC', name: 'USD Coin', supply: 1_500_000n, held: 2_000_000n, wei: 10n ** 18n, ...opts };
  return {
    url,
    fullHistory: false,
    client: {
      getBlockNumber: () => (opts.fail ? fail() : Promise.resolve(v.tip)),
      getBlock: ({ blockNumber }: { blockNumber: bigint }) => (opts.fail ? fail() : Promise.resolve({ number: blockNumber, hash: v.hash, timestamp: 1_700_000_000n })),
      getCode: () => (opts.fail ? fail() : Promise.resolve(v.code)),
      getBalance: () => (opts.fail ? fail() : Promise.resolve(v.wei)),
      readContract: ({ functionName }: { functionName: string }) => {
        if (opts.fail) return fail();
        const out: Record<string, unknown> = { decimals: v.decimals, symbol: v.symbol, name: v.name, totalSupply: v.supply, balanceOf: v.held };
        return Promise.resolve(out[functionName]);
      },
    } as any,
  };
}

/** A stand-in receipt archive. */
function txStub(url: string, opts: { state?: 'included' | 'absent' | 'pending'; block?: bigint; hash?: string; tip?: bigint; status?: 'success' | 'reverted'; fail?: boolean } = {}): RpcClient {
  const v = { state: 'included', block: 500n, hash: '0xbb', tip: 100_000n, status: 'success', ...opts };
  const h = `0x${'11'.repeat(32)}` as `0x${string}`;
  const fail = () => Promise.reject(new Error('endpoint down'));
  return {
    url,
    fullHistory: true,
    client: {
      getBlockNumber: () => (opts.fail ? fail() : Promise.resolve(v.tip)),
      getTransactionReceipt: () => {
        if (opts.fail) return fail();
        if (v.state !== 'included') return Promise.reject(new TransactionReceiptNotFoundError({ hash: h }));
        return Promise.resolve({ blockNumber: v.block, blockHash: v.hash, status: v.status, from: ADDR, to: ADDR, contractAddress: null });
      },
      getTransaction: () => {
        if (opts.fail) return fail();
        if (v.state === 'absent') return Promise.reject(new TransactionNotFoundError({ hash: h }));
        return Promise.resolve({ blockNumber: v.state === 'pending' ? null : v.block, blockHash: v.state === 'pending' ? null : v.hash, value: 31337n });
      },
    } as any,
  };
}

const TX = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

async function stateRules() {
  console.log('');
  // parsing: the node's own question keys and the forms seen in its traffic
  const key = parseSupplyQuery({ token: `USDC (${USDC}) on Ethereum` });
  check("supply: the node's question key reads as USDC's contract on ethereum", key.chain === 'ethereum' && key.target.address === USDC && key.target.symbol === 'USDC');
  check('supply: the whole question template is read too',
    parseSupplyQuery({ token: 'What is the current total supply of WBTC (0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599) on Ethereum, in whole tokens?' }).target.address === '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599');
  check('supply: "on Base Mainnet" is Base, and a symbol comes from the verified table',
    (() => { const q = parseSupplyQuery({ token: 'USD Coin (USDC) on Base Mainnet' }); return q.chain === 'base' && q.target.address === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; })());
  check('supply: no chain is refused, not read on Ethereum', code(() => parseSupplyQuery({ token: 'USDC' })) === '400 CHAIN_MISSING');
  check('supply: an unserved chain is refused', code(() => parseSupplyQuery({ token: 'USDC on Solana' })) === '400 CHAIN_UNSUPPORTED');
  check('supply: a symbol outside the verified table is refused, not searched for', code(() => parseSupplyQuery({ token: 'Kelp DAO Restaked ETH (rsETH) on Ethereum' })) === '422 TOKEN_NOT_IN_TABLE');
  check('supply: a native coin has no supply', code(() => parseSupplyQuery({ token: 'ETH on Ethereum' })) === '422 NATIVE_HAS_NO_SUPPLY');
  check('supply: two addresses are refused', code(() => parseSupplyQuery({ token: `${USDC} ${ADDR} on Ethereum` })) === '422 TOKEN_AMBIGUOUS');
  check('supply: a chain parameter that contradicts the text is refused', code(() => parseSupplyQuery({ token: 'USDC on Ethereum', chain: 'base' })) === '400 CHAIN_CONFLICT');

  const w = parseWalletQuery({ address: ADDR.toLowerCase(), chain: 'ethereum' });
  check('wallet: no token is the native coin, and the address is checksummed', w.target.kind === 'native' && w.holder === ADDR);
  check('wallet: MATIC on Polygon is the native coin', parseWalletQuery({ address: ADDR, chain: '137', token: 'MATIC' }).target.kind === 'native');
  check('wallet: ETH on Polygon is not the native coin, and is refused', code(() => parseWalletQuery({ address: ADDR, chain: 'polygon', token: 'ETH' })) === '422 TOKEN_NOT_IN_TABLE');
  check('wallet: a chain is required', code(() => parseWalletQuery({ address: ADDR })) === '400 CHAIN_MISSING');
  check('wallet: a malformed address is refused', code(() => parseWalletQuery({ address: '0x123', chain: 'ethereum' })) === '400 INVALID_ADDRESS');

  check('tx: hash and chain alias parse', (() => { const q = parseTxQuery({ tx_hash: `0x${TX.slice(2).toUpperCase()}`, chain: 'eip155:8453' }); return q.chain === 'base' && q.hash === TX; })());
  check('tx: a malformed hash is refused', code(() => parseTxQuery({ tx_hash: '0x1234', chain: 'ethereum' })) === '400 INVALID_TX_HASH');
  check('tx: a chain is required', code(() => parseTxQuery({ tx_hash: TX })) === '400 CHAIN_MISSING');

  // agreement, with stand-in endpoints
  const q = parseSupplyQuery({ token: `USDC (${USDC}) on Ethereum` });
  const ok = await totalSupply(q, [stateStub('https://a.example'), stateStub('https://b.example')]);
  check('supply: two agreeing endpoints give whole tokens as an exact decimal string, at the tip less the confirmations',
    ok.total_supply === '1.5' && ok.total_supply_raw === '1500000' && ok.block === '995' && ok.agreed_by.join() === 'a.example,b.example', `${ok.total_supply} at ${ok.block}`);
  check('supply: different supplies give no value (502)',
    await codeOf(totalSupply(q, [stateStub('https://a.example'), stateStub('https://b.example', { supply: 1_500_001n })])) === '502 SOURCES_DISAGREE');
  check('supply: different block hashes give no value (502)',
    await codeOf(totalSupply(q, [stateStub('https://a.example'), stateStub('https://b.example', { hash: '0xcc' })])) === '502 SOURCES_DISAGREE');
  check('supply: a second endpoint of the same provider does not count (503)',
    await codeOf(totalSupply(q, [stateStub('https://eth.a.example'), stateStub('https://base.a.example')])) === '503 NOT_ENOUGH_SOURCES');
  check('supply: a failed endpoint is skipped for the next',
    (await totalSupply(q, [stateStub('https://a.example'), stateStub('https://down.example', { fail: true }), stateStub('https://c.example')])).agreed_by.join() === 'a.example,c.example');
  check('supply: an address with no code gives no value (422)',
    await codeOf(totalSupply(q, [stateStub('https://a.example', { code: '0x' }), stateStub('https://b.example', { code: '0x' })])) === '422 NOT_A_CONTRACT');
  check('supply: a contract reporting another symbol gives no value (422)',
    await codeOf(totalSupply(q, [stateStub('https://a.example', { symbol: 'USDT' }), stateStub('https://b.example', { symbol: 'USDT' })])) === '422 SYMBOL_MISMATCH');
  check("supply: a name that agrees with none of the token's gives no value (422)",
    await codeOf(totalSupply(parseSupplyQuery({ token: 'Bancor (USDC) on Ethereum' }), [stateStub('https://a.example'), stateStub('https://b.example')])) === '422 NAME_MISMATCH');

  const native = await walletBalance(parseWalletQuery({ address: ADDR, chain: 'ethereum', token: 'ETH' }),
    [stateStub('https://a.example', { wei: 1234567890123456789n }), stateStub('https://b.example', { wei: 1234567890123456789n })]);
  check('wallet: a native balance is whole ETH as an exact decimal string', native.balance === '1.234567890123456789' && native.token_address === null);
  const erc = await walletBalance(parseWalletQuery({ address: ADDR, chain: 'ethereum', token: USDC }), [stateStub('https://a.example'), stateStub('https://b.example')]);
  check('wallet: an ERC-20 balance has its decimals applied', erc.balance === '2' && erc.token_symbol === 'USDC');
  check('wallet: different balances give no value (502)',
    await codeOf(walletBalance(parseWalletQuery({ address: ADDR, chain: 'ethereum' }), [stateStub('https://a.example', { wei: 1n }), stateStub('https://b.example', { wei: 2n })])) === '502 SOURCES_DISAGREE');

  const tq = parseTxQuery({ tx_hash: TX, chain: 'ethereum' });
  const other = (d: string) => ({ ...tq, hash: `0x${d.repeat(64)}` as `0x${string}` });
  const t = await txBlock(other('1'), [txStub('https://a.example'), txStub('https://b.example')]);
  check('tx: two agreeing archives give the block number', t.block_number === 500 && t.status === 'confirmed' && t.value_eth === '0.000000000000031337');
  check('tx: different blocks give no value (502)',
    await codeOf(txBlock(other('2'), [txStub('https://a.example'), txStub('https://b.example', { block: 501n })])) === '502 SOURCES_DISAGREE');
  check('tx: found by one archive and absent from the other gives no value (502)',
    await codeOf(txBlock(other('3'), [txStub('https://a.example'), txStub('https://b.example', { state: 'absent' })])) === '502 SOURCES_DISAGREE');
  check('tx: absent from both archives is 404',
    await codeOf(txBlock(other('4'), [txStub('https://a.example', { state: 'absent' }), txStub('https://b.example', { state: 'absent' })])) === '404 TX_NOT_FOUND');
  check('tx: pending on both is 422',
    await codeOf(txBlock(other('5'), [txStub('https://a.example', { state: 'pending' }), txStub('https://b.example', { state: 'pending' })])) === '422 TX_PENDING');
  check('tx: a block too near the tip is 422',
    await codeOf(txBlock(other('6'), [txStub('https://a.example', { tip: 502n }), txStub('https://b.example', { tip: 502n })])) === '422 TX_NOT_CONFIRMED');
  check('tx: one archive answering alone gives no value (503)',
    await codeOf(txBlock(other('7'), [txStub('https://a.example'), txStub('https://down.example', { fail: true })])) === '503 NOT_ENOUGH_SOURCES');
}

const ERC20 = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);

/** Re-read at the answer's block from every endpoint of the list that answers; each must equal the answer. */
async function everyEndpoint(endpoints: RpcClient[], read: (e: RpcClient) => Promise<bigint>, expected: string): Promise<{ ok: boolean; detail: string }> {
  const reads: string[] = [];
  for (const e of endpoints) {
    const v = await read(e).catch(() => null);
    if (v !== null) reads.push(`${new URL(e.url).host}=${v.toString() === expected ? 'same' : `DIFFERENT ${v}`}`);
  }
  return { ok: reads.length >= 2 && reads.every((r) => r.endsWith('=same')), detail: reads.join(', ') };
}

const SECONDS: Record<CurrentChain, number> = { ethereum: 12, base: 2, arbitrum: 0.25, optimism: 2, polygon: 2 };
const SAMPLE_TOKEN: Record<CurrentChain, string> = { ethereum: 'USDC', base: 'USDC', arbitrum: 'USDT', optimism: 'USDC', polygon: 'WBTC' };

async function stateLive() {
  console.log('');
  // The node's own question keys (GET /engine/v1/intents/<name>, 2026-11-21)
  const supplyKeys = [`USDC (${USDC}) on Ethereum`, 'WBTC (0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599) on Ethereum', 'DAI (0x6B175474E89094C44Da98b954EedeAC495271d0F) on Ethereum'];
  for (const token of [...supplyKeys, ...CURRENT_CHAINS.map((c) => `${SAMPLE_TOKEN[c]} on ${c}`)]) {
    try {
      const got = await totalSupply(parseSupplyQuery({ token }));
      const v = await everyEndpoint(stateEndpoints(got.chain), ({ client }) => client.readContract({ address: got.token_address as `0x${string}`, abi: ERC20, functionName: 'totalSupply', blockNumber: BigInt(got.block) }), got.total_supply_raw);
      check(`supply: ${token} equals every endpoint's totalSupply() at block ${got.block}`, v.ok, `${got.total_supply} ${got.token} (${v.detail})`);
    } catch (e: any) { check(`supply: ${token}`, false, e?.message); }
  }
  check("supply: Ethereum's USDC address on Arbitrum is refused (no code there)",
    await codeOf(totalSupply(parseSupplyQuery({ token: `USDC (${USDC}) on Arbitrum` }))) === '422 NOT_A_CONTRACT');
  check('supply: the beacon deposit contract is no ERC-20',
    await codeOf(totalSupply(parseSupplyQuery({ token: '0x00000000219ab540356cBB839Cbe05303d7705Fa on Ethereum' }))) === '422 NOT_AN_ERC20');

  // The node's two wallet question keys, then a native and a token balance on every chain
  const walletCases: [string, CurrentChain, string][] = [
    ['0x00000000219ab540356cBB839Cbe05303d7705Fa', 'ethereum', ''],
    ['0x000000000000000000000000000000000000dEaD', 'ethereum', ''],
    ...CURRENT_CHAINS.flatMap((c): [string, CurrentChain, string][] => [[ADDR, c, ''], [ADDR, c, SAMPLE_TOKEN[c]]]),
  ];
  for (const [address, chain, token] of walletCases) {
    try {
      const got = await walletBalance(parseWalletQuery({ address, chain, token }));
      const holder = got.address as `0x${string}`;
      const v = await everyEndpoint(stateEndpoints(chain), ({ client }) => (got.token_address === null
        ? client.getBalance({ address: holder, blockNumber: BigInt(got.block) })
        : client.readContract({ address: got.token_address as `0x${string}`, abi: ERC20, functionName: 'balanceOf', args: [holder], blockNumber: BigInt(got.block) })), got.balance_raw);
      check(`wallet: ${token || 'native'} balance of ${address.slice(0, 10)}… on ${chain} equals every endpoint's read`, v.ok, `${got.balance} ${got.token_symbol} (${v.detail})`);
    } catch (e: any) { check(`wallet: ${token || 'native'} of ${address.slice(0, 10)}… on ${chain}`, false, e?.message); }
  }
  const ens = await walletBalance(parseWalletQuery({ address: 'vitalik.eth', chain: 'ethereum' })).catch((e) => e);
  check('wallet: an ENS name resolves, agreed by two endpoints', !(ens instanceof Error) && ens.address === ADDR, ens instanceof Error ? ens.message : ens.address);

  // Transactions: the node's question key, then one taken from blocks 2 days, 1 year and 3 years old on every chain
  try {
    const got = await txBlock(parseTxQuery({ tx_hash: TX, chain: 'ethereum' }));
    check("tx: the node's question key (Ethereum's first transaction) is in block 46147", got.block_number === 46147, `${got.block_number} (${got.agreed_by.join(', ')})`);
  } catch (e: any) { check("tx: the node's question key", false, e?.message); }
  for (const chain of CURRENT_CHAINS) {
    const tipNow = await receiptArchives(chain)[0]!.client.getBlockNumber();
    for (const [age, days] of [['2 days', 2], ['1 year', 365], ['3 years', 1095]] as const) {
      try {
        const target = tipNow - BigInt(Math.round((days * 86_400) / SECONDS[chain]));
        let hash: `0x${string}` | undefined;
        let number = target;
        for (let off = 0n; off < 10n && !hash; off++) {
          for (const { client } of receiptArchives(chain)) {
            const b = await client.getBlock({ blockNumber: target + off }).catch(() => null);
            if (b?.transactions.length) { hash = b.transactions[b.transactions.length - 1] as `0x${string}`; number = b.number!; break; }
          }
        }
        if (!hash) { check(`tx: found a ${age} old ${chain} transaction`, false); continue; }
        const got = await txBlock({ chain, hash });
        check(`tx: a ${age} old ${chain} transaction is in the block it was taken from`, got.block_number === Number(number), `${got.block_number} (${got.agreed_by.join(', ')})`);
      } catch (e: any) { check(`tx: ${age} old on ${chain}`, false, e?.message); }
    }
  }
}

async function live() {
  console.log('');
  const seconds: Record<string, number> = { ethereum: 12, polygon: 2, arbitrum: 0.25 };
  for (const chain of TRUTH_CHAINS) {
    const tipNow = await getClient(chain as SupportedChain).getBlockNumber();
    for (const [age, days] of [['2 days', 2], ['60 days', 60], ['1 year', 365]] as const) {
      try {
        const target = tipNow - BigInt(Math.round((days * 86_400) / seconds[chain]!));
        let block;
        for (let off = 0n; off < 10n && !block?.transactions.length; off++) {
          for (const { client } of stateArchives(chain)) {
            block = await client.getBlock({ blockNumber: target + off, includeTransactions: true }).catch(() => null);
            if (block?.transactions.length) break;
          }
        }
        // The last transaction is a user's: Arbitrum blocks open with an ArbOS system
        // transaction whose sender has no balance or nonce, which would test nothing.
        const tx = block?.transactions[block.transactions.length - 1];
        if (!block || !tx || typeof tx === 'string') { check(`${chain}: found a ${age} old block`, false); continue; }
        const got = await balanceAt({ chain, address: getAddress(tx.from), block: block.number! });
        // Re-read at the block from every full-history endpoint that answers: all must equal the answer.
        const reads: string[] = [];
        for (const { client, url } of stateArchives(chain)) {
          const b = await client.getBalance({ address: tx.from, blockNumber: block.number! }).catch(() => null);
          if (b !== null) reads.push(`${new URL(url).host}=${b === BigInt(got.balance_wei) ? 'same' : `DIFFERENT ${b}`}`);
        }
        check(`${chain}: ${age} old balance agrees with every state-archive endpoint that answers`,
          reads.length >= 2 && reads.every((r) => r.endsWith('=same')) && got.tx_count >= 1,
          `${got.balance_gwei} gwei, nonce ${got.tx_count}, block ${got.block} (${reads.join(', ')})`);
      } catch (e: any) {
        check(`${chain}: ${age} old balance`, false, e?.message ?? String(e));
      }
    }
  }
}

async function http() {
  console.log('');
  const app = buildTruthServer();
  const ok = await app.inject({ method: 'GET', url: `/balance?chain=arbitrum&address=${ADDR}&block=398124344` });
  const body = ok.json();
  check('GET /balance answers 200 with decimal-string balances', ok.statusCode === 200
    && /^\d+$/.test(body.balance_wei) && typeof body.balance_gwei === 'string' && body.chain_id === 42161, `${ok.statusCode} ${body.balance_gwei}`);
  const bad = await app.inject({ method: 'GET', url: `/balance?chain=solana&address=${ADDR}&block=1` });
  check('an unserved chain answers 400 with a JSON error', bad.statusCode === 400 && bad.json().error?.code === 'CHAIN_UNSUPPORTED');
  const future = await app.inject({ method: 'GET', url: `/balance?chain=ethereum&address=${ADDR}&block=999999999` });
  check('a future block answers 422', future.statusCode === 422 && future.json().error?.code === 'BLOCK_IN_FUTURE');
  const supply = await app.inject({ method: 'GET', url: `/total-supply?token=${encodeURIComponent(`USDC (${USDC}) on Ethereum`)}` });
  check('GET /total-supply answers 200 with a decimal-string total_supply', supply.statusCode === 200 && /^\d+(\.\d+)?$/.test(supply.json().total_supply), `${supply.statusCode} ${supply.json().total_supply}`);
  const nochain = await app.inject({ method: 'GET', url: '/total-supply?token=USDC' });
  check('GET /total-supply with no chain answers 400', nochain.statusCode === 400 && nochain.json().error?.code === 'CHAIN_MISSING');
  const wallet = await app.inject({ method: 'GET', url: '/wallet-balance?address=0x000000000000000000000000000000000000dEaD&chain=ethereum' });
  check('GET /wallet-balance answers 200 with a decimal-string balance', wallet.statusCode === 200 && /^\d+(\.\d+)?$/.test(wallet.json().balance), `${wallet.statusCode} ${wallet.json().balance}`);
  const tx = await app.inject({ method: 'GET', url: `/tx?tx_hash=${TX}&chain=ethereum` });
  check('GET /tx answers 200 with a numeric block_number', tx.statusCode === 200 && tx.json().block_number === 46147, `${tx.statusCode} ${tx.json().block_number}`);
  const missing = await app.inject({ method: 'GET', url: `/tx?tx_hash=0x${'0'.repeat(56)}deadbeef&chain=ethereum` });
  check('GET /tx for a transaction that does not exist answers 404', missing.statusCode === 404 && missing.json().error?.code === 'TX_NOT_FOUND');
  await app.close();
}

async function main() {
  await rules();
  await stateRules();
  await live();
  await stateLive();
  await http();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
