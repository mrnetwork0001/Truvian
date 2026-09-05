/**
 * Payer wallet introspection for Truvian Shield.
 *
 * Shield pays miners in USDC over x402 from a single hot wallet. The dashboard
 * needs to say how many more checks that wallet can fund, and the limiter needs
 * to stop before the wallet is empty, so this module derives the payer ADDRESS
 * from TELEGRAPH_PAYER_KEY and reads its USDC balance on the x402 chain.
 *
 * The private key never leaves this module: only the derived address, and only
 * the balance, are exposed. Balance reads are cached and never throw - an
 * unreachable RPC yields null, which the UI renders as "unknown" rather than
 * as zero.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { getClient, isSupportedChain, type SupportedChain } from '../config/chains.js';

const USDC_DECIMALS = 6;
const BALANCE_TTL_MS = 60_000;
const DEFAULT_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

let cache: { at: number; balance: number | null } | null = null;

/** Public address of the x402 payer wallet, or null when no valid key is set. */
export function payerAddress(): Address | null {
  const key = process.env.TELEGRAPH_PAYER_KEY?.trim();
  if (!key) return null;
  try {
    return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex).address;
  } catch {
    return null;
  }
}

/** Chain the x402 payments settle on (X402_CHAIN_ID, default Base Sepolia). */
function paymentChain(): SupportedChain {
  const id = process.env.X402_CHAIN_ID?.trim();
  const byId: Record<string, SupportedChain> = { '8453': 'base', '84532': 'base-sepolia', '1': 'ethereum' };
  const named = id ? byId[id] : undefined;
  if (named) return named;
  const raw = process.env.X402_CHAIN?.trim().toLowerCase();
  return raw && isSupportedChain(raw) ? raw : 'base-sepolia';
}

function usdcAddress(): Address {
  const raw = process.env.X402_USDC_ADDRESS?.trim();
  return (raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : DEFAULT_USDC) as Address;
}

/**
 * USDC balance of the payer wallet in whole dollars, or null when it cannot be
 * read (no key, RPC down). Cached for 60s; never throws.
 */
export async function payerUsdcBalance(force = false): Promise<number | null> {
  const now = Date.now();
  if (!force && cache && now - cache.at < BALANCE_TTL_MS) return cache.balance;
  const address = payerAddress();
  if (!address) {
    cache = { at: now, balance: null };
    return null;
  }
  try {
    const raw = (await getClient(paymentChain()).readContract({
      address: usdcAddress(),
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
    const balance = Number(raw) / 10 ** USDC_DECIMALS;
    cache = { at: now, balance: Number.isFinite(balance) ? balance : null };
    return cache.balance;
  } catch {
    // Keep the last good reading rather than flipping the UI to "unknown"
    // on a single RPC hiccup; only the timestamp moves so we retry soon.
    cache = { at: now, balance: cache?.balance ?? null };
    return cache.balance;
  }
}
