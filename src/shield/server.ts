/**
 * Truvian Shield API server (Track 3).
 *
 * Execution-safety checkpoint: before an agent signs a transaction it POSTs
 * the proposed action here; Shield fans out to LIVE Telegraph miners (never
 * mocked data) and returns a go/no-go CheckReport with per-check evidence.
 *
 * Routes:
 *   POST /api/check            {chain?, to?, valueEth?, txHash?, protocol?} -> CheckReport
 *   GET  /api/verify/:txHash   single ONCHAIN_TX_LOOKUP-based verification report
 *   GET  /healthz              {ok:true}
 *   GET  /api/stats            {checksRun, telegraphRequests, byIntent}
 *   GET  /, /*                 static dashboard from src/shield/public/
 */
// Load /opt/truvian/.env (or the repo's .env) so pm2 gets TELEGRAPH_PAYER_KEY
// and SHIELD_* without duplicating secrets in the ecosystem file.
import 'dotenv/config';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askIntent } from './telegraph.js';
import {
  assessTxVerification,
  buildCheckReport,
  normalizeCheckRequest,
  ShieldInputError,
  type SignalOutcome,
} from './verdict.js';
import { createLimiter, type Limiter, type LimiterState } from './limits.js';
import { createReceiptStore } from './receipts.js';
import { payerAddress, payerUsdcBalance } from './payer.js';
import {
  buildRequirements,
  challengeBody,
  encodeSettlement,
  paymentsEnabled,
  payToAddress,
  priceUsd,
  readPaymentHeader,
  settlePayment,
  verifyPayment,
  type PaymentPayload,
  type PaymentRequirements,
} from './x402server.js';
import type { CheckReport, CheckRequest, ShieldIntent, ShieldStats, ShieldTransport } from './types.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const STATS_FILE = process.env.SHIELD_STATS_FILE ?? resolve(process.cwd(), '.shield-stats.json');
const RECEIPTS_FILE = process.env.SHIELD_RECEIPTS_FILE ?? resolve(process.cwd(), '.shield-receipts.json');

/** Mirror of telegraph.ts transport selection, used only to label errored checks. */
function defaultTransport(): ShieldTransport {
  const t = process.env.SHIELD_TRANSPORT;
  if (t === 'direct') return 'direct';
  if (t === 'x402') return 'x402';
  return process.env.TELEGRAPH_PAYER_KEY ? 'x402' : 'direct';
}

// ---------- stats (best-effort persistence) ----------

/** What actually lands on disk: public counters plus today's spend budget. */
interface PersistedStats extends ShieldStats {
  limits?: LimiterState;
}

function emptyStats(): ShieldStats {
  return {
    checksRun: 0,
    telegraphRequests: 0,
    byIntent: { GAS_PRICE: 0, ONCHAIN_TX_LOOKUP: 0, CRYPTO_PRICE: 0, TVL_LOOKUP: 0 },
    paidUsd: 0,
    earnedUsd: 0,
    paidChecks: 0,
  };
}

function loadStats(): { stats: ShieldStats; limits?: LimiterState } {
  const stats = emptyStats();
  try {
    const parsed = JSON.parse(readFileSync(STATS_FILE, 'utf8')) as Partial<PersistedStats>;
    stats.checksRun = Number(parsed.checksRun) || 0;
    stats.telegraphRequests = Number(parsed.telegraphRequests) || 0;
    stats.paidUsd = Number(parsed.paidUsd) || 0;
    stats.earnedUsd = Number(parsed.earnedUsd) || 0;
    stats.paidChecks = Number(parsed.paidChecks) || 0;
    const by = parsed.byIntent;
    if (typeof by === 'object' && by !== null) {
      for (const key of Object.keys(stats.byIntent) as ShieldIntent[]) {
        stats.byIntent[key] = Number((by as Record<string, unknown>)[key]) || 0;
      }
    }
    return parsed.limits ? { stats, limits: parsed.limits } : { stats };
  } catch {
    // first run or unreadable file - start from zeros
  }
  return { stats };
}

let persistChain: Promise<void> = Promise.resolve();
function persistStats(stats: ShieldStats, limits: LimiterState): void {
  const snapshot = JSON.stringify({ ...stats, limits }, null, 2);
  // fire-and-forget, serialized so concurrent checks never interleave writes
  persistChain = persistChain.then(() => writeFile(STATS_FILE, snapshot, 'utf8')).catch(() => {});
}

/** Real USD a finished report paid to miners (x402 settlements only). */
function reportSpendUsd(report: CheckReport): number {
  let total = 0;
  for (const check of report.checks) {
    if (check.transport === 'x402' && typeof check.costUsd === 'number' && Number.isFinite(check.costUsd)) {
      total += check.costUsd;
    }
  }
  return total;
}

// ---------- tiny safe static handler (no @fastify/static in package.json) ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** Resolve a request path inside PUBLIC_DIR; null on any traversal attempt. */
function resolvePublicPath(relRaw: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(relRaw);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const abs = normalize(join(PUBLIC_DIR, rel));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) return null;
  return abs;
}

/** Shown at / until the dashboard's index.html lands in src/shield/public/. */
const FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truvian Shield</title>
<style>
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:640px;padding:2.5rem 1.5rem}h1{font-size:1.5rem;margin:0 0 .5rem}
p{color:#9a9a9a;line-height:1.6;font-size:.9rem}
code{background:#161616;border:1px solid #262626;border-radius:4px;padding:.15rem .4rem;font-size:.85rem}
ul{list-style:none;padding:0}li{margin:.6rem 0}
</style></head><body><main>
<h1>Truvian Shield</h1>
<p>Execution-safety checkpoint over live Telegraph miners. The dashboard has not been deployed to <code>src/shield/public/</code> yet - the API is live:</p>
<ul>
<li><code>POST /api/check</code> - body <code>{chain?, to?, valueEth?, txHash?, protocol?}</code> &rarr; go/no-go CheckReport</li>
<li><code>GET /api/verify/:txHash</code> - single-transaction verification report</li>
<li><code>GET /api/stats</code> - live Telegraph request counters</li>
<li><code>GET /healthz</code> - liveness</li>
</ul>
</main></body></html>`;

// ---------- server ----------

export function buildShieldServer() {
  // Behind nginx the socket address is always 127.0.0.1, so per-IP limits need
  // the forwarded address. Set SHIELD_TRUST_PROXY=0 when exposing Shield
  // directly, where a client could otherwise forge the header.
  const app = Fastify({ logger: true, trustProxy: process.env.SHIELD_TRUST_PROXY !== '0' });
  const loaded = loadStats();
  const stats = loaded.stats;
  const limiter: Limiter = createLimiter();
  limiter.hydrate(loaded.limits);
  const receipts = createReceiptStore(RECEIPTS_FILE);

  const save = (): void => persistStats(stats, limiter.serialize());

  /** Public origin used in the x402 `resource` field. */
  const resourceUrl = (req: { protocol: string; hostname: string; url: string }): string => {
    const base = (process.env.SHIELD_PUBLIC_URL ?? `${req.protocol}://${req.hostname}`).replace(/\/+$/, '');
    return `${base}${req.url.split('?')[0]}`;
  };

  interface Admission {
    admitted: boolean;
    /** Present when the caller paid: settle this after the work succeeds. */
    paid?: { payment: PaymentPayload; requirements: PaymentRequirements };
  }

  /**
   * Decide whether a paid endpoint may run. Two ways in:
   *   1. a valid x402 payment - bypasses the free caps, because the payment
   *      more than covers the miner queries it triggers;
   *   2. the free daily allowance - rate limited per IP and globally.
   * When the free allowance is gone and payments are on, the answer is 402
   * with a price rather than a flat refusal, so a caller can simply pay.
   * Returns admitted:false only after a response has been sent.
   */
  const admit = async (
    req: { ip: string; headers: Record<string, unknown>; protocol: string; hostname: string; url: string },
    reply: { status: (c: number) => { send: (b: unknown) => unknown }; header: (k: string, v: string) => unknown },
  ): Promise<Admission> => {
    const payTo = payToAddress(payerAddress());
    const charging = paymentsEnabled(payerAddress()) && payTo !== null;
    const requirements = charging && payTo ? buildRequirements(resourceUrl(req), payTo) : null;

    if (requirements) {
      const payment = readPaymentHeader(req.headers);
      if (payment) {
        const verdict = await verifyPayment(payment, requirements);
        if (verdict.valid) return { admitted: true, paid: { payment, requirements } };
        reply.status(402).send(challengeBody(requirements, `payment rejected: ${verdict.reason ?? 'unknown reason'}`));
        return { admitted: false };
      }
    }

    const gate = limiter.consume(req.ip);
    if (gate.allowed) return { admitted: true };

    if (gate.retryAfterSec !== undefined) reply.header('Retry-After', String(gate.retryAfterSec));
    if (requirements) {
      // Out of free checks, but payment is open: quote the price.
      reply.status(402).send({
        ...challengeBody(requirements, `${gate.reason ?? 'free allowance used'} Pay $${priceUsd().toFixed(2)} in USDC to run this check now.`),
        freeTier: { scope: gate.scope, retryAfterSec: gate.retryAfterSec, checksLeftToday: gate.remainingForIp },
      });
      return { admitted: false };
    }
    reply.status(429).send({
      error: 'RATE_LIMITED',
      scope: gate.scope,
      message: gate.reason,
      retryAfterSec: gate.retryAfterSec,
      checksLeftToday: gate.remainingForIp,
    });
    return { admitted: false };
  };

  /** Collect a verified payment after the work succeeded. Never throws. */
  const collect = async (
    admission: Admission,
    reply: { header: (k: string, v: string) => unknown },
  ): Promise<void> => {
    if (!admission.paid) return;
    const settlement = await settlePayment(admission.paid.payment, admission.paid.requirements);
    reply.header('X-PAYMENT-RESPONSE', encodeSettlement(settlement));
    if (!settlement.success) {
      app.log.warn({ reason: settlement.reason }, 'x402 settlement failed after work was delivered');
      return;
    }
    const collected = Number(admission.paid.requirements.maxAmountRequired) / 1_000_000;
    stats.earnedUsd = Number((stats.earnedUsd + collected).toFixed(6));
    stats.paidChecks += 1;
  };

  /** Refresh the payer balance in the background; never blocks a request. */
  const refreshBalance = (): void => {
    void payerUsdcBalance()
      .then((balance) => limiter.setBalanceUsdc(balance))
      .catch(() => limiter.setBalanceUsdc(null));
  };
  refreshBalance();

  /**
   * One live Telegraph query. Counts stats up-front (a launched request is a
   * real Telegraph request whether or not it succeeds) and never rejects -
   * failures become ok:false outcomes the verdict engine renders as evidence.
   */
  const ask = async (
    intent: ShieldIntent,
    params: Record<string, string>,
    onSettled?: (outcome: SignalOutcome) => void,
  ): Promise<SignalOutcome> => {
    stats.telegraphRequests++;
    stats.byIntent[intent]++;
    const started = Date.now();
    let outcome: SignalOutcome;
    try {
      outcome = { ok: true, result: await askIntent(intent, params) };
    } catch (err) {
      outcome = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        transport: defaultTransport(),
        latencyMs: Date.now() - started,
      };
    }
    if (onSettled) onSettled(outcome);
    return outcome;
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/stats', async (req) => {
    refreshBalance(); // cached 60s inside payerUsdcBalance
    const budget = limiter.snapshot();
    const you = limiter.peek(req.ip);
    const payTo = payToAddress(payerAddress());
    return {
      ...stats,
      budget,
      payer: payerAddress(),
      pricing: paymentsEnabled(payerAddress()) && payTo ? { priceUsd: priceUsd(), payTo, asset: 'USDC', network: 'base-sepolia' } : null,
      you: { checksLeftToday: you.remainingForIp, perDay: budget.perIpDailyCap },
    };
  });

  app.post('/api/check', async (req, reply) => {
    // Brakes BEFORE any miner is paid: one script must not be able to drain
    // the payer wallet or take the service down. A caller who pays skips them.
    const admission = await admit(req, reply);
    if (!admission.admitted) return reply;

    let parsed: CheckRequest;
    try {
      parsed = normalizeCheckRequest(req.body ?? {});
    } catch (err) {
      // Nothing ran, so nothing is charged: give the free allowance back and
      // never settle the payment.
      if (!admission.paid) limiter.refund(req.ip);
      if (err instanceof ShieldInputError) {
        return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      }
      throw err;
    }

    // A streaming caller watches each paid miner answer land instead of
    // staring at a spinner for ten seconds. NDJSON, because unlike EventSource
    // it works over POST and so keeps the x402 payment header flow.
    const q = (req.query ?? {}) as Record<string, unknown>;
    const streaming = q.stream === '1' || String(req.headers.accept ?? '').includes('application/x-ndjson');
    let emit: (event: Record<string, unknown>) => void = () => {};
    if (streaming) {
      reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-store');
      reply.raw.setHeader('x-accel-buffering', 'no'); // nginx must not buffer this
      reply.raw.flushHeaders();
      emit = (event) => {
        try {
          reply.raw.write(`${JSON.stringify(event)}\n`);
        } catch {
          // client hung up mid-check; the work still finishes and is recorded
        }
      };
    }

    const chain = parsed.chain ?? 'base';
    // Fan out only the intents this request can use - every one is a paid
    // (or at minimum live) Telegraph query, so unused signals are not burned.
    const planned: Array<{ name: string; intent: ShieldIntent }> = [{ name: 'FEE', intent: 'GAS_PRICE' }];
    if (parsed.txHash !== undefined) planned.push({ name: 'COUNTERPARTY', intent: 'ONCHAIN_TX_LOOKUP' });
    if (parsed.valueEth !== undefined) planned.push({ name: 'VALUE', intent: 'CRYPTO_PRICE' });
    if (parsed.protocol !== undefined) planned.push({ name: 'LIQUIDITY', intent: 'TVL_LOOKUP' });
    emit({ type: 'start', checks: planned, startedAt: new Date().toISOString() });

    /** Announce a miner answer the moment it lands, before grading. */
    const announce = (name: string, intent: ShieldIntent) => (outcome: SignalOutcome) => {
      emit({
        type: 'signal',
        name,
        intent,
        ok: outcome.ok,
        minerName: outcome.ok ? outcome.result.minerName : undefined,
        minerId: outcome.ok ? outcome.result.minerId : undefined,
        latencyMs: outcome.ok ? outcome.result.latencyMs : outcome.latencyMs,
        costUsd: outcome.ok ? outcome.result.costUsd : undefined,
        transport: outcome.ok ? outcome.result.transport : outcome.transport,
        signalHash: outcome.ok ? outcome.result.signalHash : undefined,
        answer: outcome.ok ? outcome.result.answer : outcome.reason,
      });
    };

    const jobs: Array<Promise<SignalOutcome> | undefined> = [
      ask('GAS_PRICE', { chain }, announce('FEE', 'GAS_PRICE')),
      parsed.txHash !== undefined
        ? ask('ONCHAIN_TX_LOOKUP', { chain, hash: parsed.txHash }, announce('COUNTERPARTY', 'ONCHAIN_TX_LOOKUP'))
        : undefined,
      parsed.valueEth !== undefined ? ask('CRYPTO_PRICE', { symbol: 'ETH' }, announce('VALUE', 'CRYPTO_PRICE')) : undefined,
      parsed.protocol !== undefined ? ask('TVL_LOOKUP', { protocol: parsed.protocol }, announce('LIQUIDITY', 'TVL_LOOKUP')) : undefined,
    ];
    const settled = await Promise.allSettled(jobs.map((j) => j ?? Promise.resolve(undefined)));
    const outcome = (i: number): SignalOutcome | undefined => {
      const s = settled[i];
      if (!s) return undefined;
      if (s.status === 'fulfilled') return s.value;
      // ask() never rejects, but allSettled keeps this airtight regardless
      return { ok: false, reason: String(s.reason), transport: defaultTransport(), latencyMs: 0 };
    };

    const report = buildCheckReport(parsed, {
      gas: outcome(0),
      tx: outcome(1),
      price: outcome(2),
      tvl: outcome(3),
    });
    const spent = reportSpendUsd(report);
    stats.checksRun++;
    stats.paidUsd = Number((stats.paidUsd + spent).toFixed(6));
    limiter.recordSpend(spent);
    const receipt = receipts.add(parsed, report);

    if (streaming) {
      emit({ type: 'report', report, id: receipt.id, url: `/app?r=${receipt.id}` });
      if (admission.paid) {
        const settlement = await settlePayment(admission.paid.payment, admission.paid.requirements);
        if (settlement.success) {
          stats.earnedUsd = Number((stats.earnedUsd + Number(admission.paid.requirements.maxAmountRequired) / 1_000_000).toFixed(6));
          stats.paidChecks += 1;
        } else {
          app.log.warn({ reason: settlement.reason }, 'x402 settlement failed after work was delivered');
        }
        emit({ type: 'payment', success: settlement.success, transaction: settlement.transaction ?? null, reason: settlement.reason });
      }
      emit({ type: 'done', checksLeftToday: limiter.peek(req.ip).remainingForIp });
      save();
      reply.raw.end();
      return reply;
    }

    await collect(admission, reply);
    save();
    reply.header('X-Shield-Checks-Left', String(limiter.peek(req.ip).remainingForIp));
    reply.header('X-Shield-Receipt', receipt.id);
    return report;
  });

  /** Public feed of recent checks - the "no mocked data" claim, clickable. */
  app.get('/api/recent', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = Number(q.limit);
    return { checks: receipts.recent(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12), total: receipts.size() };
  });

  /** A single stored report, by permalink id. */
  app.get('/api/report/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = /^[0-9a-f]{10}$/.test(id) ? receipts.get(id) : undefined;
    if (!entry) return reply.status(404).send({ error: 'NOT_FOUND', message: 'no stored report with that id' });
    return entry;
  });

  /**
   * Resolve a Telegraph signal hash on the node, so a receipt can be verified
   * without leaving the page or trusting Truvian. Free: no miner is queried.
   */
  app.get('/api/signal/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!/^0x?[0-9a-fA-F]{16,128}$/.test(hash)) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: 'that does not look like a signal hash' });
    }
    const node = (process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com').replace(/\/+$/, '');
    const url = `${node}/engine/v1/signal/${hash}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body) {
        return { found: false, hash, url, status: res.status, message: 'the node did not recognise this signal hash' };
      }
      const record = (body.signal ?? body) as Record<string, unknown>;
      const pick = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === 'string' && value.trim() !== '') return value;
        }
        return undefined;
      };
      return {
        found: true,
        hash,
        url,
        minerSlug: pick('miner_slug', 'minerSlug', 'miner_name', 'minerName'),
        minerId: pick('miner_id', 'minerId'),
        recordedAt: pick('created_at', 'createdAt', 'timestamp', 'recorded_at'),
        intent: pick('intent_id', 'intent', 'intentId'),
        raw: body,
      };
    } catch (err) {
      return reply.status(502).send({
        error: 'NODE_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
        hash,
        url,
      });
    }
  });

  app.get('/api/verify/:txHash', async (req, reply) => {
    const { txHash } = req.params as { txHash: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: 'txHash must be a 32-byte 0x-hex string' });
    }
    // One paid ONCHAIN_TX_LOOKUP, so it draws on the same allowance as a check.
    const admission = await admit(req, reply);
    if (!admission.admitted) return reply;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const chain = typeof q.chain === 'string' && q.chain.trim() !== '' ? q.chain.trim().toLowerCase() : 'base';
    const result = await ask('ONCHAIN_TX_LOOKUP', { chain, hash: txHash.toLowerCase() });
    if (result.ok && result.result.transport === 'x402' && typeof result.result.costUsd === 'number') {
      stats.paidUsd = Number((stats.paidUsd + result.result.costUsd).toFixed(6));
      limiter.recordSpend(result.result.costUsd);
    }
    await collect(admission, reply);
    save();
    return assessTxVerification(txHash, result);
  });

  // --- static dashboard ---

  const sendPublicFile = async (reply: { type: (t: string) => unknown; send: (b: Buffer) => unknown }, relPath: string): Promise<boolean> => {
    const abs = resolvePublicPath(relPath);
    if (!abs) return false;
    try {
      let target = abs;
      let data: Buffer;
      try {
        data = await readFile(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
          target = join(abs, 'index.html');
          data = await readFile(target);
        } else {
          throw err;
        }
      }
      reply.type(MIME[extname(target).toLowerCase()] ?? 'application/octet-stream');
      reply.send(data);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/', async (_req, reply) => {
    if (await sendPublicFile(reply, 'index.html')) return reply;
    return reply.type('text/html; charset=utf-8').send(FALLBACK_HTML);
  });

  // The landing page's "Launch App" target: the check tool itself.
  app.get('/app', async (_req, reply) => {
    if (await sendPublicFile(reply, 'app.html')) return reply;
    return reply.type('text/html; charset=utf-8').send(FALLBACK_HTML);
  });

  app.get('/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    if (rel !== '' && (await sendPublicFile(reply, rel))) return reply;
    return reply.status(404).send({ error: 'NOT_FOUND', message: 'no such route or file' });
  });

  return app;
}

// Run directly (npx tsx src/shield/server.ts)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const app = buildShieldServer();
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
