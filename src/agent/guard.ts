/**
 * Drop-in execution guard for onchain agents.
 *
 * Wraps a viem wallet client so that every sendTransaction is checked by
 * Truvian Shield first, and refuses to sign when the verdict is BLOCK:
 *
 *   import { createWalletClient, http } from 'viem';
 *   import { guard } from 'truvian/agent/guard.js';
 *
 *   const wallet = guard(createWalletClient({ account, chain: base, transport: http() }), {
 *     shieldUrl: 'https://truvian.xyz',
 *     payerKey: process.env.TELEGRAPH_PAYER_KEY,   // optional: pay past the free tier
 *   });
 *
 *   await wallet.sendTransaction({ to, value });   // throws ShieldBlockedError on BLOCK
 *
 * The guard is advisory by design: it surfaces the evidence and refuses, but
 * the caller can lower `refuseAt` to 'BLOCK' only, raise it to 'CAUTION', or
 * read `error.report` and decide for itself. A Shield that is unreachable does
 * NOT silently allow the transaction unless `allowOnShieldFailure` is set,
 * because a safety check that fails open is not a safety check.
 */
import { formatEther } from 'viem';
import { accountFromKey, requirementPriceUsd, signPaymentHeader, type PayableRequirements } from '../shield/x402pay.js';
import type { CheckReport, ShieldVerdict } from '../shield/types.js';

export interface GuardOptions {
  /** Where Shield lives. Default https://truvian.xyz */
  shieldUrl?: string;
  /**
   * Refuse at this verdict or worse. 'BLOCK' (default) refuses only outright
   * blocks; 'CAUTION' also refuses anything that is not SAFE.
   */
  refuseAt?: 'BLOCK' | 'CAUTION';
  /** Private key used to pay Shield when the free allowance is used. */
  payerKey?: string;
  /** Protocol name to include, so the liquidity check runs. */
  protocol?: string;
  /**
   * A prior onchain transaction involving this counterparty, used as
   * evidence. Supply it when your agent tracks counterparty history: it turns
   * on the COUNTERPARTY check, and it is what lets a transfer above the
   * $100,000 line pass on verified evidence instead of failing outright.
   */
  txHash?: string;
  /** Called with every report, blocked or not - wire this to your logs. */
  onReport?: (report: CheckReport) => void;
  /** Allow the transaction when Shield itself cannot be reached. Default false. */
  allowOnShieldFailure?: boolean;
  /** Milliseconds to wait for a full report. Default 30000. */
  timeoutMs?: number;
}

/** Thrown instead of signing, when Shield says the transaction is unsafe. */
export class ShieldBlockedError extends Error {
  readonly report: CheckReport;
  constructor(report: CheckReport) {
    const reasons = report.reasons.length ? ` - ${report.reasons.join('; ')}` : '';
    super(`Truvian Shield returned ${report.verdict} (score ${report.score})${reasons}`);
    this.name = 'ShieldBlockedError';
    this.report = report;
  }
}

/** Thrown when Shield could not be consulted and failing open was not allowed. */
export class ShieldUnavailableError extends Error {
  constructor(reason: string) {
    super(`Truvian Shield could not be reached (${reason}); refusing to sign. Set allowOnShieldFailure to override.`);
    this.name = 'ShieldUnavailableError';
  }
}

const CHAIN_NAME_BY_ID: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  84532: 'base-sepolia',
};

const VERDICT_RANK: Record<ShieldVerdict, number> = { SAFE: 2, CAUTION: 1, BLOCK: 0 };

interface CheckBody {
  chain?: string;
  to?: string;
  valueEth?: number;
  protocol?: string;
  txHash?: string;
}

/**
 * Run one Shield check, paying if Shield asks for payment.
 * Never returns a partial report: either a CheckReport or it throws.
 */
export async function checkWithShield(body: CheckBody, options: GuardOptions = {}): Promise<CheckReport> {
  const base = (options.shieldUrl ?? 'https://truvian.xyz').replace(/\/+$/, '');
  const timeout = options.timeoutMs ?? 30_000;
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  const post = (): Promise<Response> =>
    fetch(`${base}/api/check`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeout) });

  let res = await post();

  if (res.status === 402) {
    const challenge = (await res.json().catch(() => null)) as { error?: string; accepts?: PayableRequirements[] } | null;
    const requirements = challenge?.accepts?.[0];
    if (!requirements) throw new Error(challenge?.error ?? 'Shield asked for payment but quoted no price');
    if (!options.payerKey) {
      throw new Error(
        `Shield requires payment ($${requirementPriceUsd(requirements).toFixed(2)} USDC on ${requirements.network}); ` +
          'pass payerKey to let the guard pay for checks.',
      );
    }
    headers['X-PAYMENT'] = await signPaymentHeader(accountFromKey(options.payerKey), requirements);
    res = await post();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Shield replied ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const report = (await res.json()) as CheckReport;
  if (!report || typeof report.verdict !== 'string') throw new Error('Shield returned an unrecognisable report');
  return report;
}

/** viem's sendTransaction argument, narrowed to what the guard reads. */
interface TxRequest {
  to?: string | null;
  value?: bigint;
  chain?: { id?: number } | null;
  [key: string]: unknown;
}

interface WalletLike {
  chain?: { id?: number } | null;
  /** Method shorthand on purpose: bivariant, so viem's stricter signature fits. */
  sendTransaction(args: TxRequest): Promise<`0x${string}`>;
  [key: string]: unknown;
}

/**
 * Wrap a viem wallet client so sendTransaction is checked by Shield first.
 * Returns the same client shape, so it is a drop-in replacement.
 */
export function guard<T extends WalletLike>(client: T, options: GuardOptions = {}): T {
  const refuseAt = options.refuseAt ?? 'BLOCK';
  const threshold = VERDICT_RANK[refuseAt];

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'sendTransaction') return Reflect.get(target, property, receiver);

      return async (request: TxRequest) => {
        const chainId = request.chain?.id ?? target.chain?.id;
        const body: CheckBody = {};
        const chainName = chainId !== undefined ? CHAIN_NAME_BY_ID[chainId] : undefined;
        if (chainName) body.chain = chainName;
        if (typeof request.to === 'string') body.to = request.to;
        if (typeof request.value === 'bigint') body.valueEth = Number(formatEther(request.value));
        if (options.protocol !== undefined) body.protocol = options.protocol;
        if (options.txHash !== undefined) body.txHash = options.txHash;

        let report: CheckReport;
        try {
          report = await checkWithShield(body, options);
        } catch (err) {
          if (options.allowOnShieldFailure) {
            return (target.sendTransaction as (args: TxRequest) => Promise<`0x${string}`>)(request);
          }
          throw new ShieldUnavailableError(err instanceof Error ? err.message : String(err));
        }

        options.onReport?.(report);
        // refuseAt names the worst verdict that is still refused, so the
        // comparison is inclusive: refuseAt 'BLOCK' refuses BLOCK, and
        // refuseAt 'CAUTION' refuses CAUTION and BLOCK.
        if (VERDICT_RANK[report.verdict] <= threshold) throw new ShieldBlockedError(report);

        return (target.sendTransaction as (args: TxRequest) => Promise<`0x${string}`>)(request);
      };
    },
  });
}
