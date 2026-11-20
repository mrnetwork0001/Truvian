/**
 * Tests for the truth API (src/truth). Rules first, with stand-in endpoints;
 * then live archive reads on Ethereum, Polygon and Arbitrum; then the HTTP
 * surface. Exits non-zero on any failure. Run: npm run test:truth
 */
import { getAddress } from 'viem';
import { getClient, type RpcClient, type SupportedChain } from '../config/chains.js';
import { TRUTH_CHAINS, TruthError, balanceAt, parseBalanceQuery, stateArchives } from '../truth/balance.js';
import { buildTruthServer } from '../truth/server.js';

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
  await app.close();
}

async function main() {
  await rules();
  await live();
  await http();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
