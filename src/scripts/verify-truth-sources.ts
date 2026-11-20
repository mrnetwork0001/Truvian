/**
 * Live verification of the truth sources in evaluator/truth-sources/.
 *
 * A truth source is evaluation material for a deterministic Telegraph intent:
 * a public, keyless API described in miner-YAML format. Each epoch the node
 * calls a few of them and scores every miner against the median, so a source
 * that is wrong makes correct miners look wrong. This script checks each one
 * the way the node uses it:
 *   1. the descriptor passes the checks the node documents for truth sources
 *   2. the request is built from the descriptor itself (base_url,
 *      external_path, declared params), the value is read at the mapped
 *      output path and converted from the mapped unit
 *   3. that value is compared with the chain, read from archive RPCs
 *
 * One step is done by hand here that the node does with a model: turning the
 * intent's `chain` name into the `chain_id` the API takes (the mapping's
 * `how`). CHAIN_IDS below is that step.
 *
 * Exits non-zero on any failure. Run: npm run verify:truth
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { formatUnits } from 'viem';
import { getClient, getRpcClients, type SupportedChain } from '../config/chains.js';
import { TRUTH_CHAINS, stateArchives } from '../truth/balance.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!cond) failures++;
}

const CHAIN_IDS: Record<string, string> = {
  ethereum: '1', polygon: '137', arbitrum: '42161', avalanche: '43114', optimism: '10', base: '8453', bsc: '56',
};

const ROOT_KEYS = new Set([
  'version', 'kind', 'id', 'slug', 'protocol', 'name', 'description', 'base_url', 'input_schema', 'output_schema',
  'intent_mapping', 'polling', 'cache_ttl_sec', 'rate_limit_per_sec', 'circuit_threshold', 'circuit_cooldown_seconds',
  'docs', 'limitations', 'errors', 'auth', 'endpoints', 'semantics', 'on_chain',
]);
const ENDPOINT_KEYS = new Set([
  'path', 'external_path', 'method', 'description', 'intents', 'params', 'endpoint_base_url', 'content_type',
  'multipart_fields', 'param_map',
]);

interface Source { file: string; text: string; doc: any }

function load(file: string): Source {
  const text = readFileSync(new URL(`../../evaluator/truth-sources/${file}`, import.meta.url), 'utf8');
  return { file, text, doc: parse(text) };
}

/** The checks listed under "What a truth source must pass" in the evaluation-data docs. */
function checkDescriptor(src: Source, intent: string) {
  const { doc, file, text } = src;
  check(`${file}: under 32 KB and at most 32 endpoints`, Buffer.byteLength(text) < 32_000 && doc.endpoints.length <= 32);
  check(`${file}: no keys outside the miner YAML schema`,
    Object.keys(doc).every((k) => ROOT_KEYS.has(k)) && doc.endpoints.every((e: any) => Object.keys(e).every((k) => ENDPOINT_KEYS.has(k))));
  check(`${file}: needs no key (auth.type none, no inject)`, doc.auth?.type === 'none' && doc.auth.inject === undefined);
  check(`${file}: base_url is public https`, /^https:\/\/[a-z0-9.-]+\.[a-z]+$/.test(doc.base_url) && !/localhost|\.local$|\.internal$/.test(doc.base_url));
  check(`${file}: an endpoint lists ${intent}`, doc.endpoints.some((e: any) => e.intents?.includes(intent)));
  // The node's schema refuses accepted_fields written as a list, the form its
  // docs show: "accepted_fields: Invalid type. Expected: object, given: array".
  // Two uploads were rejected as source_unparseable for it on 2026-11-14.
  check(`${file}: no accepted_fields (the node's schema refuses the documented list form)`, !/accepted_fields/.test(text.replace(/^\s*#.*$/gm, '')));
  check(`${file}: id is not 0`, Number.isInteger(doc.id) && doc.id > 0);
  const map = doc.intent_mapping?.[intent];
  const ep = doc.endpoints.find((e: any) => e.path === map?.endpoint);
  const declared = ep ? Object.values(ep.params ?? {}).flatMap((g: any) => [...(g.required ?? []), ...(g.optional ?? [])].map((p: any) => p.name)) : [];
  check(`${file}: mapping points at a declared endpoint and only at declared params`,
    !!ep && Object.keys(map.input).every((p) => declared.includes(p)));
}

/**
 * Build and send the request the descriptor describes, then read the mapped
 * output field. Returns null when the source gives no value: a parameter is
 * outside the input_schema enum, the HTTP call fails, or the API reports
 * failure at errors.status_path.
 */
async function ask(src: Source, intent: string, inputs: Record<string, string | number>): Promise<{ value: string; url: string } | { value: null; why: string }> {
  const { doc } = src;
  const map = doc.intent_mapping[intent];
  const ep = doc.endpoints.find((e: any) => e.path === map.endpoint);
  let path: string = ep.external_path;
  const query = new URLSearchParams();
  for (const [group, lists] of Object.entries<any>(ep.params)) {
    for (const p of [...(lists.required ?? []), ...(lists.optional ?? [])]) {
      const value = inputs[p.name];
      if (value === undefined) return { value: null, why: `no value for ${p.name}` };
      const allowed: unknown[] | undefined = doc.input_schema?.properties?.[p.name]?.enum;
      if (allowed && !allowed.includes(String(value))) {
        return { value: null, why: `${p.name}=${value} is not in the input_schema enum` };
      }
      if (group === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
      else query.set(p.name, String(value));
    }
  }
  const url = `${doc.base_url}${path}${query.size ? (path.includes('?') ? '&' : '?') + query : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { value: null, why: `HTTP ${res.status}` };
  const body: any = await res.json();
  const at = (p: string) => p.split('.').reduce((o, k) => o?.[k], body);
  if (doc.errors?.status_path) {
    const status = String(at(doc.errors.status_path));
    if (!(doc.errors.success_values ?? ['200']).includes(status)) return { value: null, why: `status ${status}: ${at(doc.errors.message_path)}` };
  }
  const field = Object.values<any>(map.output)[0];
  const raw = at(field.path);
  if (raw === undefined || raw === null) return { value: null, why: `nothing at ${field.path}` };
  // exact decimal conversion to gwei, the unit of both scored fields
  const value = field.unit === 'wei' ? formatUnits(BigInt(raw), 9) : String(raw);
  return { value, url };
}

async function verifyBalanceSource() {
  const intent = 'ONCHAIN_METRIC_VERIFY_GENERAL';
  const src = load('onchain-metric-routescan.yaml');
  checkDescriptor(src, intent);

  // Ethereum: addresses and blocks taken from the chain itself, across five years of history
  const tip = await getClient('ethereum').getBlockNumber();
  const archive = getRpcClients('ethereum').filter((e) => e.fullHistory);
  let compared = 0;
  for (const [age, days] of [['2 days', 2], ['60 days', 60], ['1 year', 365], ['3 years', 1095], ['5 years', 1825]] as const) {
    const blockNumber = tip - BigInt(Math.round((days * 86_400) / 12));
    let block;
    for (const { client } of archive) {
      block = await client.getBlock({ blockNumber, includeTransactions: true }).catch(() => null);
      if (block) break;
    }
    const tx = block?.transactions.find((t) => typeof t !== 'string' && t.to);
    if (!block || !tx || typeof tx === 'string') { check(`balance: found a ${age} old block to sample`, false); continue; }
    for (const address of [tx.from, tx.to!]) {
      let truth: bigint | null = null;
      for (const { client } of archive) {
        truth = await client.getBalance({ address, blockNumber }).catch(() => null);
        if (truth !== null) break;
      }
      const got = await ask(src, intent, { chain_id: CHAIN_IDS.ethereum!, address, blockno: Number(blockNumber) });
      compared++;
      check(
        `balance: ${age} old, ${address.slice(0, 10)}… at block ${blockNumber} equals eth_getBalance to the wei`,
        truth !== null && got.value !== null && got.value === formatUnits(truth, 9),
        got.value !== null ? `${got.value} gwei` : got.why,
      );
      await new Promise((r) => setTimeout(r, 600)); // stay well inside the free rate limit
    }
  }
  check('balance: ten address/block pairs compared', compared === 10, String(compared));

  // Chains the API does not cover must yield no value, never another chain's number
  for (const chain of ['polygon', 'arbitrum'] as const) {
    const got = await ask(src, intent, { chain_id: CHAIN_IDS[chain]!, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', blockno: 20_000_000 });
    check(`balance: ${chain} gives no value`, got.value === null, got.value === null ? got.why : got.value);
  }
}

async function verifyGasSource() {
  const intent = 'GAS_PRICE_GENERAL';
  const src = load('gas-price-metamask.yaml');
  checkDescriptor(src, intent);

  for (const chain of ['ethereum', 'arbitrum', 'avalanche'] as const satisfies readonly SupportedChain[]) {
    const client = getClient(chain);
    const [got, gasPrice, block] = await Promise.all([
      ask(src, intent, { chain_id: CHAIN_IDS[chain]! }),
      client.getGasPrice(),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    if (got.value === null) { check(`gas: ${chain} answered`, false, got.why); continue; }
    const source = Number(got.value);
    const node = Number(formatUnits(gasPrice, 9));
    const baseFee = Number(formatUnits(block.baseFeePerGas ?? 0n, 9));
    const off = Math.abs(source - node) / node;
    // The base fee moves at most 12.5% per block and the two reads are a block apart at worst
    check(`gas: ${chain} within 15% of eth_gasPrice`, off <= 0.15,
      `source ${source} gwei, eth_gasPrice ${node} gwei, block base fee ${baseFee} gwei, off by ${(off * 100).toFixed(2)}%`);
  }

  // Chains where the base fee is not the gas price are refused by the descriptor itself
  for (const chain of ['polygon', 'optimism', 'base', 'bsc'] as const) {
    const got = await ask(src, intent, { chain_id: CHAIN_IDS[chain]! });
    check(`gas: ${chain} is not offered`, got.value === null, got.value === null ? got.why : got.value);
  }
}

/**
 * Our own truth API (onchain-metric-truvian.yaml). Its values come from the
 * same archive endpoints it reads, so the check that matters is the path the
 * node takes: the request built from the descriptor reaches the live API over
 * HTTPS and the mapped field, unit-converted, equals the chain's balance.
 */
async function verifyTruvianBalanceSource() {
  const intent = 'ONCHAIN_METRIC_VERIFY_GENERAL';
  const src = load('onchain-metric-truvian.yaml');
  checkDescriptor(src, intent);
  const seconds: Record<string, number> = { ethereum: 12, polygon: 2, arbitrum: 0.25 };
  for (const chain of TRUTH_CHAINS) {
    const archives = stateArchives(chain);
    const tip = await archives[0]!.client.getBlockNumber();
    for (const [age, days] of [['2 days', 2], ['1 year', 365]] as const) {
      const blockNumber = tip - BigInt(Math.round((days * 86_400) / seconds[chain]!));
      let block;
      for (const { client } of archives) {
        block = await client.getBlock({ blockNumber, includeTransactions: true }).catch(() => null);
        if (block) break;
      }
      const tx = block?.transactions[block.transactions.length - 1];
      if (!block || !tx || typeof tx === 'string') { check(`truvian ${chain}: found a ${age} old block`, false); continue; }
      let truth: bigint | null = null;
      for (const { client } of archives) {
        truth = await client.getBalance({ address: tx.from, blockNumber }).catch(() => null);
        if (truth !== null) break;
      }
      const got = await ask(src, intent, { chain, address: tx.from, block: Number(blockNumber) });
      check(`truvian ${chain}: ${age} old balance through the live API equals eth_getBalance`,
        truth !== null && got.value !== null && got.value === formatUnits(truth, 9),
        got.value !== null ? `${got.value} gwei` : got.why);
    }
  }
  const outside = await ask(src, intent, { chain: 'base', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', block: 1 });
  check('truvian: a chain the intent does not allow gives no value', outside.value === null, outside.value === null ? outside.why : outside.value);
}

async function main() {
  await verifyBalanceSource();
  console.log('');
  await verifyTruvianBalanceSource();
  console.log('');
  await verifyGasSource();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
