/**
 * Rate limiting and spend control for Truvian Shield.
 *
 * Every /api/check runs up to four PAID Telegraph queries ($0.01 each), so an
 * open endpoint is a wallet-drain vector: one script can empty the payer wallet
 * and take the service down. Three independent brakes, all enforced before any
 * miner is called:
 *
 *   1. per-IP burst    - a few checks per minute, so one client cannot spike
 *   2. per-IP per day  - the free allowance a visitor gets (UTC day)
 *   3. global per day  - a cap on checks AND on real USD spent across everyone
 *
 * Spend is recorded from the actual costUsd the transport reports (real x402
 * settlements), not from an estimate, so the daily USD cap tracks reality. The
 * cheapest brake to hit wins and the caller is told which one and when it lifts.
 *
 * State is in-memory with a UTC-day rollover; the server persists the daily
 * counters alongside its stats so a restart does not hand out a fresh budget.
 * Per-IP buckets are deliberately NOT persisted (they expire within a day and
 * would bloat the file).
 */

/** Worst case cost of one full report: four intents at $0.01 each. */
export const MAX_COST_PER_CHECK_USD = 0.04;

export interface LimiterOptions {
  /** Free checks one IP may run per UTC day. */
  perIpPerDay?: number;
  /** Checks one IP may run in any 60s window. */
  perIpPerMinute?: number;
  /** Checks everyone may run per UTC day. */
  globalPerDay?: number;
  /** Real USD Shield may spend on miners per UTC day. */
  globalSpendUsdPerDay?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export type LimitScope = 'ip-burst' | 'ip-day' | 'global-day' | 'global-spend';

export interface LimitDecision {
  allowed: boolean;
  /** Which brake stopped it (absent when allowed). */
  scope?: LimitScope;
  /** Human sentence for the API response (absent when allowed). */
  reason?: string;
  /** Seconds until this caller may retry (absent when allowed). */
  retryAfterSec?: number;
  /** Free checks this IP has left today, after this decision. */
  remainingForIp: number;
  /** Checks everyone has left today, after this decision. */
  remainingGlobal: number;
}

/** Numbers the dashboard shows in its stats strip. */
export interface BudgetSnapshot {
  checksToday: number;
  dailyCheckCap: number;
  perIpDailyCap: number;
  spentTodayUsd: number;
  dailySpendCapUsd: number;
  /** Payer USDC balance, null while unknown (not yet read, or RPC down). */
  balanceUsdc: number | null;
  /** How many more full checks the wallet can fund, null when balance unknown. */
  checksFunded: number | null;
  /** Whichever of the two remaining budgets is smaller, in checks. */
  checksRemainingToday: number;
}

/** Daily counters worth persisting across a restart. */
export interface LimiterState {
  day: string;
  checksToday: number;
  spentTodayUsd: number;
}

interface IpBucket {
  day: string;
  dayCount: number;
  /** Timestamps (ms) of checks inside the rolling minute. */
  recent: number[];
}

const MINUTE_MS = 60_000;
/** Drop IP buckets untouched for this long, so memory cannot grow unbounded. */
const IP_BUCKET_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TRACKED_IPS = 20_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** UTC day key, e.g. "2026-09-05". */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Seconds from `at` until the next UTC midnight. */
function secondsUntilUtcMidnight(at: number): number {
  const next = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at) / 1000));
}

export interface Limiter {
  /** Record one check against every budget, or explain why it cannot run. */
  consume(ip: string): LimitDecision;
  /** Same brakes, without recording - for previews and health output. */
  peek(ip: string): LimitDecision;
  /** Give back an allowance when a check never ran (e.g. bad input). */
  refund(ip: string): void;
  /** Record real USD spent by a finished check. */
  recordSpend(usd: number): void;
  /** Publish the payer wallet balance (null when unknown). */
  setBalanceUsdc(balance: number | null): void;
  snapshot(): BudgetSnapshot;
  serialize(): LimiterState;
  hydrate(state: Partial<LimiterState> | null | undefined): void;
}

/**
 * Build a limiter. Options win over env vars, which win over the defaults:
 * SHIELD_FREE_CHECKS_PER_IP=5, SHIELD_BURST_PER_MIN=3,
 * SHIELD_DAILY_CHECK_CAP=300, SHIELD_DAILY_SPEND_USD=5.
 */
export function createLimiter(options: LimiterOptions = {}): Limiter {
  const now = options.now ?? (() => Date.now());
  const perIpPerDay = options.perIpPerDay ?? envInt('SHIELD_FREE_CHECKS_PER_IP', 5);
  const perIpPerMinute = options.perIpPerMinute ?? envInt('SHIELD_BURST_PER_MIN', 3);
  const globalPerDay = options.globalPerDay ?? envInt('SHIELD_DAILY_CHECK_CAP', 300);
  const globalSpendUsdPerDay = options.globalSpendUsdPerDay ?? envNum('SHIELD_DAILY_SPEND_USD', 5);

  const ips = new Map<string, IpBucket>();
  let day = utcDay(now());
  let checksToday = 0;
  let spentTodayUsd = 0;
  let balanceUsdc: number | null = null;

  function rollDay(at: number): void {
    const today = utcDay(at);
    if (today === day) return;
    day = today;
    checksToday = 0;
    spentTodayUsd = 0;
    ips.clear();
  }

  /** Drop stale buckets; called only when the map is large. */
  function sweep(at: number): void {
    if (ips.size < MAX_TRACKED_IPS) return;
    for (const [key, bucket] of ips) {
      const last = bucket.recent[bucket.recent.length - 1] ?? 0;
      if (bucket.day !== day || at - last > IP_BUCKET_TTL_MS) ips.delete(key);
    }
  }

  function bucketFor(ip: string, at: number): IpBucket {
    let bucket = ips.get(ip);
    if (!bucket || bucket.day !== day) {
      bucket = { day, dayCount: 0, recent: [] };
      ips.set(ip, bucket);
    }
    bucket.recent = bucket.recent.filter((t) => at - t < MINUTE_MS);
    return bucket;
  }

  function remainingIp(bucket: IpBucket): number {
    return Math.max(0, perIpPerDay - bucket.dayCount);
  }

  function remainingGlobalChecks(): number {
    const byCount = Math.max(0, globalPerDay - checksToday);
    const bySpend = Math.max(0, Math.floor((globalSpendUsdPerDay - spentTodayUsd) / MAX_COST_PER_CHECK_USD));
    return Math.min(byCount, bySpend);
  }

  function decide(ip: string, record: boolean): LimitDecision {
    const at = now();
    rollDay(at);
    sweep(at);
    const bucket = bucketFor(ip, at);
    const untilMidnight = secondsUntilUtcMidnight(at);

    // Cheapest brake first, so the caller learns the shortest wait.
    if (bucket.recent.length >= perIpPerMinute) {
      const oldest = bucket.recent[0] ?? at;
      return {
        allowed: false,
        scope: 'ip-burst',
        reason: `too many checks in a row: at most ${perIpPerMinute} per minute from one address.`,
        retryAfterSec: Math.max(1, Math.ceil((oldest + MINUTE_MS - at) / 1000)),
        remainingForIp: remainingIp(bucket),
        remainingGlobal: remainingGlobalChecks(),
      };
    }
    if (bucket.dayCount >= perIpPerDay) {
      return {
        allowed: false,
        scope: 'ip-day',
        reason: `daily free allowance used: ${perIpPerDay} checks per address per day. Each check pays live miners in USDC, so the allowance resets at 00:00 UTC.`,
        retryAfterSec: untilMidnight,
        remainingForIp: 0,
        remainingGlobal: remainingGlobalChecks(),
      };
    }
    if (spentTodayUsd + MAX_COST_PER_CHECK_USD > globalSpendUsdPerDay) {
      return {
        allowed: false,
        scope: 'global-spend',
        reason: `Shield has reached its daily miner-payment budget of $${globalSpendUsdPerDay.toFixed(2)}. It resets at 00:00 UTC.`,
        retryAfterSec: untilMidnight,
        remainingForIp: remainingIp(bucket),
        remainingGlobal: 0,
      };
    }
    if (checksToday >= globalPerDay) {
      return {
        allowed: false,
        scope: 'global-day',
        reason: `Shield has reached its daily cap of ${globalPerDay} checks. It resets at 00:00 UTC.`,
        retryAfterSec: untilMidnight,
        remainingForIp: remainingIp(bucket),
        remainingGlobal: 0,
      };
    }

    if (record) {
      bucket.dayCount += 1;
      bucket.recent.push(at);
      checksToday += 1;
    }
    return { allowed: true, remainingForIp: remainingIp(bucket), remainingGlobal: remainingGlobalChecks() };
  }

  return {
    consume: (ip) => decide(ip, true),
    peek: (ip) => decide(ip, false),
    refund(ip) {
      const at = now();
      rollDay(at);
      const bucket = ips.get(ip);
      if (bucket && bucket.day === day && bucket.dayCount > 0) {
        bucket.dayCount -= 1;
        bucket.recent.pop();
      }
      if (checksToday > 0) checksToday -= 1;
    },
    recordSpend(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      rollDay(now());
      spentTodayUsd += usd;
    },
    setBalanceUsdc(balance) {
      balanceUsdc = balance !== null && Number.isFinite(balance) && balance >= 0 ? balance : null;
    },
    snapshot() {
      rollDay(now());
      return {
        checksToday,
        dailyCheckCap: globalPerDay,
        perIpDailyCap: perIpPerDay,
        spentTodayUsd: Number(spentTodayUsd.toFixed(6)),
        dailySpendCapUsd: globalSpendUsdPerDay,
        balanceUsdc,
        checksFunded: balanceUsdc === null ? null : Math.floor(balanceUsdc / MAX_COST_PER_CHECK_USD),
        checksRemainingToday: remainingGlobalChecks(),
      };
    },
    serialize: () => ({ day, checksToday, spentTodayUsd }),
    hydrate(state) {
      if (!state || typeof state.day !== 'string') return;
      // Yesterday's counters are not carried into today.
      if (state.day !== utcDay(now())) return;
      day = state.day;
      checksToday = Number.isFinite(state.checksToday) ? Math.max(0, Math.floor(state.checksToday as number)) : 0;
      spentTodayUsd = Number.isFinite(state.spentTodayUsd) ? Math.max(0, state.spentTodayUsd as number) : 0;
    },
  };
}
