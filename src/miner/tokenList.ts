/**
 * CoinGecko's public token lists, used to find the contract of a token that a
 * question names by a symbol in parentheses ("Bancor (BNT)") when the
 * verified table in src/config/tokens.ts does not hold it.
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
 * The host rate-limits. Later the same day, after about 20 list downloads in
 * 10 minutes, it answered HTTP 429 with an HTML page. A failed download is
 * therefore remembered for LIST_BACKOFF_MS, or for as long as a Retry-After
 * header asks (at most 10 minutes). Meanwhile a stale copy answers if one is
 * held; otherwise the request is refused at once, as an upstream error that
 * says when the list will be asked for again. A 429 or an HTML page holds back
 * every chain's list, since it refuses this client rather than one list. A
 * body that is not JSON is a failure whatever its status.
 *
 * A list only says where to look. The caller reads the contract at the
 * anchoring block and requires its symbol() to agree before giving any
 * figure (src/miner/holdings.ts).
 */
import { getAddress } from 'viem';
import { chainMeta, type SupportedChain } from '../config/chains.js';
import { IntentError } from '../types/index.js';
import { nameAgreement } from './tokenNames.js';

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
export const LIST_TTL_MS = 6 * 60 * 60 * 1000;
/** A download must not hold a request for long: the node scores on a deadline. */
export const LIST_TIMEOUT_MS = 5_000;
/** How long a failed download is remembered before the list is asked for again. */
export const LIST_BACKOFF_MS = 90_000;
/** The longest a Retry-After header is honoured, so that one header cannot shut the lists off for hours. */
export const LIST_BACKOFF_MAX_MS = 10 * 60_000;

export interface ListedToken {
  /** As the list writes it (CoinGecko: lower case); findListedToken returns it EIP-55 */
  address: `0x${string}`;
  name: string;
  symbol: string;
}

/** A list that could not be had: an upstream error, which says nothing about the token. */
export class TokenListUnavailable extends IntentError {
  constructor(
    message: string,
    /** The host refused this client: HTTP 429, or an HTML page (Cloudflare's rate-limit and challenge pages) in place of the list */
    public readonly rateLimited: boolean,
    /** What a Retry-After header asked for, in milliseconds; null without one */
    public readonly retryAfterMs: number | null = null,
  ) {
    super('UPSTREAM_RPC_ERROR', message);
    this.name = 'TokenListUnavailable';
  }
}

/**
 * Symbols compared without case or Unicode look-alikes. Tether's upgraded
 * contracts call themselves USD₮0 (U+20AE), which CoinGecko lists as USDT0.
 */
export function symbolKey(symbol: string): string {
  return symbol.normalize('NFKC').trim().toUpperCase().replace(/₮/g, 'T');
}

/** Retry-After in milliseconds, given as seconds or as an HTTP date; null when absent or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Download one list and keep its entries for `chainId`. Entries for other
 * chains, or without a well-formed address, symbol and name, are dropped.
 * Every failure is a TokenListUnavailable carrying its reason.
 */
export async function fetchTokenList(url: string, chainId: number, timeoutMs = LIST_TIMEOUT_MS): Promise<ListedToken[]> {
  let res: Response;
  let text: string;
  try {
    // the timeout covers the body too: the Ethereum list is about 1.3 MB
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err: any) {
    const why = err?.name === 'TimeoutError'
      ? `no answer within ${timeoutMs / 1000} s`
      : `${err?.message ?? String(err)}${err?.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`;
    throw new TokenListUnavailable(`token list ${url} unavailable: ${why}`, false);
  }
  const type = res.headers.get('content-type') ?? '';
  const retryAfter = retryAfterMs(res.headers.get('retry-after'));
  // Cloudflare's rate-limit and challenge pages are HTML, whatever the status
  const html = /\btext\/html\b/i.test(type) || /^\s*<(!doctype\s+html|html[\s>])/i.test(text);
  if (res.status === 429 || html) {
    throw new TokenListUnavailable(
      `token list ${url} refused: HTTP ${res.status}${html ? ', an HTML page in place of the list' : ''}`, true, retryAfter,
    );
  }
  if (!res.ok) throw new TokenListUnavailable(`token list ${url} unavailable: HTTP ${res.status}`, false, retryAfter);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TokenListUnavailable(`token list ${url} unavailable: HTTP ${res.status} with a body that is not JSON (${type || 'no content type'})`, false);
  }
  const entries = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(entries)) throw new TokenListUnavailable(`token list ${url} is not a token list (no tokens array)`, false);
  const tokens: ListedToken[] = [];
  for (const t of entries) {
    if (t?.chainId !== chainId || typeof t.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.address)
      || typeof t.symbol !== 'string' || !t.symbol.trim() || typeof t.name !== 'string') continue;
    tokens.push({ address: t.address as `0x${string}`, name: t.name.trim(), symbol: t.symbol.trim() });
  }
  if (tokens.length === 0) throw new TokenListUnavailable(`token list ${url} has no tokens for chain id ${chainId}`, false);
  return tokens;
}

export interface TokenList {
  tokens: ListedToken[];
  bySymbol: Map<string, ListedToken[]>;
  /** When the download finished, by the cache's clock */
  fetchedAt: number;
}

function indexList(tokens: ListedToken[], fetchedAt: number): TokenList {
  const bySymbol = new Map<string, ListedToken[]>();
  for (const t of tokens) {
    const key = symbolKey(t.symbol);
    const at = bySymbol.get(key);
    // the same contract is sometimes listed twice, in different letter case
    if (!at) bySymbol.set(key, [t]);
    else if (!at.some((o) => o.address.toLowerCase() === t.address.toLowerCase())) at.push(t);
  }
  return { tokens, bySymbol, fetchedAt };
}

/** A download that failed, and until when (by the cache's clock) its list is not asked for again. */
interface Failure {
  error: TokenListUnavailable;
  url: string;
  at: number;
  until: number;
}

function secondsLeft(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

function secondsAgo(ms: number): string {
  return ms < 1000 ? 'under a second ago' : `${Math.round(ms / 1000)} s ago`;
}

/**
 * The lists, kept in memory by chain. A fresh copy answers from memory, and
 * concurrent requests share one download. A stale copy answers at once while
 * a fresh one downloads, and keeps answering through failed downloads: a list
 * hours old still locates contracts, and the contract read checks each one.
 * A failed download is not repeated until its backoff has passed.
 */
export class TokenListCache {
  private readonly held = new Map<SupportedChain, TokenList>();
  private readonly downloads = new Map<SupportedChain, Promise<TokenList>>();
  private readonly failures = new Map<SupportedChain, Failure>();
  /** The last time the host refused this client, which holds back every chain's list */
  private refusal: Failure | null = null;

  constructor(
    private readonly baseUrl = 'https://tokens.coingecko.com',
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = LIST_TIMEOUT_MS,
  ) {}

  urlFor(chain: SupportedChain): string | null {
    const platform = PLATFORMS[chain];
    return platform ? `${this.baseUrl}/${platform}/all.json` : null;
  }

  async get(chain: SupportedChain): Promise<TokenList> {
    const url = this.urlFor(chain);
    if (!url) {
      throw new IntentError('INVALID_INPUT', `no public token list covers ${chainMeta(chain).label}, so a token there must be given by contract address`);
    }
    const now = this.now();
    const held = this.held.get(chain);
    if (held && now - held.fetchedAt < LIST_TTL_MS) return held;
    let download = this.downloads.get(chain);
    if (!download) {
      const failure = this.backingOff(chain, now);
      if (failure) {
        if (held) return held;
        throw this.refusedFor(url, failure, now);
      }
      download = this.download(chain, url);
    }
    if (!held) return download;
    // The stale copy answers this request; the download refreshes it for later ones.
    download.catch(() => undefined);
    return held;
  }

  /** The failure still holding back this chain's list, if any: its own, or the host's refusal of this client. */
  private backingOff(chain: SupportedChain, now: number): Failure | null {
    const own = this.failures.get(chain);
    if (own && now < own.until) return own;
    if (this.refusal && now < this.refusal.until) return this.refusal;
    return null;
  }

  private refusedFor(url: string, failure: Failure, now: number): TokenListUnavailable {
    const ago = secondsAgo(now - failure.at);
    const left = secondsLeft(failure.until - now);
    const message = failure.url === url
      ? `${failure.error.message} (${ago}); it is not asked for again for another ${left}`
      : `token list ${url} not asked for: ${new URL(url).host} refused this miner ${ago} (${failure.error.message}); no list is asked for during another ${left}`;
    return new TokenListUnavailable(message, failure.error.rateLimited);
  }

  private download(chain: SupportedChain, url: string): Promise<TokenList> {
    const download = fetchTokenList(url, chainMeta(chain).chainId, this.timeoutMs)
      .then(
        (tokens) => {
          const list = indexList(tokens, this.now());
          this.held.set(chain, list);
          this.failures.delete(chain);
          return list;
        },
        (err: unknown) => {
          const error = err instanceof TokenListUnavailable
            ? err
            : new TokenListUnavailable(`token list ${url} unavailable: ${(err as Error)?.message ?? String(err)}`, false);
          const at = this.now();
          const wait = Math.min(LIST_BACKOFF_MAX_MS, Math.max(LIST_BACKOFF_MS, error.retryAfterMs ?? 0));
          const failure: Failure = { error, url, at, until: at + wait };
          this.failures.set(chain, failure);
          if (error.rateLimited) this.refusal = failure;
          throw error;
        },
      )
      .finally(() => this.downloads.delete(chain));
    this.downloads.set(chain, download);
    return download;
  }
}

/** The lists the miner answers from: CoinGecko's. */
export const coingeckoLists = new TokenListCache();

/**
 * Begin downloading a chain's list without waiting for it, so that the first
 * question about one of its tokens does not wait for the download. Resolves
 * with the number of tokens held; rejects with why the list could not be had.
 */
export function preloadTokenList(chain: SupportedChain, lists: TokenListCache = coingeckoLists): Promise<number> {
  return lists.get(chain).then((list) => list.tokens.length);
}

/** Every entry of a chain's list, as the cache holds it. */
export async function listedTokens(chain: SupportedChain, lists: TokenListCache = coingeckoLists): Promise<ListedToken[]> {
  return (await lists.get(chain)).tokens;
}

/** A token located by its symbol. */
export interface ListMatch {
  token: ListedToken;
  /** "CoinGecko's Ethereum token list", for the answer's source */
  list: string;
}

/**
 * The candidates whose names agree best with the name given
 * (src/miner/tokenNames.ts): "Uniswap" chooses Uniswap's UNI, not UNICORN's.
 * Only the names count here, since every candidate has the symbol.
 */
function namedAs(candidates: ListedToken[], name: string): ListedToken[] {
  const ranked = candidates.map((t) => ({ t, agreement: nameAgreement(name, [t.name]) }));
  const best = Math.max(...ranked.map((r) => r.agreement));
  return best === 0 ? [] : ranked.filter((r) => r.agreement === best).map((r) => r.t);
}

function describe(candidates: ListedToken[]): string {
  const shown = candidates.slice(0, 5).map((t) => `${t.name} (${getAddress(t.address)})`).join(', ');
  return candidates.length > 5 ? `${shown} and ${candidates.length - 5} more` : shown;
}

/**
 * Find a token in the chain's list by the symbol a question gave in
 * parentheses, using the name before it to choose when several tokens share
 * the symbol. Refuses, naming the candidates, rather than choose between
 * tokens the name does not separate. A list is never searched by name: a
 * name alone, or a word that may be a name, is no symbol to look up. When
 * one token has the symbol it is returned whatever the name; the caller
 * holds it to the name (src/miner/holdings.ts), with its name() to hand.
 */
export async function findListedToken(
  chain: SupportedChain, symbol: string, name: string | null, lists: TokenListCache = coingeckoLists,
): Promise<ListMatch> {
  const list = await lists.get(chain);
  const where = `CoinGecko's ${chainMeta(chain).label} token list`;
  const found = (t: ListedToken): ListMatch => ({ token: { ...t, address: getAddress(t.address) }, list: where });
  const sharing = list.bySymbol.get(symbolKey(symbol)) ?? [];
  if (sharing.length === 0) throw new IntentError('INVALID_INPUT', `no token in ${where} has the symbol ${symbol}; give the contract address`);
  if (sharing.length === 1) return found(sharing[0]!);
  const chosen = name !== null ? namedAs(sharing, name) : [];
  if (chosen.length === 1) return found(chosen[0]!);
  const named = name !== null ? `, and ${chosen.length === 0 ? 'none' : 'more than one'} is named "${name}"` : '';
  throw new IntentError('INVALID_INPUT', `${sharing.length} tokens in ${where} have the symbol ${symbol}${named}: ${describe(sharing)}; give the contract address`);
}
