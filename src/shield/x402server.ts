/**
 * Shield as an x402 SERVER: charging for a safety check.
 *
 * Shield already pays Telegraph miners over x402 (telegraph.ts is the client
 * side). This module is the other half - it lets Shield be paid, so a check
 * funds the miner queries it triggers instead of draining our wallet:
 *
 *   caller -> POST /api/check           (no payment header)
 *   Shield -> 402 + PaymentRequirements (price, asset, payTo, network)
 *   caller -> POST /api/check           (X-PAYMENT: base64 signed authorization)
 *   Shield -> facilitator /verify       (is the signature good for this price?)
 *   Shield -> runs the four miner queries
 *   Shield -> facilitator /settle       (move the USDC, gaslessly for the payer)
 *   Shield -> 200 + report + X-PAYMENT-RESPONSE (settlement tx hash)
 *
 * Wire format verified against https://facilitator.payai.network on 2026-09-05:
 * x402 VERSION 1 with the short network name ("base-sepolia", not
 * "eip155:84532"); /verify answered {isValid:true,payer} and /settle answered
 * {success:true,transaction:"0x…"} for a signed EIP-3009 authorization.
 *
 * Payments are gasless for the payer: they sign a TransferWithAuthorization
 * (EIP-3009) and the facilitator submits it, so a caller needs USDC only.
 */
import type { Address } from 'viem';

const USDC_ATOMIC_PER_USD = 1_000_000;
const DEFAULT_PRICE_USD = 0.05;
const DEFAULT_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const FACILITATOR_TIMEOUT_MS = 30_000;

/** x402 v1 PaymentRequirements, exactly as the facilitator validates it. */
export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

export interface VerifyResult {
  valid: boolean;
  payer?: string;
  reason?: string;
  payload?: PaymentPayload;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  reason?: string;
}

function facilitatorUrl(): string {
  return (process.env.X402_FACILITATOR_URL ?? 'https://facilitator.payai.network').replace(/\/+$/, '');
}

/** Short v1 network name for the configured payment chain. */
function networkName(): string {
  const byId: Record<string, string> = { '8453': 'base', '84532': 'base-sepolia' };
  const id = process.env.X402_CHAIN_ID?.trim();
  return (id && byId[id]) || 'base-sepolia';
}

function usdcAddress(): string {
  const raw = process.env.X402_USDC_ADDRESS?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : DEFAULT_USDC;
}

/** Price of one safety check in USD (SHIELD_PRICE_USD, default $0.05). */
export function priceUsd(): number {
  const raw = process.env.SHIELD_PRICE_USD;
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_PRICE_USD : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRICE_USD;
}

/** Address revenue is paid to (SHIELD_PAYTO, else the payer wallet). */
export function payToAddress(fallback: Address | null): string | null {
  const raw = process.env.SHIELD_PAYTO?.trim();
  if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;
  return fallback;
}

/** True when Shield is configured to charge for checks. */
export function paymentsEnabled(fallbackPayTo: Address | null): boolean {
  return process.env.SHIELD_PAYMENTS !== 'off' && payToAddress(fallbackPayTo) !== null;
}

/** Build the challenge a 402 response carries. */
export function buildRequirements(resource: string, payTo: string, price = priceUsd()): PaymentRequirements {
  return {
    scheme: 'exact',
    network: networkName(),
    maxAmountRequired: String(Math.round(price * USDC_ATOMIC_PER_USD)),
    resource,
    description: 'Truvian Shield execution-safety check: four paid queries to live Telegraph miners, one verdict with receipts.',
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 300,
    asset: usdcAddress(),
    extra: { name: 'USDC', version: '2' },
  };
}

/** The JSON body of a 402, per the x402 v1 spec. */
export function challengeBody(requirements: PaymentRequirements, error: string): { x402Version: number; error: string; accepts: PaymentRequirements[] } {
  return { x402Version: 1, error, accepts: [requirements] };
}

/**
 * Read a payment payload from the request headers. Accepts the v1 standard
 * `X-PAYMENT` and the header name the Telegraph node uses
 * (`PAYMENT-SIGNATURE`), so both client styles work against Shield.
 */
export function readPaymentHeader(headers: Record<string, unknown>): PaymentPayload | null {
  const raw = headers['x-payment'] ?? headers['payment-signature'] ?? headers['x-payment-signature'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, unknown>;
    const inner = decoded.payload as PaymentPayload['payload'] | undefined;
    if (!inner || typeof inner.signature !== 'string' || typeof inner.authorization !== 'object') return null;
    return {
      x402Version: 1,
      scheme: typeof decoded.scheme === 'string' ? decoded.scheme : 'exact',
      network: typeof decoded.network === 'string' ? decoded.network : networkName(),
      payload: inner,
    };
  } catch {
    return null;
  }
}

async function callFacilitator(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${facilitatorUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

/**
 * Ask the facilitator whether this payment is good for these requirements.
 * Also re-checks the amount locally, so a caller cannot underpay by sending
 * requirements of their own.
 */
export async function verifyPayment(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
  const authorized = BigInt(payment.payload.authorization.value || '0');
  const required = BigInt(requirements.maxAmountRequired);
  if (authorized < required) {
    return { valid: false, reason: `authorized ${authorized} is below the price ${required}` };
  }
  if (payment.payload.authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { valid: false, reason: 'payment is addressed to a different recipient' };
  }
  try {
    const { body } = await callFacilitator('/verify', {
      x402Version: 1,
      paymentPayload: payment,
      paymentRequirements: requirements,
    });
    if (body.isValid === true) {
      const payer = typeof body.payer === 'string' ? body.payer : undefined;
      return payer ? { valid: true, payer, payload: payment } : { valid: true, payload: payment };
    }
    const reason = [body.invalidReason, body.invalidMessage].filter((v) => typeof v === 'string').join(': ');
    return { valid: false, reason: reason || 'facilitator rejected the payment' };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Move the money. Called after the work succeeded. Never throws. */
export async function settlePayment(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult> {
  try {
    const { body } = await callFacilitator('/settle', {
      x402Version: 1,
      paymentPayload: payment,
      paymentRequirements: requirements,
    });
    if (body.success === true) {
      const tx = typeof body.transaction === 'string' ? body.transaction : undefined;
      return tx ? { success: true, transaction: tx } : { success: true };
    }
    const reason = [body.errorReason, body.error, body.invalidMessage].filter((v) => typeof v === 'string').join(': ');
    return { success: false, reason: reason || 'settlement failed' };
  } catch (err) {
    return { success: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Base64 value for the X-PAYMENT-RESPONSE header. */
export function encodeSettlement(result: SettleResult): string {
  return Buffer.from(
    JSON.stringify({
      success: result.success,
      transaction: result.transaction ?? null,
      network: networkName(),
    }),
  ).toString('base64');
}
