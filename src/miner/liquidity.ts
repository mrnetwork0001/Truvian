/**
 * LIQUIDITY_DEPTH_VERIFY intent handler: the total liquidity of one DEX pool
 * in US dollars (the intent's scored field `liquidity_usd`).
 *
 * The figure is built from what the pool actually holds, not from an index:
 *   1. the pool's two tokens, read from its token0() and token1(),
 *   2. each token's balanceOf(pool), decimals() and symbol() at one block,
 *   3. each token's USD price from DefiLlama's keyless price API,
 * and the sum is cross-checked against GeckoTerminal's reserve_in_usd for the
 * same pool, which the answer reports beside it.
 *
 * A pool given by name ("WETH / USDC 0.05% on Base") is found with
 * GeckoTerminal's pool search on that chain; the answer names the pool it
 * chose and its address. A pool that keeps no token0()/token1() (Uniswap v4
 * pools, which have no contract of their own; Curve; Balancer) cannot be read
 * this way, and the answer then gives GeckoTerminal's figure and says so.
 *
 * Prices move, so the figure is for the stated block and price time.
 */
import { formatUnits, getAddress, parseAbi } from 'viem';
import { chainMeta, getRpcClients, type SupportedChain } from '../config/chains.js';
import { IntentError } from '../types/index.js';
import { contractAnswered, readText } from './holdings.js';
import { chainFromText, normalizeChain, requireChain } from './txLookup.js';

const POOL = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/** GeckoTerminal network ids, DefiLlama chain keys and DexScreener chain ids for the chains this intent is served on */
const NETWORKS: Partial<Record<SupportedChain, { gecko: string; llama: string; dexscreener: string }>> = {
  ethereum: { gecko: 'eth', llama: 'ethereum', dexscreener: 'ethereum' },
  base: { gecko: 'base', llama: 'base', dexscreener: 'base' },
  arbitrum: { gecko: 'arbitrum', llama: 'arbitrum', dexscreener: 'arbitrum' },
  optimism: { gecko: 'optimism', llama: 'optimism', dexscreener: 'optimism' },
  polygon: { gecko: 'polygon_pos', llama: 'polygon', dexscreener: 'polygon' },
  bsc: { gecko: 'bsc', llama: 'bsc', dexscreener: 'bsc' },
  avalanche: { gecko: 'avax', llama: 'avax', dexscreener: 'avalanche' },
  scroll: { gecko: 'scroll', llama: 'scroll', dexscreener: 'scroll' },
  linea: { gecko: 'linea', llama: 'linea', dexscreener: 'linea' },
  gnosis: { gecko: 'xdai', llama: 'xdai', dexscreener: 'gnosischain' },
  zksync: { gecko: 'zksync', llama: 'era', dexscreener: 'zksync' },
};

const FETCH_TIMEOUT_MS = 8_000;
/** Index answers are reused for a minute: GeckoTerminal allows keyless callers about 30 requests a minute */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: any }>();

export interface LiquidityInput {
  chain: SupportedChain;
  /** EIP-55 when the request gave an address */
  address: `0x${string}` | null;
  /** The words given for the pool when no address was */
  name: string | null;
}

export function validateLiquidityInput(raw: unknown): LiquidityInput {
  if (typeof raw !== 'object' || raw === null) throw new IntentError('INVALID_INPUT', 'input must be an object');
  const body = raw as Record<string, unknown>;
  const pool = String(body.pool ?? body.pool_address ?? body.address ?? body.query ?? '').replace(/\s+/g, ' ').trim();
  if (!pool) throw new IntentError('INVALID_INPUT', 'pool is required: the DEX pool\'s contract address, or its name such as "WETH / USDC 0.05%"');
  const chainRaw = body.chain ?? body.network;
  const chain = chainRaw !== undefined && String(chainRaw).trim() !== ''
    ? requireChain(chainRaw)
    : chainFromText(pool) ?? (() => { throw new IntentError('INVALID_INPUT', 'chain is required: the chain the pool is on, such as ethereum or base'); })();
  if (!NETWORKS[chain]) {
    throw new IntentError('CHAIN_UNSUPPORTED', `pool liquidity is served on ${Object.keys(NETWORKS).join(', ')}; got ${normalizeChain(chainRaw ?? chain)}`);
  }
  const found = pool.match(ADDRESS);
  if (found) return { chain, address: getAddress(found[0]), name: null };
  // a chain named inside the pool text ("WETH/USDC on Base") is not part of the name
  const name = pool.replace(/\s+on\s+[A-Za-z][\w -]*$/i, '').trim();
  return { chain, address: null, name };
}

async function getJson(url: string): Promise<any> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new IntentError('UPSTREAM_RPC_ERROR', `${new URL(url).host} answered HTTP ${res.status}`);
    const value = await res.json();
    cache.set(url, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (err instanceof IntentError) throw err;
    throw new IntentError('UPSTREAM_RPC_ERROR', `${new URL(url).host} did not answer: ${(err as Error).name === 'AbortError' ? `no answer within ${FETCH_TIMEOUT_MS / 1000} s` : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

interface IndexPool {
  address: `0x${string}`;
  name: string;
  /** The pool's token symbols, upper case */
  symbols: string[];
  /** Fee tier as written in the name ("0.05%"), when it has one */
  fee: string | null;
  reserveUsd: number | null;
  dex: string | null;
  /** Where it was listed: GeckoTerminal or DexScreener */
  index: string;
}

const FEE = /(\d+(?:\.\d+)?)\s*%/;
const symbolsOf = (name: string) => name.replace(FEE, ' ').split(/\s*\/\s*/).map((s) => s.trim().toUpperCase()).filter(Boolean);

async function geckoPool(chain: SupportedChain, address: `0x${string}`): Promise<IndexPool | null> {
  try {
    const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/${NETWORKS[chain]!.gecko}/pools/${address}`);
    const a = j?.data?.attributes;
    if (!a) return null;
    const name = String(a.name);
    return { address, name, symbols: symbolsOf(name), fee: name.match(FEE)?.[1] ?? null, reserveUsd: a.reserve_in_usd == null ? null : Number(a.reserve_in_usd), dex: j.data.relationships?.dex?.data?.id ?? null, index: 'GeckoTerminal' };
  } catch {
    return null; // the cross-check is optional; the on-chain figure stands alone
  }
}

/** What a pool name asks for: token symbols, a fee tier and words naming a DEX or version. */
export function parsePoolName(name: string): { symbols: string[]; fee: string | null; words: string[] } {
  const fee = name.match(FEE)?.[1] ?? null;
  const rest = name.replace(FEE, ' ');
  const parts = rest.split(/\s*[\/\-]\s*|\s+/).map((s) => s.trim()).filter(Boolean);
  const DEX_WORDS = /^(uniswap|sushiswap|sushi|pancakeswap|pancake|aerodrome|velodrome|camelot|curve|balancer|trader|joe|quickswap|v[1-4]|pool|pair|lp|dex|cl|slipstream|the|liquidity)$/i;
  const words = parts.filter((p) => DEX_WORDS.test(p) && !/^(pool|pair|lp|dex|the|liquidity)$/i.test(p)).map((w) => w.toLowerCase());
  const symbols = parts.filter((p) => !DEX_WORDS.test(p)).map((p) => p.toUpperCase());
  return { symbols, fee, words };
}

async function searchGecko(chain: SupportedChain, query: string): Promise<IndexPool[]> {
  const j = await getJson(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=${NETWORKS[chain]!.gecko}`);
  return (j?.data ?? [])
    .filter((p: any) => typeof p?.attributes?.address === 'string' && ADDRESS.test(p.attributes.address) && p.attributes.address.length === 42)
    .map((p: any) => {
      const name = String(p.attributes.name);
      return {
        address: getAddress(p.attributes.address), name, symbols: symbolsOf(name), fee: name.match(FEE)?.[1] ?? null,
        reserveUsd: p.attributes.reserve_in_usd == null ? null : Number(p.attributes.reserve_in_usd),
        dex: p.relationships?.dex?.data?.id ?? null, index: 'GeckoTerminal',
      };
    });
}

async function searchDexScreener(chain: SupportedChain, query: string): Promise<IndexPool[]> {
  const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
  return (j?.pairs ?? [])
    .filter((p: any) => p?.chainId === NETWORKS[chain]!.dexscreener && typeof p.pairAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress))
    .map((p: any) => {
      const symbols = [String(p.baseToken?.symbol ?? '').toUpperCase(), String(p.quoteToken?.symbol ?? '').toUpperCase()];
      const label = Array.isArray(p.labels) && p.labels.length ? ` ${p.labels.join(' ')}` : '';
      return {
        address: getAddress(p.pairAddress), name: `${symbols.join(' / ')} (${p.dexId}${label})`, symbols, fee: null,
        reserveUsd: typeof p.liquidity?.usd === 'number' ? p.liquidity.usd : null, dex: `${p.dexId}${label}`, index: 'DexScreener',
      };
    });
}

/**
 * The pool a name refers to. Candidates come from GeckoTerminal's pool search
 * on the chain, or DexScreener's when GeckoTerminal does not answer. A
 * candidate must hold every symbol named and no other token, then match the
 * fee tier and DEX words named, if any; the deepest of those is chosen.
 */
async function poolByName(chain: SupportedChain, name: string): Promise<{ chosen: IndexPool; matches: number }> {
  const want = parsePoolName(name);
  if (want.symbols.length === 0) {
    throw new IntentError('INVALID_INPUT', `"${name}" names no tokens; give the pool's contract address or its tokens, as in "WETH / USDC 0.05%"`);
  }
  const query = want.symbols.join(' ');
  let pools: IndexPool[];
  try {
    pools = await searchGecko(chain, query);
  } catch {
    pools = await searchDexScreener(chain, query);
  }
  const sameTokens = (p: IndexPool) => p.symbols.length === want.symbols.length && want.symbols.every((s) => p.symbols.includes(s));
  let matches = pools.filter(sameTokens);
  if (want.fee) matches = matches.filter((p) => p.fee === null || Number(p.fee) === Number(want.fee));
  if (want.words.length) {
    const withWords = matches.filter((p) => want.words.every((w) => `${p.dex ?? ''} ${p.name}`.toLowerCase().includes(w)));
    if (withWords.length) matches = withWords;
  }
  if (matches.length === 0) {
    throw new IntentError('INVALID_INPUT', `no pool of exactly ${want.symbols.join(' and ')}${want.fee ? ` at ${want.fee}%` : ''} was found on ${chainMeta(chain).label}; give the pool's contract address`);
  }
  matches.sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0));
  return { chosen: matches[0]!, matches: matches.length };
}

/** A call on the first endpoint that answers; the contract's own failure (revert, no data) is returned as null. */
async function firstAnswer<T>(chain: SupportedChain, read: (client: any) => Promise<T>): Promise<T | null> {
  let last: unknown = null;
  for (const { client } of getRpcClients(chain)) {
    try {
      return await read(client);
    } catch (err) {
      if (contractAnswered(err)) return null;
      last = err;
    }
  }
  throw new IntentError('UPSTREAM_RPC_ERROR', `no ${chainMeta(chain).label} endpoint answered: ${(last as any)?.shortMessage ?? (last as any)?.message ?? 'no answer'}`);
}

/** A float price as an exact decimal string with 12 places, then scaled, so the sum is done in integers. */
const PRICE_PLACES = 12;
function priceScaled(price: number): bigint {
  const [int, frac = ''] = price.toFixed(PRICE_PLACES).split('.');
  return BigInt(int! + frac.padEnd(PRICE_PLACES, '0'));
}

interface Side { token: `0x${string}`; symbol: string; decimals: number; raw: bigint; amount: string; priceUsd: number | null; valueUsd: string | null }

export async function handleLiquidity(input: LiquidityInput) {
  const { chain } = input;
  const meta = chainMeta(chain);
  const net = NETWORKS[chain]!;

  let address = input.address;
  let chosenBy: string | null = null;
  let gecko: IndexPool | null = null;
  if (!address) {
    const { chosen, matches } = await poolByName(chain, input.name!);
    address = chosen.address;
    gecko = chosen.index === 'GeckoTerminal' ? chosen : null;
    chosenBy = `"${input.name}" was matched to ${chosen.name} (${address})${chosen.dex ? ` on ${chosen.dex}` : ''}, the deepest of ${matches} matching pool${matches === 1 ? '' : 's'} in ${chosen.index}'s search on ${meta.label}.`;
  }

  const block = await firstAnswer(chain, (c) => c.getBlockNumber()) as bigint;
  const [t0, t1] = await Promise.all([
    firstAnswer(chain, (c) => c.readContract({ address, abi: POOL, functionName: 'token0', blockNumber: block })),
    firstAnswer(chain, (c) => c.readContract({ address, abi: POOL, functionName: 'token1', blockNumber: block })),
  ]) as [`0x${string}` | null, `0x${string}` | null];
  if (!gecko) gecko = await geckoPool(chain, address);

  // A pool with no token0()/token1() of its own: only an index can price it.
  if (!t0 || !t1) {
    if (!gecko || gecko.reserveUsd === null) {
      throw new IntentError('INVALID_INPUT', `${address} on ${meta.label} has no token0() and token1(), so its reserves cannot be read from the chain, and GeckoTerminal lists no pool at that address`);
    }
    const usd = gecko.reserveUsd.toFixed(6);
    return {
      answer: `${chosenBy ? `${chosenBy} ` : ''}The pool ${gecko.name} (${address}) on ${meta.label} has total liquidity of $${usd} according to GeckoTerminal's reserve_in_usd. Its contract has no token0() and token1(), so its reserves could not be read from the chain and this figure is not checked against it.`,
      liquidity_usd: Number(usd),
      pool_address: address,
      pool_name: gecko.name,
      chain,
      method: 'geckoterminal_reserve_in_usd',
      confidence: 0.6,
      checked_at: new Date().toISOString(),
    };
  }

  const tokens = [getAddress(t0), getAddress(t1)] as const;
  const prices = await getJson(`https://coins.llama.fi/prices/current/${tokens.map((t) => `${net.llama}:${t}`).join(',')}`);
  const sides: Side[] = await Promise.all(tokens.map(async (token) => {
    const [raw, decimals, symbol] = await Promise.all([
      firstAnswer(chain, (c) => c.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address!], blockNumber: block })),
      firstAnswer(chain, (c) => c.readContract({ address: token, abi: ERC20, functionName: 'decimals', blockNumber: block })),
      firstAnswer(chain, (c) => readText(c, token, 'symbol', block)),
    ]);
    if (raw === null || decimals === null) throw new IntentError('INVALID_INPUT', `${token}, a token of pool ${address}, does not answer balanceOf() and decimals() as an ERC-20`);
    const d = Number(decimals);
    const entry = prices?.coins?.[`${net.llama}:${token}`];
    const priceUsd = typeof entry?.price === 'number' && entry.price > 0 ? entry.price : null;
    const valueUsd = priceUsd === null ? null : formatUnits((raw as bigint) * priceScaled(priceUsd), d + PRICE_PLACES);
    return { token, symbol: String(symbol ?? token), decimals: d, raw: raw as bigint, amount: formatUnits(raw as bigint, d), priceUsd, valueUsd };
  }));

  const unpriced = sides.filter((s) => s.valueUsd === null);
  if (unpriced.length > 0) {
    throw new IntentError('UPSTREAM_RPC_ERROR', `DefiLlama has no USD price for ${unpriced.map((s) => `${s.symbol} (${s.token})`).join(' and ')}, so the pool's liquidity in dollars cannot be computed from its reserves`);
  }
  // Exact sum over a common denominator: each side is raw x price / 10^(decimals + PRICE_PLACES) dollars
  const D = Math.max(...sides.map((s) => s.decimals));
  const total = sides.reduce((acc, s) => acc + s.raw * priceScaled(s.priceUsd!) * 10n ** BigInt(D - s.decimals), 0n);
  const scale = 10n ** BigInt(D + PRICE_PLACES - 6); // to the field's 6 decimals, rounded half up
  const micros = (total + scale / 2n) / scale;
  const usd = formatUnits(micros, 6);
  const usdNumber = Number(usd);

  const name = gecko?.name ?? `${sides[0]!.symbol} / ${sides[1]!.symbol}`;
  const check = gecko?.reserveUsd != null && gecko.reserveUsd > 0
    ? `GeckoTerminal's reserve_in_usd for the same pool is $${gecko.reserveUsd.toFixed(2)}, ${(Math.abs(usdNumber - gecko.reserveUsd) / gecko.reserveUsd * 100).toFixed(2)}% ${usdNumber >= gecko.reserveUsd ? 'below' : 'above'} this figure.`
    : 'GeckoTerminal lists no reserve figure for this pool to check against.';
  const sideText = sides.map((s) => `${s.amount} ${s.symbol} at $${s.priceUsd} ($${Number(s.valueUsd).toFixed(2)})`).join(' and ');

  return {
    answer: `${chosenBy ? `${chosenBy} ` : ''}The pool ${name} (${address}) on ${meta.label} holds $${usd} of liquidity at block ${block}: ${sideText}. Reserves are the pool's balanceOf() of each token read on-chain; prices are DefiLlama's. ${check}`,
    liquidity_usd: usdNumber,
    pool_address: address,
    pool_name: name,
    chain,
    block_number: Number(block),
    reserves: sides.map((s) => ({ token: s.token, symbol: s.symbol, amount: s.amount, price_usd: s.priceUsd, value_usd: s.valueUsd })),
    geckoterminal_reserve_usd: gecko?.reserveUsd ?? null,
    method: 'onchain_reserves_x_defillama_prices',
    confidence: 0.95,
    checked_at: new Date().toISOString(),
  };
}
