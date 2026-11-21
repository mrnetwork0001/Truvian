/**
 * Which token a question means, decided strictly.
 *
 * The miner (src/miner/holdings.ts) tries hard to answer: it searches
 * CoinGecko's token lists and falls back from a given address to a symbol.
 * A truth source must not: a token it guesses wrong makes every correct
 * miner look wrong. So here a token is either
 *   - a contract address given in the question, which must have code on the
 *     chain and, when a symbol or name is written beside it, report that
 *     symbol and agree with that name; or
 *   - a symbol in the verified token table (src/config/tokens.ts), whose
 *     contract must report that symbol and agree with a name given beside it;
 *   - or, for a balance, nothing or the chain's own coin symbol: the native
 *     coin.
 * Anything else is refused with 422.
 */
import { getAddress } from 'viem';
import { KNOWN_TOKENS, KNOWN_TOKEN_NAMES } from '../config/tokens.js';
import { namesAgree } from '../miner/tokenNames.js';
import { TruthError } from './agree.js';
import { CHAIN_LABEL, nativeSymbols, type CurrentChain } from './endpoints.js';

/** A token as a question writes it. */
export interface TokenRef {
  /** EIP-55, when the text holds a 0x address */
  address: `0x${string}` | null;
  /** The last parenthesised word, or a single word given alone */
  symbol: string | null;
  /** Words before the symbol's parentheses, or several words with no symbol */
  name: string | null;
}

const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;

/** Upper case, NFKC, ₮ read as T: the form symbols are compared in. */
export function symbolKey(symbol: string): string {
  return symbol.normalize('NFKC').trim().toUpperCase().replace(/₮/g, 'T');
}

/**
 * Read "Kelp DAO Restaked ETH (rsETH)", "USDC (0xA0b8…)", "0x1BFD…", "USDC"
 * or "USD Coin (USDC)". The symbol is the last parenthesised word, since names
 * carry parentheses of their own. Two different addresses are refused: the
 * question names two tokens.
 */
export function parseTokenRef(text: string): TokenRef {
  const t = text.replace(/\s+/g, ' ').trim();
  const addresses = [...new Set([...t.matchAll(ADDRESS_IN_TEXT)].map((m) => m[0].toLowerCase()))];
  if (addresses.length > 1) throw new TruthError(422, 'TOKEN_AMBIGUOUS', `the text gives ${addresses.length} different contract addresses`);
  const rest = addresses.length ? t.replace(ADDRESS_IN_TEXT, ' ') : t;
  const cleaned = rest.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const group = [...cleaned.matchAll(/\(([^()\s]+)\)/g)].at(-1);
  let symbol: string | null = null;
  let name: string | null = null;
  if (group) {
    symbol = group[1]!;
    name = cleaned.slice(0, group.index).trim() || null;
    if (cleaned.slice(group.index! + group[0].length).trim() !== '') {
      throw new TruthError(422, 'TOKEN_AMBIGUOUS', `"${t}" has words after the symbol; give "Name (SYMBOL)" or a contract address`);
    }
  } else if (cleaned !== '') {
    if (cleaned.includes(' ')) name = cleaned;
    else symbol = cleaned;
  }
  return { address: addresses.length ? getAddress(addresses[0]!) : null, symbol, name };
}

/**
 * Whether a contract's symbol() is the symbol asked for. Case is ignored, and
 * so is Tether's upgraded USDT reporting USDT0 or USD₮0 on Arbitrum and
 * Polygon (checked on the contracts, 2026-11-21).
 */
export function sameSymbol(asked: string, reported: string): boolean {
  const a = symbolKey(asked);
  const r = symbolKey(reported);
  return a === r || (a === 'USDT' && r === 'USDT0');
}

/** What to read: the native coin, or one contract and what it must bear out. */
export type Target =
  | { kind: 'native'; symbol: string }
  | {
    kind: 'contract';
    address: `0x${string}`;
    /** The symbol its symbol() must report; null when none was written */
    symbol: string | null;
    /** A name written beside it, which must agree with the token's names; null for none */
    name: string | null;
    /** Names the token is known by besides its own name() (the verified table's), for the name check */
    knownNames: readonly string[];
    /** "the question" or "the verified token table" */
    from: string;
  };

export function isNative(chain: CurrentChain, symbol: string): boolean {
  return nativeSymbols(chain).includes(symbolKey(symbol));
}

/** Decide what a token reference means on a chain, or refuse it. */
export function locate(chain: CurrentChain, ref: TokenRef, allowNative: boolean): Target {
  const label = CHAIN_LABEL[chain];
  if (ref.address) {
    return { kind: 'contract', address: ref.address, symbol: ref.symbol, name: ref.name, knownNames: [], from: 'the question' };
  }
  if (ref.symbol === null) {
    if (ref.name === null && allowNative) return { kind: 'native', symbol: nativeSymbols(chain)[0]! };
    throw new TruthError(422, 'TOKEN_UNRESOLVED', ref.name === null
      ? 'no token symbol or contract address was given'
      : `"${ref.name}" gives no symbol and no contract address; give "Name (SYMBOL)" or the contract address`);
  }
  if (isNative(chain, ref.symbol)) {
    if (!allowNative) throw new TruthError(422, 'NATIVE_HAS_NO_SUPPLY', `${ref.symbol} is ${label}'s own coin, which has no totalSupply() to read`);
    if (ref.name !== null) {
      throw new TruthError(422, 'TOKEN_AMBIGUOUS', `"${ref.name} (${ref.symbol})": a name beside the native coin's symbol is not checked; give the symbol alone`);
    }
    return { kind: 'native', symbol: nativeSymbols(chain)[0]! };
  }
  const key = symbolKey(ref.symbol);
  const known = KNOWN_TOKENS[chain]?.[key];
  if (!known) {
    const table = Object.keys(KNOWN_TOKENS[chain] ?? {});
    throw new TruthError(422, 'TOKEN_NOT_IN_TABLE', `${ref.symbol} is not in the verified token table for ${label} (${table.join(', ')}); `
      + 'a symbol can name several tokens, so give the contract address');
  }
  return { kind: 'contract', address: known.address, symbol: ref.symbol, name: ref.name, knownNames: KNOWN_TOKEN_NAMES[key] ?? [], from: 'the verified token table' };
}

/** What two endpoints agreed a contract is, at one block. */
export interface ContractFacts {
  /** False when the address has no code at the block */
  code: boolean;
  /** Null when the contract did not answer decimals() and symbol() like an ERC-20 */
  decimals: number | null;
  symbol: string | null;
  /** Null when it answers no name() */
  name: string | null;
}

/**
 * Hold the agreed contract to what the question said. Throws 422 when the
 * address is no contract, no ERC-20, or reports another symbol, or when a
 * name written beside it agrees with none of its names.
 */
export function confirm(chain: CurrentChain, target: Extract<Target, { kind: 'contract' }>, facts: ContractFacts, block: bigint): { decimals: number; symbol: string } {
  const label = CHAIN_LABEL[chain];
  const at = `${target.address} on ${label} at block ${block}`;
  if (!facts.code) throw new TruthError(422, 'NOT_A_CONTRACT', `${at} has no code, so it is no token there; give the token's contract address on ${label}`);
  if (facts.decimals === null || facts.symbol === null) throw new TruthError(422, 'NOT_AN_ERC20', `${at} does not answer decimals() and symbol() like an ERC-20 token`);
  if (target.symbol !== null && !sameSymbol(target.symbol, facts.symbol)) {
    throw new TruthError(422, 'SYMBOL_MISMATCH', `${at} (from ${target.from}) reports symbol() "${facts.symbol}", not ${target.symbol}`);
  }
  if (target.name !== null) {
    const names = [...target.knownNames, facts.symbol, ...(facts.name === null ? [] : [facts.name])];
    if (!namesAgree(target.name, names)) {
      throw new TruthError(422, 'NAME_MISMATCH', `the name "${target.name}" agrees with none of the token's names (${names.map((n) => `"${n}"`).join(', ')}) for ${at}`);
    }
  }
  return { decimals: facts.decimals, symbol: facts.symbol };
}
