/**
 * Client half of x402: sign a payment for a 402 challenge.
 *
 * Shared by the reference client (src/scripts/pay-check.ts) and the agent
 * guard (src/agent/guard.ts). The browser does the same thing in
 * src/shield/public/wallet.js, using the wallet instead of a local key.
 *
 * The signature authorizes an EIP-3009 TransferWithAuthorization on USDC; the
 * facilitator submits it, so the payer spends no gas.
 */
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, PrivateKeyAccount } from 'viem';

/** The subset of x402 PaymentRequirements a payer needs. */
export interface PayableRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const CHAIN_ID_BY_NETWORK: Record<string, number> = {
  'base-sepolia': 84532,
  base: 8453,
};

/** Build an account from a 0x-prefixed (or bare) private key. */
export function accountFromKey(key: string): PrivateKeyAccount {
  const trimmed = key.trim();
  return privateKeyToAccount((trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex);
}

/** Price of a challenge in whole USD. */
export function requirementPriceUsd(requirements: PayableRequirements): number {
  return Number(requirements.maxAmountRequired) / 1_000_000;
}

/**
 * Sign `requirements` and return the base64 value for the X-PAYMENT header.
 * Throws when the network is unknown, rather than signing something the
 * facilitator will reject.
 */
export async function signPaymentHeader(account: PrivateKeyAccount, requirements: PayableRequirements): Promise<string> {
  const chainId = CHAIN_ID_BY_NETWORK[requirements.network];
  if (!chainId) throw new Error(`unsupported x402 payment network: ${requirements.network}`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value: requirements.maxAmountRequired,
    validAfter: String(now - 60),
    validBefore: String(now + Math.max(60, requirements.maxTimeoutSeconds ?? 300)),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };

  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra?.name ?? 'USDC',
      version: requirements.extra?.version ?? '2',
      chainId,
      verifyingContract: requirements.asset as Hex,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to as Hex,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as Hex,
    },
  });

  return Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: 'exact', network: requirements.network, payload: { signature, authorization } }),
  ).toString('base64');
}
