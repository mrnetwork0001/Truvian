/**
 * Frontier models against chain reads, on the questions Truvian's desks buy.
 *
 * For each case the true answer is read from the chain here, at one block,
 * by the same handlers the miner serves; then each model is asked the same
 * question with no tools, and its reply is scored against that reading:
 *   correct   - the figure is within the case's tolerance of the chain read
 *   wrong     - a figure that is outside it (or the wrong yes/no)
 *   no answer - a refusal, a range wider than the tolerance, or no figure
 * Nothing is scored by a model. Replies, readings and costs are written to
 * docs/frontier-comparison/<date>.json, and a summary table to .md.
 *
 * Models are reached through an OpenAI-compatible chat completions API:
 *   LLM_BASE_URL  e.g. https://…/v1   (POST {base}/chat/completions)
 *   LLM_API_KEY   bearer token, read from .env and never printed
 *   LLM_MODELS    comma-separated model ids
 * Run: npx tsx src/scripts/frontier-compare.ts [--agent] [--random [--seed N]] [--dry]
 *   --dry reads the chain only; --random draws cases from live chain state
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chainMeta, getClient, type SupportedChain } from '../config/chains.js';
import { KNOWN_TOKENS } from '../config/tokens.js';
import { handleSupply, validateSupplyInput, handleBalance, validateBalanceInput } from '../miner/holdings.js';
import { handleLiquidity, validateLiquidityInput } from '../miner/liquidity.js';
import { handleTransferVerify, validateTransferInput } from '../miner/transfer.js';
import { handleGasPrice, validateGasPriceInput } from '../miner/gasPrice.js';

interface Case {
  id: string;
  /** What a desk needs and buys */
  desk: string;
  question: string;
  /** The chain read: the figure, and how it was read */
  truth: number | string;
  truthText: string;
  /** Relative tolerance for a figure (0.005 = 0.5%); for yes/no cases, the expected word */
  tolerance?: number;
  expect?: 'yes' | 'no';
}

const RECENT_TX_FROM_BLOCK_OFFSET = 3; // a transaction from 3 blocks ago, so no model can have seen it

async function buildCases(): Promise<Case[]> {
  const eth = getClient('ethereum');
  const cases: Case[] = [];

  const usdc = await handleSupply(validateSupplyInput({ token: 'USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum' })) as any;
  cases.push({
    id: 'supply-usdc', desk: 'Token preflight (total supply)',
    question: `What is the exact total supply of USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) on Ethereum at block ${usdc.blockNumber}? Give one number in whole USDC.`,
    truth: usdc.total_supply, truthText: `${usdc.total_supply_exact} USDC (totalSupply() at block ${usdc.blockNumber})`, tolerance: 0.005,
  });

  const squid = await handleSupply(validateSupplyInput({ token: 'Squid Game (SQUID) (0x87230146E138d3F296a9a77e497A2A83012e9Bc5) on BNB Smart Chain' })) as any;
  cases.push({
    id: 'supply-squid', desk: 'Token preflight (the SQUID rug pull)',
    question: `What is the total supply of the token at 0x87230146E138d3F296a9a77e497A2A83012e9Bc5 (SQUID) on BNB Smart Chain at block ${squid.blockNumber}? Give one number in whole tokens.`,
    truth: squid.total_supply, truthText: `${squid.total_supply_exact} SQUID at block ${squid.blockNumber}`, tolerance: 0.005,
  });
  cases.push({
    id: 'squid-safe', desk: 'Token preflight (the SQUID rug pull)',
    question: 'An agent wants to buy $1,000 of SQUID (0x87230146E138d3F296a9a77e497A2A83012e9Bc5) on BNB Smart Chain now. Is it safe to buy? Answer yes or no first, then why.',
    truth: 'no', truthText: 'no: the 2021 Squid Game rug pull; holders could not sell and the liquidity was withdrawn', expect: 'no',
  });

  const pool = await handleLiquidity(validateLiquidityInput({ pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', chain: 'ethereum' })) as any;
  cases.push({
    id: 'liquidity-weth-usdc', desk: 'Token preflight (pool depth)',
    question: `How much liquidity, in US dollars, does the Uniswap v3 WETH/USDC 0.05% pool (0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640) on Ethereum hold at block ${pool.block_number}? Give one number in USD.`,
    truth: pool.liquidity_usd, truthText: `$${pool.liquidity_usd} (reserves at block ${pool.block_number}, DefiLlama prices)`, tolerance: 0.05,
  });

  const tip = await eth.getBlock({ blockTag: 'latest' });
  const recent = await eth.getBlock({ blockNumber: tip.number - BigInt(RECENT_TX_FROM_BLOCK_OFFSET) });
  const hash = recent.transactions[Math.min(5, recent.transactions.length - 1)] as `0x${string}`;
  const tx = await handleTransferVerify(validateTransferInput({ tx_hash: hash, chain: 'ethereum' })) as any;
  cases.push({
    id: 'transfer-fee', desk: 'Settlement check (CRYPTO_TRANSFER_VERIFY)',
    question: `Did Ethereum transaction ${hash} succeed, and exactly how much ETH did its sender pay in fees? Answer the fee as one number in ETH.`,
    truth: Number(tx.fee_total_native), truthText: `${tx.status}, fee ${tx.fee_total_native} ETH (receipt, block ${tx.block_number})`, tolerance: 0.01,
  });

  const vitalik = await handleBalance(validateBalanceInput({ address: 'vitalik.eth', chain: 'ethereum' })) as any;
  cases.push({
    id: 'balance-vitalik', desk: 'Listing review (treasury check)',
    question: `What is the exact ETH balance of vitalik.eth (${vitalik.address}) on Ethereum at block ${vitalik.blockNumber}? Give one number in ETH.`,
    truth: vitalik.balance, truthText: `${vitalik.balance_exact} ETH at block ${vitalik.blockNumber}`, tolerance: 0.01,
  });

  const gas = await handleGasPrice(validateGasPriceInput({ chain: 'ethereum' })) as any;
  cases.push({
    id: 'gas-now', desk: 'Execution (gas)',
    question: `What is the gas price on Ethereum at block ${gas.blockNumber ?? 'the latest block'}, in gwei? Give one number.`,
    truth: gas.gas_price_gwei, truthText: `${gas.gas_price_gwei} gwei (eth_gasPrice)`, tolerance: 0.25,
  });
  // The way an agent usually asks: "now", no block. A figure from training
  // data is then stale, and is scored against the chain read at this moment.
  cases.push(
    { id: 'plain-supply-usdc', desk: 'Token preflight (total supply)', question: 'What is the total supply of USDC on Ethereum right now? Give one number in whole USDC.',
      truth: usdc.total_supply, truthText: `${usdc.total_supply_exact} USDC now`, tolerance: 0.01 },
    { id: 'plain-liquidity', desk: 'Token preflight (pool depth)', question: 'How much liquidity does the Uniswap v3 WETH/USDC 0.05% pool on Ethereum hold right now, in US dollars? Give one number.',
      truth: pool.liquidity_usd, truthText: `$${pool.liquidity_usd} now`, tolerance: 0.10 },
    { id: 'plain-balance', desk: 'Listing review (treasury check)', question: 'What is the ETH balance of vitalik.eth right now? Give one number in ETH.',
      truth: vitalik.balance, truthText: `${vitalik.balance_exact} ETH now`, tolerance: 0.05 },
    { id: 'plain-gas', desk: 'Execution (gas)', question: 'What is the gas price on Ethereum right now, in gwei? Give one number.',
      truth: gas.gas_price_gwei, truthText: `${gas.gas_price_gwei} gwei now`, tolerance: 0.5 },
  );
  return cases;
}

/**
 * --random [--seed N]: cases drawn from live chain state instead of chosen by
 * hand, so nobody (us included) picked the examples. The seed and the drawn
 * cases are saved with the run, so the draw can be checked; the chain state it
 * read moves on, so a rerun draws new cases.
 *  - fees and settlement of random transactions from recent blocks;
 *  - native balances of the senders of those transactions;
 *  - USD liquidity of pools that emitted a Uniswap-v3-style Swap in those blocks;
 *  - total supplies of tokens drawn from the verified token table;
 *  - each chain's gas price.
 */
const RANDOM_CHAINS: SupportedChain[] = ['ethereum', 'base', 'arbitrum', 'polygon', 'bsc'];
/** Swap(address,address,int256,int256,uint160,uint128,int24): Uniswap v3 and its forks */
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function buildRandomCases(seed: number, perChain: { tx: number; balance: number; pool: number; supply: number }): Promise<Case[]> {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const cases: Case[] = [];
  const skipped: string[] = [];
  for (const chain of RANDOM_CHAINS) {
    const meta = chainMeta(chain);
    const client = getClient(chain);
    const tip = await client.getBlock({ blockTag: 'latest' });
    // a few blocks back, so every endpoint has the block and no model can have seen it
    const blocks = await Promise.all([5, 8, 11].map((d) => client.getBlock({ blockNumber: tip.number - BigInt(d) })));
    const hashes = blocks.flatMap((b) => b.transactions as `0x${string}`[]);
    const senders = new Set<string>();
    for (let i = 0, n = 0; n < perChain.tx && i < perChain.tx * 4; i++) {
      const hash = pick(hashes);
      try {
        const tx = await handleTransferVerify(validateTransferInput({ tx_hash: hash, chain })) as any;
        if (!(Number(tx.fee_total_native) > 0)) { skipped.push(`${chain} ${hash}: no fee`); continue; }
        cases.push({
          id: `rand-fee-${chain}-${n}`, desk: 'Settlement check (CRYPTO_TRANSFER_VERIFY)',
          question: `Did ${meta.label} transaction ${hash} succeed, and exactly how much ${meta.nativeSymbol} did its sender pay in fees? Answer the fee as one number in ${meta.nativeSymbol}.`,
          truth: Number(tx.fee_total_native), truthText: `${tx.status}, fee ${tx.fee_total_native} ${meta.nativeSymbol} (receipt, block ${tx.block_number})`, tolerance: 0.01,
        });
        if (tx.from) senders.add(String(tx.from));
        n++;
      } catch (e: any) { skipped.push(`${chain} ${hash}: ${e.message}`); }
    }
    for (const [n, address] of [...senders].slice(0, perChain.balance).entries()) {
      try {
        const b = await handleBalance(validateBalanceInput({ address, chain })) as any;
        if (!(Number(b.balance) > 0)) { skipped.push(`${chain} ${address}: zero balance`); continue; }
        cases.push({
          id: `rand-balance-${chain}-${n}`, desk: 'Listing review / holdings proof (wallet balance)',
          question: `What is the exact ${meta.nativeSymbol} balance of ${address} on ${meta.label} at block ${b.blockNumber}? Give one number in ${meta.nativeSymbol}.`,
          truth: Number(b.balance), truthText: `${b.balance_exact} ${meta.nativeSymbol} at block ${b.blockNumber}`, tolerance: 0.01,
        });
      } catch (e: any) { skipped.push(`${chain} ${address}: ${e.message}`); }
    }
    const logs = await client.getLogs({ fromBlock: blocks[2]!.number, toBlock: blocks[0]!.number, topics: [V3_SWAP] } as any).catch(() => [] as any[]);
    const pools = [...new Set(logs.map((l: any) => String(l.address)))];
    for (let i = 0, n = 0; n < perChain.pool && i < perChain.pool * 4 && pools.length > 0; i++) {
      const pool = pick(pools);
      try {
        const p = await handleLiquidity(validateLiquidityInput({ pool, chain })) as any;
        if (!(Number(p.liquidity_usd) > 1000)) { skipped.push(`${chain} ${pool}: under $1,000`); continue; }
        cases.push({
          id: `rand-liquidity-${chain}-${n}`, desk: 'Token preflight (pool depth)',
          question: `How much liquidity, in US dollars, does the pool ${pool} on ${meta.label} hold at block ${p.block_number}? Give one number in USD.`,
          truth: Number(p.liquidity_usd), truthText: `$${p.liquidity_usd} (${(p.reserves ?? []).map((r: any) => r.symbol).join('/') || 'pool'} reserves at block ${p.block_number})`, tolerance: 0.05,
        });
        pools.splice(pools.indexOf(pool), 1);
        n++;
      } catch (e: any) { skipped.push(`${chain} ${pool}: ${e.message}`); }
    }
    const table = Object.entries(KNOWN_TOKENS[chain] ?? {});
    for (let i = 0, n = 0; n < perChain.supply && i < perChain.supply * 4 && table.length > 0; i++) {
      const [sym, t] = table.splice(Math.floor(rnd() * table.length), 1)[0]!;
      try {
        const s = await handleSupply(validateSupplyInput({ token: `${sym} (${t.address}) on ${meta.label}` })) as any;
        cases.push({
          id: `rand-supply-${chain}-${sym}`, desk: 'Token preflight / holdings proof (total supply)',
          question: `What is the exact total supply of ${sym} (${t.address}) on ${meta.label} at block ${s.blockNumber}? Give one number in whole tokens.`,
          truth: Number(s.total_supply), truthText: `${s.total_supply_exact} ${sym} at block ${s.blockNumber}`, tolerance: 0.005,
        });
        n++;
      } catch (e: any) { skipped.push(`${chain} ${sym}: ${e.message}`); }
    }
    const gas = await handleGasPrice(validateGasPriceInput({ chain })) as any;
    cases.push({
      id: `rand-gas-${chain}`, desk: 'Execution (gas)',
      question: `What is the gas price on ${meta.label} at block ${gas.blockNumber ?? 'the latest block'}, in gwei? Give one number.`,
      truth: Number(gas.gas_price_gwei), truthText: `${gas.gas_price_gwei} gwei (eth_gasPrice)`, tolerance: 0.25,
    });
  }
  if (skipped.length) console.log(`skipped while drawing (${skipped.length}):\n  ${skipped.join('\n  ')}`);
  return cases;
}

/**
 * Two ways an agent asks. 'may-decline' lets the model say it cannot know;
 * 'agent' is how a tool-less trading agent is often prompted: a number only.
 */
const CONDITION = process.argv.includes('--agent') ? 'agent' : 'may-decline';
const SYSTEM = CONDITION === 'agent'
  ? 'You are the data step of an autonomous trading agent. Reply with exactly one number and nothing else.'
  : 'Answer the question directly. If you give a figure, give exactly one number. If you cannot know, say so.';

/** Models that refuse a temperature setting (reasoning models) are asked again without one. */
const NO_TEMPERATURE = new Set<string>();

async function ask(base: string, key: string, model: string, question: string) {
  const t0 = Date.now();
  const post = (withTemperature: boolean) => fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // room for reasoning models to think and still answer
    body: JSON.stringify({ model, ...(withTemperature ? { temperature: 0 } : {}), max_tokens: 4000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }] }),
  });
  let res = await post(!NO_TEMPERATURE.has(model));
  let body: any = await res.json().catch(() => ({}));
  if (res.status === 400 && /temperature/i.test(JSON.stringify(body))) {
    NO_TEMPERATURE.add(model);
    res = await post(false);
    body = await res.json().catch(() => ({}));
  }
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`, ms: Date.now() - t0 };
  const msg = body?.choices?.[0]?.message ?? {};
  return {
    ok: true as const, text: String(msg.content ?? ''), finish: body?.choices?.[0]?.finish_reason ?? null,
    reasoningChars: String(msg.reasoning_content ?? msg.reasoning ?? '').length, usage: body?.usage ?? null, ms: Date.now() - t0,
  };
}

/** The figures in a reply, with thousands separators removed and k/M/B suffixes applied. */
export function figures(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(/(\d),(?=\d{3})/g, '$1').matchAll(/(-?\d+(?:\.\d+)?)\s*(k|thousand|m|million|b|billion|t|trillion)?\b/gi)) {
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 }[(m[2] ?? '').toLowerCase()] ?? 1;
    out.push(Number(m[1]) * mult);
  }
  return out;
}

type Verdict = 'correct' | 'wrong' | 'declined' | 'empty';

/** A reply that says it cannot know or look the answer up */
const DECLINES = /\b(can(?:'|’|no)?t|cannot|unable to|don(?:'|’)t have|do not have|no (?:access|tools|way|live)|not able to|impossible to)\b/i;

export function score(c: Case, text: string): Verdict {
  if (text.trim() === '') return 'empty';
  // a bare "0" is a figure an agent would act on, not a refusal (no case's true value is 0)
  if (!c.expect && /^\s*0(?:\.0+)?\s*$/.test(text)) return 'wrong';
  if (c.expect) {
    const first = text.trim().toLowerCase().replace(/^[*_#\s]+/, '').match(/^(yes|no)\b/)?.[1];
    if (first) return first === c.expect ? 'correct' : 'wrong';
    return DECLINES.test(text) ? 'declined' : 'wrong';
  }
  const truth = Number(c.truth);
  // the question's own numbers (block, address digits) are not answers
  const qn = new Set(figures(c.question));
  const nums = figures(text).filter((n) => !qn.has(n) && n !== 0);
  if (nums.some((n) => Math.abs(n - truth) <= Math.abs(truth) * c.tolerance!)) return 'correct';
  // a reply that declines is not counted wrong for the incidental numbers it mentions
  if (DECLINES.test(text) || nums.length === 0) return 'declined';
  return 'wrong';
}

/** Score a saved run again with the current rules, without asking the models: --rescore <file.json> */
function rescore(file: string) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map<string, Case>(run.cases.map((c: Case) => [c.id, c]));
  for (const r of run.results) if (r.verdict !== 'error') r.verdict = score(byId.get(r.case)!, String(r.reply ?? ''));
  writeFileSync(file, JSON.stringify(run, null, 2));
  const models = [...new Set<string>(run.results.map((r: any) => r.model))];
  const tally = (m: string, v: string) => run.results.filter((r: any) => r.model === m && r.verdict === v).length;
  const lines = [
    `| Model | Correct | Wrong | Declined | Empty | Errors |`, `|---|---|---|---|---|---|`,
    ...models.map((m) => `| ${m} | ${tally(m, 'correct')} | ${tally(m, 'wrong')} | ${tally(m, 'declined')} | ${tally(m, 'empty')} | ${tally(m, 'error')} |`),
    `| Truvian (chain reads) | ${run.cases.length} | 0 | 0 | 0 | 0 |`,
  ];
  writeFileSync(file.replace(/\.json$/, '.md'), `${lines.join('\n')}\n`);
  console.log(`${file}\n${lines.join('\n')}`);
}

async function main() {
  const at = process.argv.indexOf('--rescore');
  if (at > 0) return rescore(process.argv[at + 1]!);
  const dry = process.argv.includes('--dry');
  // a number-only prompt cannot ask a yes/no question, so that case runs only when the model may decline
  const random = process.argv.includes('--random');
  const seedAt = process.argv.indexOf('--seed');
  const seed = seedAt > 0 ? Number(process.argv[seedAt + 1]) : Number((await getClient('ethereum').getBlockNumber()) % 1_000_000n);
  if (random) console.log(`random draw, seed ${seed}`);
  const cases = (random ? await buildRandomCases(seed, { tx: 4, balance: 3, pool: 2, supply: 2 }) : await buildCases())
    .filter((c) => CONDITION === 'may-decline' || c.expect === undefined);
  console.log(`${cases.length} cases read from the chain`);
  for (const c of cases) console.log(`- ${c.id}: ${c.truthText}`);
  if (dry) return;

  const base = process.env.LLM_BASE_URL, key = process.env.LLM_API_KEY;
  const models = (process.env.LLM_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (!base || !key || models.length === 0) throw new Error('set LLM_BASE_URL, LLM_API_KEY and LLM_MODELS in .env');

  const results: any[] = [];
  for (const model of models) {
    for (const c of cases) {
      const r = await ask(base, key, model, c.question);
      const verdict = r.ok ? score(c, r.text) : 'error';
      results.push({ model, case: c.id, verdict, reply: r.ok ? r.text : r.error, finish: r.ok ? r.finish : null,
        reasoningChars: r.ok ? r.reasoningChars : null, usage: r.ok ? r.usage : null, ms: r.ms });
      console.log(`${model} ${c.id}: ${verdict}`);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync('docs/frontier-comparison', { recursive: true });
  const stem = `docs/frontier-comparison/${date}${random ? '-random' : ''}-${CONDITION}`;
  writeFileSync(`${stem}.json`, JSON.stringify({ ranAt: new Date().toISOString(), condition: CONDITION, system: SYSTEM, ...(random ? { seed } : {}), cases, results }, null, 2));
  const tally = (m: string, v: string) => results.filter((r) => r.model === m && r.verdict === v).length;
  const lines = [
    `| Model | Correct | Wrong | Declined | Empty | Errors |`, `|---|---|---|---|---|---|`,
    ...models.map((m) => `| ${m} | ${tally(m, 'correct')} | ${tally(m, 'wrong')} | ${tally(m, 'declined')} | ${tally(m, 'empty')} | ${tally(m, 'error')} |`),
    `| Truvian (chain reads) | ${cases.length} | 0 | 0 | 0 | 0 |`,
  ];
  writeFileSync(`${stem}.md`, `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
