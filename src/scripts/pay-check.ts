/**
 * Reference x402 client for Truvian Shield.
 *
 * Runs a safety check and pays for it: POST /api/check, and if Shield answers
 * 402, sign the EIP-3009 authorization it asks for and retry with the
 * X-PAYMENT header. This is exactly what an autonomous agent does before it
 * signs a transaction, and it is the flow the browser wallet performs too.
 *
 *   TELEGRAPH_PAYER_KEY=0x… npx tsx src/scripts/pay-check.ts [baseUrl]
 *
 * Payment is gasless for the payer: the signature authorizes a USDC transfer
 * that the facilitator submits, so the caller needs USDC and no ETH.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const BASE = (process.argv[2] ?? process.env.SHIELD_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');

interface Requirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

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

const CHAIN_BY_NETWORK: Record<string, number> = { 'base-sepolia': 84532, base: 8453 };

/** Sign one payment for these requirements and return the X-PAYMENT value. */
async function signPayment(requirements: Requirements): Promise<string> {
  const key = process.env.TELEGRAPH_PAYER_KEY?.trim();
  if (!key) throw new Error('TELEGRAPH_PAYER_KEY is required to pay');
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const chainId = CHAIN_BY_NETWORK[requirements.network];
  if (!chainId) throw new Error(`unsupported payment network ${requirements.network}`);

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
    types: TYPES,
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

async function main() {
  const body = JSON.stringify({ chain: 'base', valueEth: 0.25 });
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  let res = await fetch(`${BASE}/api/check`, { method: 'POST', headers, body });
  console.log(`first attempt -> http ${res.status}`);

  if (res.status === 402) {
    const challenge = (await res.json()) as { error?: string; accepts?: Requirements[] };
    const requirements = challenge.accepts?.[0];
    if (!requirements) throw new Error('402 carried no payment requirements');
    const price = Number(requirements.maxAmountRequired) / 1e6;
    console.log(`  reason: ${challenge.error}`);
    console.log(`  price : $${price.toFixed(2)} ${requirements.extra?.name ?? 'USDC'} on ${requirements.network} to ${requirements.payTo}`);
    headers['X-PAYMENT'] = await signPayment(requirements);
    res = await fetch(`${BASE}/api/check`, { method: 'POST', headers, body });
    console.log(`paid attempt  -> http ${res.status}`);
    const settled = res.headers.get('x-payment-response');
    if (settled) {
      const decoded = JSON.parse(Buffer.from(settled, 'base64').toString('utf8')) as Record<string, unknown>;
      console.log('  settlement:', JSON.stringify(decoded));
    }
  }

  const report = (await res.json()) as { verdict?: string; score?: number; checks?: Array<{ name: string; status: string; costUsd?: number }> };
  if (report.verdict) {
    console.log(`\nverdict ${report.verdict} (score ${report.score})`);
    for (const c of report.checks ?? []) console.log(`  ${c.status.padEnd(5)} ${c.name}${c.costUsd ? ` $${c.costUsd}` : ''}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error('FAILED', err instanceof Error ? err.message : err);
  process.exit(1);
});
