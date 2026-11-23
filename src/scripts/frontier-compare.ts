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
 * Run: npx tsx src/scripts/frontier-compare.ts [--dry]   (--dry reads the chain only)
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient } from '../config/chains.js';
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
  return cases;
}

const SYSTEM = 'Answer the question directly. If you give a figure, give exactly one number. If you cannot know, say so.';

async function ask(base: string, key: string, model: string, question: string) {
  const t0 = Date.now();
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 400, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }] }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`, ms: Date.now() - t0 };
  return { ok: true as const, text: String(body?.choices?.[0]?.message?.content ?? ''), usage: body?.usage ?? null, ms: Date.now() - t0 };
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

function score(c: Case, text: string): 'correct' | 'wrong' | 'no answer' {
  if (c.expect) {
    const first = text.trim().toLowerCase().match(/^\**\s*(yes|no)\b/)?.[1];
    return first === undefined ? 'no answer' : first === c.expect ? 'correct' : 'wrong';
  }
  const truth = Number(c.truth);
  // the question's own numbers (block, address digits) are not answers
  const qn = new Set(figures(c.question));
  const nums = figures(text).filter((n) => !qn.has(n) && n !== 0);
  if (nums.length === 0) return 'no answer';
  const best = nums.reduce((a, b) => (Math.abs(b - truth) < Math.abs(a - truth) ? b : a));
  return Math.abs(best - truth) <= Math.abs(truth) * c.tolerance! ? 'correct' : 'wrong';
}

async function main() {
  const dry = process.argv.includes('--dry');
  const cases = await buildCases();
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
      results.push({ model, case: c.id, verdict, reply: r.ok ? r.text : r.error, usage: r.ok ? r.usage : null, ms: r.ms });
      console.log(`${model} ${c.id}: ${verdict}`);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync('docs/frontier-comparison', { recursive: true });
  writeFileSync(`docs/frontier-comparison/${date}.json`, JSON.stringify({ ranAt: new Date().toISOString(), system: SYSTEM, cases, results }, null, 2));
  const tally = (m: string, v: string) => results.filter((r) => r.model === m && r.verdict === v).length;
  const lines = [
    `| Model | Correct | Wrong | No answer | Errors |`, `|---|---|---|---|---|`,
    ...models.map((m) => `| ${m} | ${tally(m, 'correct')} | ${tally(m, 'wrong')} | ${tally(m, 'no answer')} | ${tally(m, 'error')} |`),
    `| Truvian (chain reads) | ${cases.length} | 0 | 0 | 0 |`,
  ];
  writeFileSync(`docs/frontier-comparison/${date}.md`, `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
