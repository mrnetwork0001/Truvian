/**
 * Configuration for Truvian's ACP agents, read from ../.env (the repo's) and
 * ./.env. Nothing here is printed.
 *
 *   ACP_NETWORK            testnet (default: Base Sepolia, api-dev.acp.virtuals.io, test USDC)
 *                          or mainnet (Base, api.acp.virtuals.io, real USDC)
 *   ACP_BUILDER_CODE       optional Base builder code (bc-...)
 *
 * One agent per role, each registered on app.virtuals.io with its own wallet
 * (ACP requires the buyer and the seller to use different wallets):
 *
 *   ACP_TRUVIAN_WALLET_ADDRESS / _WALLET_ID / _SIGNER_KEY
 *       Truvian: sells "Counterparty due diligence" and evaluates other agents' work
 *   ACP_BUYER_WALLET_ADDRESS / _WALLET_ID / _SIGNER_KEY          (demo only)
 *   ACP_DEMO_PROVIDER_WALLET_ADDRESS / _WALLET_ID / _SIGNER_KEY  (demo only)
 *
 *   SHIELD_URL             where Shield runs (default https://truvian.xyz)
 *   SHIELD_INTERNAL_KEY    the same value as on the Shield server; lets the agents run desks
 *                          without the public free allowance and book their ACP sales
 *   ACP_DILIGENCE_PRICE_USD  what one due diligence report costs on ACP (default 0.10)
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { base, baseSepolia, type Chain } from 'viem/chains';

const here = fileURLToPath(new URL('.', import.meta.url));
loadEnv({ path: `${here}../.env`, quiet: true });
loadEnv({ path: `${here}../../.env`, quiet: true });

// The SDK's own constants (core/constants.js in @virtuals-protocol/acp-node-v2 0.1.15)
const SERVER = { testnet: 'https://api-dev.acp.virtuals.io', mainnet: 'https://api.acp.virtuals.io' } as const;
const PRIVY_APP = { testnet: 'clsakj3e205soyepnl23x2itv', mainnet: 'cltsev9j90f67yhyw4sngtrpv' } as const;

export type AcpNetwork = 'testnet' | 'mainnet';
export type Role = 'TRUVIAN' | 'BUYER' | 'DEMO_PROVIDER';

export class ConfigError extends Error {}

export function network(): AcpNetwork {
  const n = (process.env.ACP_NETWORK ?? 'testnet').trim().toLowerCase();
  if (n !== 'testnet' && n !== 'mainnet') throw new ConfigError('ACP_NETWORK must be testnet or mainnet');
  return n;
}

export function chain(): Chain {
  return network() === 'mainnet' ? base : baseSepolia;
}

export function serverUrl(): string {
  return SERVER[network()];
}

export function privyAppId(): string {
  return PRIVY_APP[network()];
}

/** Where the payment for an ACP job settles, as the ledger records it */
export function settlementNetwork(): string {
  return network() === 'mainnet' ? 'base' : 'base-sepolia';
}

export interface Wallet { walletAddress: `0x${string}`; walletId: string; signerPrivateKey: string }

export function wallet(role: Role): Wallet {
  const names = [`ACP_${role}_WALLET_ADDRESS`, `ACP_${role}_WALLET_ID`, `ACP_${role}_SIGNER_KEY`];
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) throw new ConfigError(`set ${missing.join(', ')} in .env (from the agent's page on app.virtuals.io: Signers tab)`);
  const walletAddress = process.env[names[0]!]!.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new ConfigError(`${names[0]} must be a 0x address`);
  return { walletAddress: walletAddress as `0x${string}`, walletId: process.env[names[1]!]!.trim(), signerPrivateKey: process.env[names[2]!]!.trim() };
}

export function builderCode(): string | undefined {
  return process.env.ACP_BUILDER_CODE?.trim() || undefined;
}

export function shieldUrl(): string {
  return (process.env.SHIELD_URL ?? 'https://truvian.xyz').replace(/\/$/, '');
}

export function shieldKey(): string {
  const k = process.env.SHIELD_INTERNAL_KEY?.trim();
  if (!k || k.length < 24) throw new ConfigError('set SHIELD_INTERNAL_KEY (at least 24 characters, the same value as on the Shield server)');
  return k;
}

export function diligencePriceUsd(): number {
  const n = Number(process.env.ACP_DILIGENCE_PRICE_USD ?? '0.10');
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new ConfigError('ACP_DILIGENCE_PRICE_USD must be between 0 and 100');
  return n;
}

/** The offering name registered on app.virtuals.io for the report */
export const DILIGENCE_OFFERING = process.env.ACP_DILIGENCE_OFFERING?.trim() || 'counterpartyDueDiligence';
