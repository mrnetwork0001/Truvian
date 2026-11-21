/**
 * Total supply of a token and balance of a wallet, now, agreed by two
 * endpoints run by different providers.
 *
 * Backs Telegraph truth sources for TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL (scored
 * field `total_supply`, whole tokens) and WALLET_BALANCE_CHECK_GENERAL
 * (scored field `balance`, whole token units). "Now" is one fixed block a
 * little below the tip (CONFIRMATIONS in src/truth/endpoints.ts), returned in
 * the answer. Both endpoints read everything at that block, and their
 * readings, the block hash included, must be identical.
 *
 * Amounts are exact decimal strings with the token's decimals applied, beside
 * the raw integer: supplies and balances exceed 2^53 base units.
 */
import {
  BaseError, CallExecutionError, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  ExecutionRevertedError, formatUnits, getAddress, hexToString, isAddress, parseAbi, type PublicClient,
} from 'viem';
import { normalize } from 'viem/ens';
import type { RpcClient } from '../config/chains.js';
import { TruthError, twoAgree } from './agree.js';
import { CHAIN_LABEL, CONFIRMATIONS, CURRENT_CHAINS, chainId, parseChain, stateEndpoints, type CurrentChain } from './endpoints.js';
import { confirm, locate, parseTokenRef, type ContractFacts, type Target } from './token.js';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);
/** symbol() and name() as tokens older than the ERC-20 text form return them (MKR) */
const ERC20_BYTES32 = parseAbi(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);

/** The call reached the contract and its answer did not decode as the ABI says. */
function undecodable(err: unknown): boolean {
  return err instanceof ContractFunctionExecutionError
    && err.walk((e) => e instanceof CallExecutionError || e instanceof ContractFunctionZeroDataError
      || e instanceof ContractFunctionRevertedError) === null;
}

/**
 * Whether a failed call is the contract's own answer (it reverted, returned
 * nothing, or returned bytes that do not decode). Anything else is the
 * endpoint not answering, and makes that endpoint's reading a failure.
 */
function contractAnswered(err: unknown): boolean {
  return err instanceof BaseError
    && (err.walk((e) => e instanceof ExecutionRevertedError || e instanceof ContractFunctionZeroDataError) !== null || undecodable(err));
}

/** A call's result, null when the contract itself refused it; throws when the endpoint did not answer. */
async function orRefused<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (contractAnswered(err)) return null;
    throw err;
  }
}

async function readText(client: PublicClient, address: `0x${string}`, functionName: 'symbol' | 'name', blockNumber: bigint): Promise<string | null> {
  try {
    return await client.readContract({ address, abi: ERC20, functionName, blockNumber });
  } catch (err) {
    if (!undecodable(err)) {
      if (contractAnswered(err)) return null;
      throw err;
    }
    const word = await orRefused(client.readContract({ address, abi: ERC20_BYTES32, functionName, blockNumber }));
    return word === null ? null : hexToString(word, { size: 32 }).replace(/\0+$/, '');
  }
}

/** The block every read is made at: the tip less the chain's confirmations, from the first endpoint that reports a tip. */
async function anchorHeight(chain: CurrentChain, endpoints: RpcClient[]): Promise<bigint> {
  for (const { client } of endpoints) {
    try {
      return (await client.getBlockNumber()) - CONFIRMATIONS[chain];
    } catch {
      // next endpoint
    }
  }
  throw new TruthError(503, 'NO_SOURCE', `no ${CHAIN_LABEL[chain]} endpoint reported the chain tip`);
}

interface BlockReading {
  hash: string;
  /** Unix seconds */
  timestamp: string;
}

/** The block at a height, as one endpoint has it; throws when it has none. */
async function blockAt(client: PublicClient, number: bigint): Promise<BlockReading> {
  const block = await client.getBlock({ blockNumber: number });
  return { hash: block.hash, timestamp: block.timestamp.toString() };
}

interface ContractReading extends BlockReading {
  facts: ContractFacts;
  /** totalSupply() or balanceOf(holder); null when the contract refused it */
  value: string | null;
}

async function readContract(
  client: PublicClient, address: `0x${string}`, number: bigint, call: { totalSupply: true } | { balanceOf: `0x${string}` },
): Promise<ContractReading> {
  const [block, code] = await Promise.all([blockAt(client, number), client.getCode({ address, blockNumber: number })]);
  if (code === undefined || code === '0x') return { ...block, facts: { code: false, decimals: null, symbol: null, name: null }, value: null };
  const [decimals, symbol, name, value] = await Promise.all([
    orRefused(client.readContract({ address, abi: ERC20, functionName: 'decimals', blockNumber: number })),
    readText(client, address, 'symbol', number),
    readText(client, address, 'name', number),
    'totalSupply' in call
      ? orRefused(client.readContract({ address, abi: ERC20, functionName: 'totalSupply', blockNumber: number }))
      : orRefused(client.readContract({ address, abi: ERC20, functionName: 'balanceOf', args: [call.balanceOf], blockNumber: number })),
  ]);
  return {
    ...block,
    facts: { code: true, decimals: decimals === null ? null : Number(decimals), symbol, name },
    value: value === null ? null : value.toString(),
  };
}

const showContract = (r: ContractReading) => `block ${r.hash.slice(0, 12)}… ${JSON.stringify(r.facts)} value ${r.value}`;

function isoTime(seconds: string): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

// ---------- TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL ----------

export interface SupplyQuery {
  chain: CurrentChain;
  target: Extract<Target, { kind: 'contract' }>;
}

export interface SupplyAnswer {
  chain: CurrentChain;
  chain_id: number;
  /** symbol() at the block */
  token: string;
  token_address: string;
  decimals: number;
  /** Whole tokens, decimals applied, exact decimal string (the intent's scored field) */
  total_supply: string;
  /** totalSupply() in base units, decimal string */
  total_supply_raw: string;
  block: string;
  block_hash: string;
  /** The block's timestamp */
  as_of: string;
  agreed_by: [string, string];
}

/** The intent's question template, in case the whole question arrives as the token. */
const SUPPLY_QUESTION = /^what is the current total supply of (.+?),? in whole tokens\??$/i;

/**
 * Read the intent's one `token` parameter: a token and its chain, as the node
 * writes them ("USDC (0xA0b8…) on Ethereum", "Kelp DAO Restaked ETH (rsETH)
 * on Ethereum"). The chain is the words after the last " on " and must be
 * given: with none, the question could mean any chain. An explicit `chain`
 * parameter is accepted instead.
 */
export function parseSupplyQuery(raw: Record<string, unknown>): SupplyQuery {
  const text = String(raw.token ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new TruthError(400, 'INVALID_TOKEN', 'token is required: a symbol or contract address, and its chain ("USDC (0x…) on Ethereum")');
  const asked = text.match(SUPPLY_QUESTION)?.[1] ?? text;
  const on = asked.match(/^(.*\S) on (\S.*)$/i);
  const explicit = String(raw.chain ?? '').trim();
  let chain: CurrentChain | null;
  let tokenText: string;
  if (explicit) {
    chain = parseChain(explicit);
    tokenText = asked;
    if (chain && on && parseChain(on[2]) !== null && parseChain(on[2]) !== chain) {
      throw new TruthError(400, 'CHAIN_CONFLICT', `the chain parameter says ${explicit} and the token text says ${on[2]}`);
    }
    if (chain && on && parseChain(on[2]) === chain) tokenText = on[1]!;
  } else {
    if (!on) throw new TruthError(400, 'CHAIN_MISSING', `"${text}" names no chain; write the token as "<token> on <chain>" (${CURRENT_CHAINS.join(', ')})`);
    chain = parseChain(on[2]);
    tokenText = on[1]!;
  }
  if (!chain) {
    throw new TruthError(400, 'CHAIN_UNSUPPORTED', `chain must be one of ${CURRENT_CHAINS.join(', ')}; got ${explicit || on![2]}`);
  }
  const target = locate(chain, parseTokenRef(tokenText), false);
  if (target.kind !== 'contract') throw new TruthError(422, 'NATIVE_HAS_NO_SUPPLY', 'a native coin has no totalSupply() to read');
  return { chain, target };
}

export async function totalSupply(q: SupplyQuery, endpoints: RpcClient[] = stateEndpoints(q.chain)): Promise<SupplyAnswer> {
  const number = await anchorHeight(q.chain, endpoints);
  const { value: r, agreed_by } = await twoAgree(endpoints, ({ client }) => readContract(client, q.target.address, number, { totalSupply: true }), {
    key: (v) => JSON.stringify(v), show: showContract, what: `reads of block ${number}`,
  });
  const { decimals, symbol } = confirm(q.chain, q.target, r.facts, number);
  if (r.value === null) throw new TruthError(422, 'NO_TOTAL_SUPPLY', `${q.target.address} on ${CHAIN_LABEL[q.chain]} does not answer totalSupply() at block ${number}`);
  return {
    chain: q.chain,
    chain_id: chainId(q.chain),
    token: symbol,
    token_address: q.target.address,
    decimals,
    total_supply: formatUnits(BigInt(r.value), decimals),
    total_supply_raw: r.value,
    block: number.toString(),
    block_hash: r.hash,
    as_of: isoTime(r.timestamp),
    agreed_by,
  };
}

// ---------- WALLET_BALANCE_CHECK_GENERAL ----------

export interface WalletQuery {
  chain: CurrentChain;
  /** A 0x address (EIP-55) or an ENS name */
  holder: string;
  target: Target;
}

export interface WalletAnswer {
  chain: CurrentChain;
  chain_id: number;
  /** EIP-55 */
  address: string;
  /** The ENS name asked for, when one was */
  ens_name: string | null;
  token_symbol: string;
  /** Null for the native coin */
  token_address: string | null;
  decimals: number;
  /** Whole units, decimals applied, exact decimal string (the intent's scored field) */
  balance: string;
  /** Base units (wei for the native coin), decimal string */
  balance_raw: string;
  block: string;
  block_hash: string;
  as_of: string;
  agreed_by: [string, string];
}

const ENS_NAME = /^[^\s]+\.eth$/i;

export function parseWalletQuery(raw: Record<string, unknown>): WalletQuery {
  const chainRaw = String(raw.chain ?? '').trim();
  if (!chainRaw) throw new TruthError(400, 'CHAIN_MISSING', `chain is required (${CURRENT_CHAINS.join(', ')})`);
  const chain = parseChain(chainRaw);
  if (!chain) throw new TruthError(400, 'CHAIN_UNSUPPORTED', `chain must be one of ${CURRENT_CHAINS.join(', ')} (or its chain id); got ${chainRaw}`);
  const holderRaw = String(raw.address ?? '').trim();
  let holder: string;
  if (isAddress(holderRaw, { strict: false })) holder = getAddress(holderRaw);
  else if (ENS_NAME.test(holderRaw)) {
    try {
      holder = normalize(holderRaw);
    } catch {
      throw new TruthError(400, 'INVALID_ADDRESS', `${holderRaw} is not a valid ENS name`);
    }
  } else throw new TruthError(400, 'INVALID_ADDRESS', 'address must be 0x followed by 40 hexadecimal characters, or an ENS name ending in .eth');
  return { chain, holder, target: locate(chain, parseTokenRef(String(raw.token ?? '')), true) };
}

/** An ENS name to its address on Ethereum mainnet, agreed by two endpoints at one block. */
async function resolveEns(name: string, endpoints: RpcClient[] = stateEndpoints('ethereum')): Promise<`0x${string}`> {
  const number = await anchorHeight('ethereum', endpoints);
  const { value } = await twoAgree(endpoints, async ({ client }) => ({
    ...(await blockAt(client, number)),
    address: (await client.getEnsAddress({ name, blockNumber: number })) ?? null,
  }), { key: (v) => JSON.stringify(v), show: (v) => `${v.address} (block ${v.hash.slice(0, 12)}…)`, what: `ENS reads at Ethereum block ${number}` });
  if (value.address === null) throw new TruthError(422, 'ENS_UNRESOLVED', `${name} resolves to no address at Ethereum block ${number}`);
  return getAddress(value.address);
}

export async function walletBalance(q: WalletQuery, endpoints: RpcClient[] = stateEndpoints(q.chain)): Promise<WalletAnswer> {
  const ens = isAddress(q.holder, { strict: false }) ? null : q.holder;
  const address = ens === null ? (q.holder as `0x${string}`) : await resolveEns(ens);
  const number = await anchorHeight(q.chain, endpoints);
  const common = { chain: q.chain, chain_id: chainId(q.chain), address, ens_name: ens, block: number.toString() };

  if (q.target.kind === 'native') {
    const { value: r, agreed_by } = await twoAgree(endpoints, async ({ client }) => ({
      ...(await blockAt(client, number)),
      wei: (await client.getBalance({ address, blockNumber: number })).toString(),
    }), { key: (v) => JSON.stringify(v), show: (v) => `${v.wei} wei (block ${v.hash.slice(0, 12)}…)`, what: `reads of block ${number}` });
    return {
      ...common, token_symbol: q.target.symbol, token_address: null, decimals: 18,
      balance: formatUnits(BigInt(r.wei), 18), balance_raw: r.wei, block_hash: r.hash, as_of: isoTime(r.timestamp), agreed_by,
    };
  }

  const target = q.target;
  const { value: r, agreed_by } = await twoAgree(endpoints, ({ client }) => readContract(client, target.address, number, { balanceOf: address }), {
    key: (v) => JSON.stringify(v), show: showContract, what: `reads of block ${number}`,
  });
  const { decimals, symbol } = confirm(q.chain, target, r.facts, number);
  if (r.value === null) throw new TruthError(422, 'NO_BALANCE_OF', `${target.address} on ${CHAIN_LABEL[q.chain]} does not answer balanceOf() at block ${number}`);
  return {
    ...common, token_symbol: symbol, token_address: target.address, decimals,
    balance: formatUnits(BigInt(r.value), decimals), balance_raw: r.value, block_hash: r.hash, as_of: isoTime(r.timestamp), agreed_by,
  };
}
