/**
 * Direct chain reads about a token, made before anything is bought.
 *
 * These are free JSON-RPC reads through Truvian's own chain registry, not
 * Telegraph answers, and every report labels them that way. They serve two
 * purposes in a preflight:
 *  - stop early and spend nothing when the address is not a contract at all;
 *  - cross-check what Telegraph returns (total supply, treasury balance)
 *    against the chain itself, so a wrong answer shows up as a conflict
 *    instead of being trusted.
 *
 * Every read is taken at one anchoring block, so the figures in a report
 * describe the same chain state.
 */
import { formatUnits, getAddress, isAddress, parseAbi } from 'viem';
import { chainMeta, getClient, SUPPORTED_CHAINS, type SupportedChain } from '../config/chains.js';

const ERC20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
]);

/** EIP-1967 storage slots: implementation and admin of a transparent or UUPS proxy. */
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as const;
/**
 * The older ZeppelinOS slots, keccak256("org.zeppelinos.proxy.implementation")
 * and ("org.zeppelinos.proxy.admin"). USDC on Ethereum is this kind of proxy
 * and leaves the EIP-1967 slots empty (checked 2026-11-20).
 */
const ZOS_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' as const;
const ZOS_ADMIN_SLOT = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b' as const;
/** EIP-7702: an account's code is 0xef0100 followed by the address it delegates to. */
const DELEGATION_PREFIX = '0xef0100';

export class TokenFactsError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'CHAIN_UNAVAILABLE', message: string) {
    super(message);
  }
}

export interface TokenFacts {
  chain: SupportedChain;
  chainId: number;
  chainLabel: string;
  address: `0x${string}`;
  /** The block every read below was taken at */
  block: string;
  blockTime: string;
  /** True when the address holds contract code (an EIP-7702 delegation is not contract code) */
  isContract: boolean;
  codeBytes: number;
  /** Set when the address is an account delegating to code under EIP-7702 */
  delegatedTo: `0x${string}` | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** totalSupply() as the exact integer, decimal string */
  totalSupplyRaw: string | null;
  /** totalSupply() in whole tokens, exact decimal text */
  totalSupply: string | null;
  /** Set when an EIP-1967 or ZeppelinOS implementation slot is filled */
  proxy: { implementation: `0x${string}`; admin: `0x${string}` | null; standard: 'EIP-1967' | 'ZeppelinOS' } | null;
  /** owner(), when the contract has one */
  owner: `0x${string}` | null;
}

export function parseChain(raw: unknown): SupportedChain {
  const name = String(raw ?? '').trim().toLowerCase();
  if ((SUPPORTED_CHAINS as readonly string[]).includes(name)) return name as SupportedChain;
  throw new TokenFactsError('INVALID_INPUT', `chain must be one of ${SUPPORTED_CHAINS.join(', ')}`);
}

export function parseAddress(raw: unknown, what: string): `0x${string}` {
  const text = String(raw ?? '').trim();
  if (!isAddress(text, { strict: false })) throw new TokenFactsError('INVALID_INPUT', `${what} must be 0x followed by 40 hexadecimal characters`);
  return getAddress(text);
}

function slotAddress(word: `0x${string}` | undefined): `0x${string}` | null {
  if (!word || /^0x0*$/.test(word)) return null;
  return getAddress(`0x${word.slice(-40)}`);
}

/** The anchoring block: the chain's latest, read once. */
export async function anchorBlock(chain: SupportedChain): Promise<{ number: bigint; time: string }> {
  try {
    const block = await getClient(chain).getBlock({ blockTag: 'latest' });
    return { number: block.number, time: new Date(Number(block.timestamp) * 1000).toISOString() };
  } catch (err) {
    throw new TokenFactsError('CHAIN_UNAVAILABLE', `${chain} did not answer for its latest block: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
}

export async function readTokenFacts(chain: SupportedChain, address: `0x${string}`): Promise<TokenFacts> {
  const meta = chainMeta(chain);
  const client = getClient(chain);
  const anchor = await anchorBlock(chain);
  const blockNumber = anchor.number;
  let code: `0x${string}` | undefined;
  try {
    code = await client.getCode({ address, blockNumber });
  } catch (err) {
    throw new TokenFactsError('CHAIN_UNAVAILABLE', `${chain} did not answer for the code at ${address}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
  const codeBytes = code ? (code.length - 2) / 2 : 0;
  const delegatedTo = code && codeBytes === 23 && code.toLowerCase().startsWith(DELEGATION_PREFIX) ? getAddress(`0x${code.slice(8)}`) : null;
  const facts: TokenFacts = {
    chain, chainId: meta.chainId, chainLabel: meta.label, address,
    block: blockNumber.toString(), blockTime: anchor.time,
    isContract: codeBytes > 0 && delegatedTo === null, codeBytes, delegatedTo,
    name: null, symbol: null, decimals: null, totalSupplyRaw: null, totalSupply: null, proxy: null, owner: null,
  };
  if (!facts.isContract) return facts;

  const read = <T>(functionName: 'name' | 'symbol' | 'decimals' | 'totalSupply' | 'owner'): Promise<T | null> =>
    (client.readContract({ address, abi: ERC20, functionName, blockNumber }) as Promise<T>).catch(() => null);
  const slot = (s: `0x${string}`) => client.getStorageAt({ address, slot: s, blockNumber }).catch(() => undefined);
  const [name, symbol, decimals, supply, owner, impl, admin, zosImpl, zosAdmin] = await Promise.all([
    read<string>('name'),
    read<string>('symbol'),
    read<number>('decimals'),
    read<bigint>('totalSupply'),
    read<`0x${string}`>('owner'),
    slot(IMPLEMENTATION_SLOT),
    slot(ADMIN_SLOT),
    slot(ZOS_IMPLEMENTATION_SLOT),
    slot(ZOS_ADMIN_SLOT),
  ]);
  facts.name = name;
  facts.symbol = symbol;
  facts.decimals = decimals === null ? null : Number(decimals);
  if (supply !== null) {
    facts.totalSupplyRaw = supply.toString();
    if (facts.decimals !== null) facts.totalSupply = formatUnits(supply, facts.decimals);
  }
  facts.owner = owner && !/^0x0{40}$/i.test(owner) ? getAddress(owner) : null;
  const implementation = slotAddress(impl);
  const zosImplementation = slotAddress(zosImpl);
  if (implementation) facts.proxy = { implementation, admin: slotAddress(admin), standard: 'EIP-1967' };
  else if (zosImplementation) facts.proxy = { implementation: zosImplementation, admin: slotAddress(zosAdmin), standard: 'ZeppelinOS' };
  return facts;
}

/** Native balance of an address at a block, in Gwei as exact decimal text. */
export async function readBalanceGwei(chain: SupportedChain, address: `0x${string}`, block: bigint): Promise<string> {
  try {
    const wei = await getClient(chain).getBalance({ address, blockNumber: block });
    return formatUnits(wei, 9);
  } catch (err) {
    throw new TokenFactsError('CHAIN_UNAVAILABLE', `${chain} did not answer for the balance of ${address} at block ${block}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
}
