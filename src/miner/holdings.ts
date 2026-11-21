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
  BaseError, CallExecutionError, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  ExecutionRevertedError, formatUnits, getAddress, hexToString, isAddress, parseAbi, type PublicClient,
} from 'viem';
import { normalize } from 'viem/ens';
import { SUPPORTED_CHAINS, chainMeta, getClient, type SupportedChain } from '../config/chains.js';
import { KNOWN_TOKENS, KNOWN_TOKEN_NAMES, NATIVE_SYMBOLS } from '../config/tokens.js';
import { IntentError } from '../types/index.js';
import { findListedToken, symbolKey } from './tokenList.js';
import { namesAgree } from './tokenNames.js';
import { chainFromText, requireChain } from './txLookup.js';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);
/** symbol() and name() as tokens older than the ERC-20 text form return them (MKR, SAI) */
const ERC20_BYTES32 = parseAbi(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);

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

/**
 * The call reached the contract and its answer did not decode as the ABI
 * says: what a bytes32 symbol() looks like when read as a string (MKR's
 * fails as IntegerOutOfRangeError). A revert, an empty answer or a failed
 * request is not this.
 */
function undecodable(err: unknown): boolean {
  return err instanceof ContractFunctionExecutionError
    && err.walk((e) => e instanceof CallExecutionError || e instanceof ContractFunctionZeroDataError
      || e instanceof ContractFunctionRevertedError) === null;
}

/**
 * Whether a failed read is the contract's own answer: it reverted, returned
 * no data, or returned bytes that do not decode. Only such a failure says
 * anything about the contract. Everything else (no endpoint answered, a rate
 * limit, a JSON-RPC error such as an endpoint that lacks the block) is the
 * chain not answering, and is reported as an upstream error.
 */
export function contractAnswered(err: unknown): boolean {
  return err instanceof BaseError
    && (err.walk((e) => e instanceof ExecutionRevertedError || e instanceof ContractFunctionZeroDataError) !== null || undecodable(err));
}

function rpcFailure(err: any): string {
  return err?.shortMessage ?? err?.message ?? 'rpc failure';
}

/**
 * symbol() or name() as text, or as the bytes32 word that tokens older than
 * the text form return (MKR, SAI). The bytes32 read is tried only when the
 * text did not decode; a revert, an empty answer or a failed request would
 * fail the same way again, and is passed on as it is.
 */
export async function readText(
  client: PublicClient, address: `0x${string}`, functionName: 'symbol' | 'name', blockNumber: bigint,
): Promise<string> {
  try {
    return await client.readContract({ address, abi: ERC20, functionName, blockNumber });
  } catch (err) {
    if (!undecodable(err)) throw err;
    const word = await client.readContract({ address, abi: ERC20_BYTES32, functionName, blockNumber });
    return hexToString(word, { size: 32 });
  }
}

/**
 * ERC-20 metadata read from the contract itself, at the anchoring block. A
 * contract that answered either read wrongly is no ERC-20, whatever happened
 * to the other read; when no read was answered by the contract, the chain
 * did not answer, which says nothing about the token.
 */
async function readErc20(chain: SupportedChain, address: `0x${string}`, blockNumber: bigint): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, symbol] = await Promise.allSettled([
    client.readContract({ address, abi: ERC20, functionName: 'decimals', blockNumber }),
    readText(client, address, 'symbol', blockNumber),
  ]);
  if (decimals.status === 'fulfilled' && symbol.status === 'fulfilled') return { decimals: Number(decimals.value), symbol: symbol.value };
  const failed = [decimals, symbol].flatMap((read) => (read.status === 'rejected' ? [read.reason as unknown] : []));
  if (failed.some(contractAnswered)) {
    throw new IntentError('INVALID_INPUT', `${address} on ${chain} does not answer decimals() and symbol() like an ERC-20 token`);
  }
  throw new IntentError('UPSTREAM_RPC_ERROR', `${chain} did not answer for ${address}: ${rpcFailure(failed[0])}`);
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
  /** The last parenthesised word, or a word given alone */
  symbol: string | null;
  /**
   * True when the symbol is a word given alone, without parentheses ("USDC",
   * "Bitcoin"). Such a word may be a name as well as a symbol, so only the
   * verified table answers it: "Bitcoin" is no symbol there, though a meme
   * token in CoinGecko's Ethereum list has the symbol BITCOIN.
   */
  bare: boolean;
  /** The text before the symbol's parentheses, or several words given without a symbol */
  name: string | null;
}

const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/;

/**
 * Read a token reference the way the node writes one: "Kelp DAO Restaked ETH
 * (rsETH)", "Bancor (BNT)", "USDC (0xA0b8…)", "0x1BFD…", or a lone "USDC".
 * A contract address wins. Otherwise the symbol is the last parenthesised
 * word, since names carry parentheses of their own ("Brett (ETH) (BRETT)"),
 * and the name before it is kept to choose between tokens sharing a symbol.
 */
export function parseTokenRef(text: string): TokenRef {
  const t = text.replace(/\s+/g, ' ').trim();
  const address = t.match(ADDRESS_IN_TEXT)?.[0];
  if (address) return { address: getAddress(address), symbol: null, bare: false, name: null };
  const symbolGroup = [...t.matchAll(/\(([^()\s]+)\)/g)].at(-1);
  if (symbolGroup) return { address: null, symbol: symbolGroup[1]!, bare: false, name: t.slice(0, symbolGroup.index).trim() || null };
  if (t === '') return { address: null, symbol: null, bare: false, name: null };
  return t.includes(' ')
    ? { address: null, symbol: null, bare: false, name: t }
    : { address: null, symbol: t, bare: true, name: null };
}

/** Where a token's contract is, and what the question said that the contract must bear out. */
interface Located {
  address: `0x${string}`;
  /** The symbol its symbol() must report; null when the question gave the address */
  expectedSymbol: string | null;
  /** The name the question gave beside the symbol, which must agree with the token's names; null for none */
  givenName: string | null;
  /** What the token is called where it was found: its list entry's name, or the verified table's names */
  names: readonly string[];
  /** Where it was found, for a refusal: "CoinGecko's Ethereum token list", "the verified token table" */
  where: string;
  /** How the contract was found, for the answer's source; null for the verified table or a given address */
  foundIn: string | null;
}

/**
 * Where to read the token: the address given; else the symbol in the
 * verified table (src/config/tokens.ts); else, for a symbol given in
 * parentheses only, CoinGecko's list for the chain. A word given alone is
 * never looked up in the list, and words with no symbol are not looked up at
 * all: each would be a guess at what the question meant.
 */
async function locateToken(chain: SupportedChain, ref: TokenRef): Promise<Located> {
  if (ref.address) return { address: ref.address, expectedSymbol: null, givenName: null, names: [], where: 'the question', foundIn: null };
  const label = chainMeta(chain).label;
  if (ref.symbol === null) {
    throw new IntentError('INVALID_INPUT', ref.name === null
      ? 'no token symbol, name or contract address was given'
      : `"${ref.name}" gives no symbol and no contract address; give the symbol in parentheses after the name, as in "${ref.name} (SYMBOL)", or the contract address`);
  }
  const key = symbolKey(ref.symbol);
  const known = KNOWN_TOKENS[chain]?.[key];
  if (known) {
    return {
      address: known.address, expectedSymbol: ref.symbol, givenName: ref.name, names: KNOWN_TOKEN_NAMES[key] ?? [],
      where: 'the verified token table', foundIn: null,
    };
  }
  if (ref.bare) {
    const table = Object.keys(KNOWN_TOKENS[chain] ?? {});
    throw new IntentError('INVALID_INPUT', `"${ref.symbol}" is not a symbol in the verified token table for ${label}`
      + `${table.length > 0 ? ` (${table.join(', ')})` : ''}, and a word given alone may be a name as well as a symbol, so public token lists are not searched for it;`
      + ' give the symbol in parentheses, as in "Bancor (BNT)", or the contract address');
  }
  const match = await findListedToken(chain, ref.symbol, ref.name);
  return {
    address: match.token.address, expectedSymbol: ref.symbol, givenName: ref.name, names: [match.token.name],
    where: match.list, foundIn: `found in ${match.list} as "${match.token.name}"`,
  };
}

function quoted(names: readonly string[]): string {
  return names.map((n) => `"${n}"`).join(' or ');
}

/**
 * Read the located contract at the block, and hold it to what the question
 * said: its symbol() must be the symbol asked for, and a name given beside
 * the symbol must agree with the token (src/miner/tokenNames.ts). The name
 * is compared with the names the token was found under and its symbol, and
 * when those disagree, with the contract's own name() at the block: CoinGecko
 * calls POL "POL (ex-MATIC)", its contract "Polygon Ecosystem Token".
 */
async function confirmToken(chain: SupportedChain, located: Located, blockNumber: bigint): Promise<Erc20> {
  const { address, expectedSymbol, givenName } = located;
  const nameUnsettled = givenName !== null
    && !namesAgree(givenName, expectedSymbol === null ? located.names : [...located.names, expectedSymbol]);
  const [erc20, ownName] = await Promise.allSettled([
    readErc20(chain, address, blockNumber),
    nameUnsettled ? readText(getClient(chain), address, 'name', blockNumber) : Promise.resolve(null),
  ]);
  if (erc20.status === 'rejected') throw erc20.reason;
  const { decimals, symbol } = erc20.value;
  if (expectedSymbol !== null && !sameSymbol(expectedSymbol, symbol)) {
    throw new IntentError('INVALID_INPUT', `${address}, ${located.foundIn ?? `in ${located.where}`} for ${expectedSymbol} on ${chain}, reports symbol() "${symbol}" at block ${blockNumber}, so it is not taken to be ${expectedSymbol}`);
  }
  if (nameUnsettled) {
    if (ownName.status === 'rejected' && !contractAnswered(ownName.reason)) {
      throw new IntentError('UPSTREAM_RPC_ERROR', `${chain} did not answer name() for ${address}: ${rpcFailure(ownName.reason)}`);
    }
    const contractName = ownName.status === 'fulfilled' ? ownName.value : null;
    if (contractName === null || !namesAgree(givenName!, [contractName])) {
      throw new IntentError('INVALID_INPUT', `the name "${givenName}" does not agree with the token found for ${expectedSymbol}: ${address} is ${quoted(located.names)} in ${located.where}`
        + ` and ${contractName === null ? 'answers no name()' : `"${contractName}" by its name()`} at block ${blockNumber}; give the name and symbol of one token, or its contract address`);
    }
  }
  return { address, decimals, symbol, foundIn: located.foundIn };
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
    throw contractAnswered(supply.reason)
      ? new IntentError('INVALID_INPUT', `${located.value.address} on ${input.chain} does not answer totalSupply()`)
      : new IntentError('UPSTREAM_RPC_ERROR', rpcFailure(supply.reason));
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
