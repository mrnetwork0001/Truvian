/**
 * CoinGecko's public token lists, used to find the contract of a token that a
 * question names by symbol or name when the verified table in
 * src/config/tokens.ts does not hold it.
 *
 * The node asks about any token: "Kelp DAO Restaked ETH (rsETH) on Ethereum",
 * "Bancor (BNT) on Ethereum". CoinGecko publishes one list per chain at
 * https://tokens.coingecko.com/<platform>/all.json, with no key, in the
 * Uniswap token-list format: { tokens: [{ chainId, address, name, symbol,
 * decimals }] }, addresses in lower case.
 *
 * Probed 2026-11-21: every platform below answered 200 with JSON (Cloudflare,
 * max-age 1800; each list is regenerated about daily). The Ethereum list has
 * 5,773 tokens, among them rsETH (0xa1290d69…) and BNT (0x1f573d6f…);
 * /uniswap/all.json, its older name, serves the same file byte for byte. The
 * Uniswap Labs default list (tokens.uniswap.org) has no rsETH and is not used.
 * There is no list for Sepolia or Base Sepolia, and an unknown platform
 * answers 403 with an XML body.
 *
 * A list only says where to look. The caller reads the contract at the
 * anchoring block and requires its symbol() to agree before giving any
 * figure (src/miner/holdings.ts).
 */
import { getAddress } from 'viem';
import { chainMeta, type SupportedChain } from '../config/chains.js';
import { IntentError } from '../types/index.js';

/** CoinGecko asset-platform id of each served chain that has a list. */
const PLATFORMS: Partial<Record<SupportedChain, string>> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bsc: 'binance-smart-chain',
  avalanche: 'avalanche',
  scroll: 'scroll',
  linea: 'linea',
  gnosis: 'xdai',
  zksync: 'zksync',
  xlayer: 'x-layer',
};

/** A list re-downloaded after this long; a token's contract never moves, new listings appear daily. */
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
/** A download must not hold a request for long: the node scores on a deadline. */
export const LIST_TIMEOUT_MS = 5_000;

export interface ListedToken {
  /** As the list writes it (CoinGecko: lower case); findListedToken returns it EIP-55 */
  address: `0x${string}`;
  name: string;
  symbol: string;
}

interface TokenList {
  bySymbol: Map<string, ListedToken[]>;
  byName: Map<string, ListedToken[]>;
  fetchedAt: number;
}

/**
 * Symbols compared without case or Unicode look-alikes. Tether's upgraded
 * contracts call themselves USD₮0 (U+20AE), which CoinGecko lists as USDT0.
 */
export function symbolKey(symbol: string): string {
  return symbol.normalize('NFKC').trim().toUpperCase().replace(/₮/g, 'T');
}

/** Names compared as their words: "Kelp DAO Restaked ETH" and "kelp-dao restaked eth" are one name. */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Download one list and keep its entries for `chainId`. Entries for other
 * chains, or without a well-formed address, symbol and name, are dropped.
 */
export async function fetchTokenList(url: string, chainId: number, timeoutMs = LIST_TIMEOUT_MS): Promise<ListedToken[]> {
  let body: unknown;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err: any) {
    const why = err?.name === 'TimeoutError'
      ? `no answer within ${timeoutMs / 1000} s`
      : `${err?.message ?? String(err)}${err?.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`;
    throw new IntentError('UPSTREAM_RPC_ERROR', `token list ${url} unavailable: ${why}`);
  }
  const entries = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(entries)) throw new IntentError('UPSTREAM_RPC_ERROR', `token list ${url} is not a token list (no tokens array)`);
  const tokens: ListedToken[] = [];
  for (const t of entries) {
    if (t?.chainId !== chainId || typeof t.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.address)
      || typeof t.symbol !== 'string' || !t.symbol.trim() || typeof t.name !== 'string') continue;
    tokens.push({ address: t.address as `0x${string}`, name: t.name.trim(), symbol: t.symbol.trim() });
  }
  if (tokens.length === 0) throw new IntentError('UPSTREAM_RPC_ERROR', `token list ${url} has no tokens for chain id ${chainId}`);
  return tokens;
}

function indexList(tokens: ListedToken[]): TokenList {
  const bySymbol = new Map<string, ListedToken[]>();
  const byName = new Map<string, ListedToken[]>();
  const add = (map: Map<string, ListedToken[]>, key: string, t: ListedToken) => {
    if (!key) return;
    const at = map.get(key);
    // the same contract is sometimes listed twice, in different letter case
    if (!at) map.set(key, [t]);
    else if (!at.some((o) => o.address.toLowerCase() === t.address.toLowerCase())) at.push(t);
  };
  for (const t of tokens) {
    add(bySymbol, symbolKey(t.symbol), t);
    add(byName, nameKey(t.name), t);
  }
  return { bySymbol, byName, fetchedAt: Date.now() };
}

const lists = new Map<SupportedChain, TokenList>();
const downloads = new Map<SupportedChain, Promise<TokenList>>();

/**
 * The chain's list, from memory while fresh. Concurrent requests share one
 * download. Once a copy is held, a stale copy answers at once while the
 * fresh one downloads, and keeps answering if that download fails: a list
 * hours old still locates contracts, and the contract read checks each one.
 */
async function tokenList(chain: SupportedChain): Promise<TokenList> {
  const platform = PLATFORMS[chain];
  if (!platform) {
    throw new IntentError('INVALID_INPUT', `no public token list covers ${chainMeta(chain).label}, so a token there must be given by contract address`);
  }
  const held = lists.get(chain);
  if (held && Date.now() - held.fetchedAt < LIST_TTL_MS) return held;
  let download = downloads.get(chain);
  if (!download) {
    download = fetchTokenList(`https://tokens.coingecko.com/${platform}/all.json`, chainMeta(chain).chainId)
      .then((tokens) => {
        const list = indexList(tokens);
        lists.set(chain, list);
        return list;
      })
      .finally(() => downloads.delete(chain));
    downloads.set(chain, download);
  }
  if (!held) return download;
  // The stale copy answers this request; a failed refresh is retried by the next one.
  download.catch(() => undefined);
  return held;
}

/** A located token and what it was matched on: the symbol asked for, or (no symbol matching) its name. */
export interface ListMatch {
  token: ListedToken;
  by: 'symbol' | 'name';
  /** "CoinGecko's Ethereum token list", for the answer's source */
  list: string;
}

/** Candidates whose name is the one given: exactly, else word for word one within the other. */
function namedAs(candidates: ListedToken[], name: string): ListedToken[] {
  const want = nameKey(name);
  if (!want) return [];
  const exact = candidates.filter((t) => nameKey(t.name) === want);
  if (exact.length > 0) return exact;
  const wanted = want.split(' ');
  return candidates.filter((t) => {
    const words = nameKey(t.name).split(' ').filter(Boolean);
    return words.length > 0 && (wanted.every((w) => words.includes(w)) || words.every((w) => wanted.includes(w)));
  });
}

function describe(candidates: ListedToken[]): string {
  const shown = candidates.slice(0, 5).map((t) => `${t.name} (${getAddress(t.address)})`).join(', ');
  return candidates.length > 5 ? `${shown} and ${candidates.length - 5} more` : shown;
}

/**
 * Find a token in the chain's list by its symbol, using the name to choose
 * when several tokens share the symbol, or by its exact name when no symbol
 * was given. `symbol === name` means one bare word was given, which may be
 * either ("BNT", "Chainlink"). Refuses, naming the candidates, rather than
 * choose between tokens the name does not separate.
 */
export async function findListedToken(chain: SupportedChain, symbol: string | null, name: string | null): Promise<ListMatch> {
  const list = await tokenList(chain);
  const where = `CoinGecko's ${chainMeta(chain).label} token list`;
  const found = (t: ListedToken, by: ListMatch['by']): ListMatch => ({ token: { ...t, address: getAddress(t.address) }, by, list: where });
  const loneWord = symbol !== null && symbol === name;

  if (symbol !== null) {
    const bySymbol = list.bySymbol.get(symbolKey(symbol)) ?? [];
    if (bySymbol.length === 1) return found(bySymbol[0]!, 'symbol');
    if (bySymbol.length > 1) {
      const chosen = name !== null && !loneWord ? namedAs(bySymbol, name) : [];
      if (chosen.length === 1) return found(chosen[0]!, 'symbol');
      const named = name !== null && !loneWord ? `, and ${chosen.length === 0 ? 'none' : 'more than one'} is named "${name}"` : '';
      throw new IntentError('INVALID_INPUT', `${bySymbol.length} tokens in ${where} have the symbol ${symbol}${named}: ${describe(bySymbol)}; give the contract address`);
    }
    if (!loneWord) throw new IntentError('INVALID_INPUT', `no token in ${where} has the symbol ${symbol}; give the contract address`);
  }
  if (name === null) throw new IntentError('INVALID_INPUT', 'no token symbol, name or contract address was given');
  const byName = list.byName.get(nameKey(name)) ?? [];
  if (byName.length === 1) return found(byName[0]!, 'name');
  if (byName.length > 1) {
    throw new IntentError('INVALID_INPUT', `${byName.length} tokens in ${where} are named "${name}": ${describe(byName)}; give the symbol or the contract address`);
  }
  throw new IntentError('INVALID_INPUT', `no token in ${where} has the ${loneWord ? 'symbol or name' : 'name'} "${name}"; give the symbol in parentheses or the contract address`);
}
