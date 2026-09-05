/**
 * Probe: can Shield ACCEPT x402 payments (be the server, not the client)?
 * Signs a real EIP-3009 authorization with the payer key and calls the
 * facilitator's /verify. Nothing settles, so no funds move.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const FAC = (process.env.X402_FACILITATOR_URL ?? 'https://facilitator.payai.network').replace(/\/+$/, '');
const USDC = process.env.X402_USDC_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const key = process.env.TELEGRAPH_PAYER_KEY!;
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

async function probe(version: number, network: string) {
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: account.address,
    to: account.address, // self: verify-only, settling would be a no-op transfer
    value: '1000',
    validAfter: String(now - 60),
    validBefore: String(now + 600),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC as Hex },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to as Hex,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Hex,
    },
  });

  const paymentRequirements = {
    scheme: 'exact',
    network,
    maxAmountRequired: '1000',
    resource: 'https://truvian.xyz/api/check',
    description: 'Truvian Shield safety check',
    mimeType: 'application/json',
    payTo: account.address,
    maxTimeoutSeconds: 300,
    asset: USDC,
    extra: { name: 'USDC', version: '2' },
  };
  const paymentPayload = { x402Version: version, scheme: 'exact', network, payload: { signature, authorization: auth } };

  const res = await fetch(`${FAC}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: version, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(20_000),
  });
  console.log(`v${version} ${network} -> http ${res.status}`, (await res.text()).slice(0, 400));
}

/** Same payload, but through /settle - proves Shield can actually collect. */
async function probeSettle() {
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: account.address,
    to: account.address, // self-transfer: settles for real, moves nothing
    value: '1000',
    validAfter: String(now - 60),
    validBefore: String(now + 600),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC as Hex },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to as Hex,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Hex,
    },
  });
  const paymentRequirements = {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '1000',
    resource: 'https://truvian.xyz/api/check',
    description: 'Truvian Shield safety check',
    mimeType: 'application/json',
    payTo: account.address,
    maxTimeoutSeconds: 300,
    asset: USDC,
    extra: { name: 'USDC', version: '2' },
  };
  const paymentPayload = { x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: { signature, authorization: auth } };
  const res = await fetch(`${FAC}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(60_000),
  });
  console.log(`settle -> http ${res.status}`, (await res.text()).slice(0, 400));
}

async function main() {
  console.log('payer:', account.address);
  await probe(1, 'base-sepolia');
  await probe(2, 'base-sepolia');
  await probe(1, 'eip155:84532');
  if (process.env.PROBE_SETTLE === '1') await probeSettle();
}
main().catch((e) => console.error('FATAL', e));
