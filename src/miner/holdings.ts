/**
 * WALLET_BALANCE_CHECK_GENERAL and TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL.
 *
 * Both read current chain state, anchored to one block so every figure in an
 * answer comes from the same state: the balance of an address (native coin or
 * an ERC-20), and the total supply of an ERC-20. Field names and units are the
 * intents' own (GET /engine/v1/intents/<name>): `balance` and `total_supply`
 * in whole units with decimals applied, as JSON numbers, each beside its exact
 * raw integer as a decimal string.
 */
import {
  BaseError, HttpRequestError, LimitExceededRpcError, TimeoutError, formatUnits, getAddress, hexToString, isAddress, parseAbi,
} from 'viem';
import { normalize } from 'viem/ens';
import { SUPPORTED_CHAINS, chainMeta, getClient, type SupportedChain } from '../config/chains.js';
import { KNOWN_TOKENS, NATIVE_SYMBOLS } from '../config/tokens.js';
import { IntentError } from '../types/index.js';
import { findListedToken, symbolKey } from './tokenList.js';
import { chainFromText, requireChain } from './txLookup.js';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
/** symbol() as tokens older than the ERC-20 text form return it (MKR, SAI) */
const ERC20_BYTES32_SYMBOL = parseAbi(['function symbol() view returns (bytes32)']);

/** A token resolved to its contract, or the chain's native coin (address null). */
interface Asset {
  address: `0x${string}` | null;
  decimals: number;
  symbol: string;
  /** How a contract named by symbol or name was found, for the answer's source; null otherwise */
  foundIn: string | null;
}

/** An ERC-20, as its contract describes itself at the anchoring block. */
interface Erc20 extends Asset {
  address: `0x${string}`;
}

/** True when no RPC endpoint answered, as opposed to a contract answering in a way that is not ERC-20. */
function unanswered(err: unknown): boolean {
  return err instanceof BaseError
    && err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof LimitExceededRpcError) !== null;
}

function rpcFailure(err: any): string {
  return err?.shortMessage ?? err?.message ?? 'rpc failure';
}

/** symbol() as text, or as bytes32 from tokens that predate the text form. */
async function readSymbol(chain: SupportedChain, address: `0x${string}`, blockNumber: bigint): Promise<string> {
  const client = getClient(chain);
  try {
    return await client.readContract({ address, abi: ERC20, functionName: 'symbol', blockNumber });
  } catch (err) {
    if (unanswered(err)) throw err;
    const raw = await client.readContract({ address, abi: ERC20_BYTES32_SYMBOL, functionName: 'symbol', blockNumber });
    return hexToString(raw, { size: 32 });
  }
}

/** ERC-20 metadata read from the contract itself, at the anchoring block. */
async function readErc20(chain: SupportedChain, address: `0x${string}`, blockNumber: bigint): Promise<{ decimals: number; symbol: string }> {
  try {
    const [decimals, symbol] = await Promise.all([
      getClient(chain).readContract({ address, abi: ERC20, functionName: 'decimals', blockNumber }),
      readSymbol(chain, address, blockNumber),
    ]);
    return { decimals: Number(decimals), symbol };
  } catch (err) {
    // A timeout is not evidence about the contract: say the chain did not answer.
    if (unanswered(err)) throw new IntentError('UPSTREAM_RPC_ERROR', `${chain} did not answer for ${address}: ${rpcFailure(err)}`);
    throw new IntentError('INVALID_INPUT', `${address} on ${chain} does not answer decimals() and symbol() like an ERC-20 token`);
  }
}

/**
 * Whether a contract's symbol() is the symbol asked for. Case is ignored, and
 * so are two differences found on the contracts themselves (2026-11-21):
 * Tether's upgraded USDT reports USD₮0 or USDT0 (Arbitrum, Polygon), and the
 * bridged tokens CoinGecko lists as USDC.E report plain USDC (Arbitrum,
 * Polygon, OP Mainnet).
 */
function sameSymbol(asked: string, reported: string): boolean {
  const a = symbolKey(asked);
  const r = symbolKey(reported);
  return a === r || (a.endsWith('.E') && a.slice(0, -2) === r) || (a === 'USDT' && r === 'USDT0');
}

/** A token as a question names it: by contract address, or by symbol and name. */
export interface TokenRef {
  /** EIP-55. When given it is the token, whatever else the text says. */
  address: `0x${string}` | null;
  /** The last parenthesised word, or a bare word given alone */
  symbol: string | null;
  /** The text before the symbol's parentheses, or words given without any. Equal to `symbol` for a bare word, which may be either. */
  name: string | null;
}

const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/;

/**
 * Read a token reference the way the node writes one: "Kelp DAO Restaked ETH
 * (rsETH)", "Bancor (BNT)", "USDC (0xA0b8…)", "0x1BFD…", or a bare "USDC".
 * A contract address wins. Otherwise the symbol is the last parenthesised
 * word, since names carry parentheses of their own ("Brett (ETH) (BRETT)"),
 * and the name before it is kept to choose between tokens sharing a symbol.
 */
export function parseTokenRef(text: string): TokenRef {
  const t = text.replace(/\s+/g, ' ').trim();
  const address = t.match(ADDRESS_IN_TEXT)?.[0];
  if (address) return { address: getAddress(address), symbol: null, name: null };
  const symbolGroup = [...t.matchAll(/\(([^()\s]+)\)/g)].at(-1);
  if (symbolGroup) return { address: null, symbol: symbolGroup[1]!, name: t.slice(0, symbolGroup.index).trim() || null };
  if (t === '') return { address: null, symbol: null, name: null };
  return t.includes(' ') ? { address: null, symbol: null, name: t } : { address: null, symbol: t, name: t };
}

/** Where a token's contract is, and the symbol its symbol() must report (null for a given address). */
interface Located {
  address: `0x${string}`;
  expectedSymbol: string | null;
  foundIn: string | null;
}

/** The verified table first (src/config/tokens.ts), then CoinGecko's list for the chain. */
async function locateToken(chain: SupportedChain, ref: TokenRef): Promise<Located> {
  if (ref.address) return { address: ref.address, expectedSymbol: null, foundIn: null };
  const known = ref.symbol ? KNOWN_TOKENS[chain]?.[symbolKey(ref.symbol)] : undefined;
  if (known && ref.symbol) return { address: known.address, expectedSymbol: ref.symbol, foundIn: null };
  const match = await findListedToken(chain, ref.symbol, ref.name);
  return {
    address: match.token.address,
    // a token found by its name must report the symbol the list gives it
    expectedSymbol: match.by === 'symbol' && ref.symbol ? ref.symbol : match.token.symbol,
    foundIn: `found in ${match.list} as "${match.token.name}"`,
  };
}

/** Read the located contract at the block, and hold it to the symbol asked for. */
async function confirmToken(chain: SupportedChain, located: Located, blockNumber: bigint): Promise<Erc20> {
  const { decimals, symbol } = await readErc20(chain, located.address, blockNumber);
  const expected = located.expectedSymbol;
  if (expected !== null && !sameSymbol(expected, symbol)) {
    throw new IntentError('INVALID_INPUT', `${located.address}, ${located.foundIn ?? 'listed in the verified token table'} for ${expected} on ${chain}, reports symbol() "${symbol}" at block ${blockNumber}, so it is not taken to be ${expected}`);
  }
  return { address: located.address, decimals, symbol, foundIn: located.foundIn };
}

/** Resolve a balance's token: empty or a native symbol for the chain's coin, else an ERC-20. */
async function resolveAsset(chain: SupportedChain, raw: string, blockNumber: bigint): Promise<Asset> {
  const meta = chainMeta(chain);
  const ref = parseTokenRef(raw);
  const symbol = ref.symbol === null ? null : symbolKey(ref.symbol);
  const native = symbol === null ? ref.name === null : NATIVE_SYMBOLS.has(symbol) || symbol === meta.nativeSymbol;
  if (!ref.address && native) return { address: null, decimals: 18, symbol: meta.nativeSymbol, foundIn: null };
  return confirmToken(chain, await locateToken(chain, ref), blockNumber);
}

/** Address or ENS name to an address. ENS resolves on Ethereum mainnet. */
async function resolveHolder(raw: string): Promise<`0x${string}`> {
  const t = raw.trim();
  if (isAddress(t, { strict: false })) return getAddress(t);
  if (/^[^\s]+\.eth$/i.test(t)) {
    let resolved: `0x${string}` | null = null;
    try {
      resolved = await getClient('ethereum').getEnsAddress({ name: normalize(t) });
    } catch (err: any) {
      throw new IntentError('UPSTREAM_RPC_ERROR', `ENS lookup of ${t} failed: ${err?.shortMessage ?? err?.message ?? 'rpc failure'}`);
    }
    if (!resolved) throw new IntentError('INVALID_INPUT', `ENS name ${t} does not resolve to an address`);
    return getAddress(resolved);
  }
  throw new IntentError('INVALID_INPUT', 'address must be 0x followed by 40 hexadecimal characters, or an ENS name');
}

async function anchor(chain: SupportedChain): Promise<{ number: bigint; asOf: string }> {
  try {
    const block = await getClient(chain).getBlock({ blockTag: 'latest' });
    return { number: block.number, asOf: new Date(Number(block.timestamp) * 1000).toISOString() };
  } catch (err: any) {
    throw new IntentError('UPSTREAM_RPC_ERROR', `${chain} latest block unavailable: ${err?.shortMessage ?? err?.message ?? 'rpc failure'}`);
  }
}

/** Exact decimal text to the nearest JSON number; the exact figure travels beside it. */
function wholeUnits(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/** How a contract named by symbol or name was found, appended to the answer's source. */
function provenance(asset: Asset): string {
  return asset.foundIn ? `; contract ${asset.foundIn}, its symbol() confirmed at that block` : '';
}

// ---------- WALLET_BALANCE_CHECK_GENERAL ----------

export interface BalanceInput {
  address: string;
  chain: SupportedChain;
  token: string;
}

export function validateBalanceInput(raw: unknown): BalanceInput {
  if (typeof raw !== 'object' || raw === null) throw new IntentError('INVALID_INPUT', 'input must be an object');
  const body = raw as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query : '';
  const address = String(body.address ?? body.wallet ?? query.match(/0x[0-9a-fA-F]{40}|[^\s]+\.eth\b/i)?.[0] ?? '').trim();
  if (!address) throw new IntentError('INVALID_INPUT', 'address is required (0x address or ENS name)');
  const chainRaw = body.chain ?? body.network;
  const chain = chainRaw !== undefined && String(chainRaw).trim() !== ''
    ? requireChain(chainRaw) : (query ? chainFromText(query) : null) ?? 'ethereum';
  return { address, chain, token: String(body.token ?? body.asset ?? '').trim() };
}

export async function handleBalance(input: BalanceInput) {
  const holder = await resolveHolder(input.address);
  const block = await anchor(input.chain);
  const asset = await resolveAsset(input.chain, input.token, block.number);
  const client = getClient(input.chain);
  let raw: bigint;
  try {
    raw = asset.address === null
      ? await client.getBalance({ address: holder, blockNumber: block.number })
      : await client.readContract({ address: asset.address, abi: ERC20, functionName: 'balanceOf', args: [holder], blockNumber: block.number });
  } catch (err: any) {
    throw new IntentError('UPSTREAM_RPC_ERROR', err?.shortMessage ?? err?.message ?? 'rpc failure');
  }
  const meta = chainMeta(input.chain);
  const exact = formatUnits(raw, asset.decimals);
  const answer = `${holder} holds ${exact} ${asset.symbol} on ${meta.label} (chain id ${meta.chainId}) at block ${block.number}`
    + (asset.address ? `, read from the ${asset.symbol} contract ${asset.address}.` : '.');
  return {
    answer,
    signal: answer,
    source: `${meta.label} JSON-RPC ${asset.address ? 'eth_call balanceOf' : 'eth_getBalance'} at block ${block.number}${provenance(asset)}`,
    confidence: 0.99,
    address: holder,
    chain: input.chain,
    balance: wholeUnits(raw, asset.decimals),
    token_symbol: asset.symbol,
    as_of: block.asOf,
    balance_raw: raw.toString(),
    balance_exact: exact,
    decimals: asset.decimals,
    token_address: asset.address,
    chainId: meta.chainId,
    blockNumber: block.number.toString(),
  };
}

// ---------- TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL ----------

export interface SupplyInput {
  /** The token reference as sent */
  token: string;
  chain: SupportedChain;
  ref: TokenRef;
}

/**
 * The intent's question template (GET /engine/v1/intents/
 * TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL), in case the whole question arrives as
 * the token: its {key} is the token reference.
 */
const SUPPLY_QUESTION = /^what is the current total supply of (.+?),? in whole tokens\??$/i;

/**
 * Names of a chain's own coin besides viem's nativeCurrency symbol (ETH, POL,
 * BNB, AVAX, XDAI, OKB): Polygon's coin was MATIC before it became POL.
 */
const NATIVE_ALIASES: Partial<Record<SupportedChain, string[]>> = { polygon: ['MATIC'] };

/**
 * Whether `symbol` is `chain`'s own coin, which has no contract: ETH on
 * Ethereum or Base, POL or MATIC on Polygon. The same symbols on other chains
 * are ERC-20 tokens with a totalSupply() (POL and BNB on Ethereum are).
 */
function isNativeOf(chain: SupportedChain, symbol: string): boolean {
  const s = symbolKey(symbol);
  return s === 'NATIVE' || s === chainMeta(chain).nativeSymbol.toUpperCase() || (NATIVE_ALIASES[chain]?.includes(s) ?? false);
}

/**
 * The intent sends one `token` string naming the token and its chain:
 * "Kelp DAO Restaked ETH (rsETH) on Ethereum", "USDC (0xA0b8…) on Ethereum",
 * "0x1BFD… on Polygon". The chain is the words after the last " on ", so a
 * chain word inside a name ("Arbitrum (ARB) on Ethereum") does not move the
 * question to that chain, and a chain this miner does not serve is refused
 * instead of read on Ethereum. An explicit `chain` parameter wins. With no
 * " on " in the text, a chain word anywhere in it counts; Ethereum otherwise.
 */
export function validateSupplyInput(raw: unknown): SupplyInput {
  if (typeof raw !== 'object' || raw === null) throw new IntentError('INVALID_INPUT', 'input must be an object');
  const body = raw as Record<string, unknown>;
  const token = String(body.token ?? body.query ?? '').replace(/\s+/g, ' ').trim();
  if (!token) throw new IntentError('INVALID_INPUT', 'token is required (symbol or contract address, and its chain)');
  const asked = token.match(SUPPLY_QUESTION)?.[1] ?? token;
  // greedy: the last " on " separates the token from its chain
  const onChain = asked.match(/^(.*\S) on (\S.*)$/i);
  const tokenText = onChain ? onChain[1]! : asked;
  const chainRaw = body.chain ?? body.network;
  let chain: SupportedChain;
  if (chainRaw !== undefined && String(chainRaw).trim() !== '') {
    chain = requireChain(chainRaw);
  } else if (onChain) {
    const named = chainFromText(onChain[2]!);
    if (!named) {
      throw new IntentError('CHAIN_UNSUPPORTED', `the token is named on ${onChain[2]}, which is not a chain this miner serves (${SUPPORTED_CHAINS.join(', ')})`);
    }
    chain = named;
  } else {
    chain = chainFromText(asked) ?? 'ethereum';
  }
  return { token, chain, ref: parseTokenRef(tokenText) };
}

export async function handleSupply(input: SupplyInput) {
  const meta = chainMeta(input.chain);
  const { ref } = input;
  if (!ref.address && ref.symbol && isNativeOf(input.chain, ref.symbol)) {
    throw new IntentError('INVALID_INPUT', `${ref.symbol} is ${meta.label}'s native coin, which has no totalSupply() to read; give an ERC-20 token`);
  }
  // The block and the contract are found at once, then the contract is read
  // at that block. A token that cannot be located is reported ahead of an
  // RPC failure, so the same request always fails the same way.
  const [anchored, located] = await Promise.allSettled([anchor(input.chain), locateToken(input.chain, ref)]);
  if (located.status === 'rejected') throw located.reason;
  if (anchored.status === 'rejected') throw anchored.reason;
  const block = anchored.value;
  const [described, supply] = await Promise.allSettled([
    confirmToken(input.chain, located.value, block.number),
    getClient(input.chain).readContract({ address: located.value.address, abi: ERC20, functionName: 'totalSupply', blockNumber: block.number }),
  ]);
  // no figure unless the contract was confirmed as the token asked for
  if (described.status === 'rejected') throw described.reason;
  if (supply.status === 'rejected') {
    throw unanswered(supply.reason)
      ? new IntentError('UPSTREAM_RPC_ERROR', rpcFailure(supply.reason))
      : new IntentError('INVALID_INPUT', `${located.value.address} on ${input.chain} does not answer totalSupply()`);
  }
  const asset = described.value;
  const raw = supply.value;
  const exact = formatUnits(raw, asset.decimals);
  const answer = `The total supply of ${asset.symbol} (${asset.address}) on ${meta.label} is ${exact} tokens at block ${block.number} (${raw} base units, ${asset.decimals} decimals).`;
  return {
    answer,
    signal: answer,
    source: `${meta.label} JSON-RPC eth_call totalSupply at block ${block.number}${provenance(asset)}`,
    confidence: 0.99,
    total_supply: wholeUnits(raw, asset.decimals),
    token: asset.symbol,
    token_address: asset.address,
    chain: input.chain,
    total_supply_raw: raw.toString(),
    total_supply_exact: exact,
    decimals: asset.decimals,
    chainId: meta.chainId,
    blockNumber: block.number.toString(),
    as_of: block.asOf,
  };
}
