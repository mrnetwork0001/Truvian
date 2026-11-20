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
import { formatUnits, getAddress, isAddress, parseAbi } from 'viem';
import { normalize } from 'viem/ens';
import { chainMeta, getClient, type SupportedChain } from '../config/chains.js';
import { KNOWN_TOKENS, NATIVE_SYMBOLS } from '../config/tokens.js';
import { IntentError } from '../types/index.js';
import { chainFromText, requireChain } from './txLookup.js';

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** A token resolved to its contract, or the chain's native coin (address null). */
interface Asset {
  address: `0x${string}` | null;
  decimals: number;
  symbol: string;
}

/** ERC-20 metadata read from the contract itself, at the anchoring block. */
async function readErc20(chain: SupportedChain, address: `0x${string}`, blockNumber: bigint): Promise<Asset> {
  const client = getClient(chain);
  try {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address, abi: ERC20, functionName: 'decimals', blockNumber }),
      client.readContract({ address, abi: ERC20, functionName: 'symbol', blockNumber }),
    ]);
    return { address, decimals: Number(decimals), symbol };
  } catch {
    throw new IntentError('INVALID_INPUT', `${address} on ${chain} does not answer decimals() and symbol() like an ERC-20 token`);
  }
}

/** Resolve a token reference: empty or a native symbol, a contract address, or a known symbol. */
async function resolveAsset(chain: SupportedChain, raw: string, blockNumber: bigint): Promise<Asset> {
  const meta = chainMeta(chain);
  const t = raw.trim();
  if (t === '' || NATIVE_SYMBOLS.has(t.toUpperCase()) || t.toUpperCase() === meta.nativeSymbol) {
    return { address: null, decimals: 18, symbol: meta.nativeSymbol };
  }
  const addr = t.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (addr) return readErc20(chain, getAddress(addr), blockNumber);
  const known = KNOWN_TOKENS[chain]?.[t.toUpperCase()];
  if (known) {
    const onChain = await readErc20(chain, known.address, blockNumber);
    return { ...onChain, decimals: known.decimals };
  }
  throw new IntentError('INVALID_INPUT', `token "${t}" is not a contract address or a token this miner knows on ${chain}; give the contract address`);
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
    source: `${meta.label} JSON-RPC ${asset.address ? 'eth_call balanceOf' : 'eth_getBalance'} at block ${block.number}`,
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
  token: string;
  chain: SupportedChain;
}

/**
 * The intent sends one `token` string such as "USDC (0xA0b8…) on Ethereum":
 * a symbol, an address or both, and the chain in words. An explicit `chain`
 * parameter wins over a chain named in the text; Ethereum otherwise.
 */
export function validateSupplyInput(raw: unknown): SupplyInput {
  if (typeof raw !== 'object' || raw === null) throw new IntentError('INVALID_INPUT', 'input must be an object');
  const body = raw as Record<string, unknown>;
  const token = String(body.token ?? body.query ?? '').trim();
  if (!token) throw new IntentError('INVALID_INPUT', 'token is required (symbol or contract address, and its chain)');
  const chainRaw = body.chain ?? body.network;
  const chain = chainRaw !== undefined && String(chainRaw).trim() !== '' ? requireChain(chainRaw) : chainFromText(token) ?? 'ethereum';
  return { token, chain };
}

export async function handleSupply(input: SupplyInput) {
  const block = await anchor(input.chain);
  const addr = input.token.match(/0x[0-9a-fA-F]{40}/)?.[0];
  const symbolWord = input.token.replace(/\(.*?\)/g, ' ').split(/\s+/).find((w) => /^[A-Za-z][A-Za-z0-9.]{1,10}$/.test(w) && !/^on$/i.test(w));
  const asset = await resolveAsset(input.chain, addr ?? symbolWord ?? input.token, block.number);
  if (asset.address === null) {
    throw new IntentError('INVALID_INPUT', `${asset.symbol} is ${chainMeta(input.chain).label}'s native coin, which has no totalSupply() to read; give an ERC-20 token`);
  }
  let raw: bigint;
  try {
    raw = await getClient(input.chain).readContract({ address: asset.address, abi: ERC20, functionName: 'totalSupply', blockNumber: block.number });
  } catch (err: any) {
    throw new IntentError('UPSTREAM_RPC_ERROR', err?.shortMessage ?? err?.message ?? 'rpc failure');
  }
  const meta = chainMeta(input.chain);
  const exact = formatUnits(raw, asset.decimals);
  const answer = `The total supply of ${asset.symbol} (${asset.address}) on ${meta.label} is ${exact} tokens at block ${block.number} (${raw} base units, ${asset.decimals} decimals).`;
  return {
    answer,
    signal: answer,
    source: `${meta.label} JSON-RPC eth_call totalSupply at block ${block.number}`,
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
