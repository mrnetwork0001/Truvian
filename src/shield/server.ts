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
import type { CheckRequest, ShieldIntent, ShieldStats, ShieldTransport } from './types.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const STATS_FILE = process.env.SHIELD_STATS_FILE ?? resolve(process.cwd(), '.shield-stats.json');

/** Mirror of telegraph.ts transport selection, used only to label errored checks. */
function defaultTransport(): ShieldTransport {
  const t = process.env.SHIELD_TRANSPORT;
  if (t === 'direct') return 'direct';
  if (t === 'x402') return 'x402';
  return process.env.TELEGRAPH_PAYER_KEY ? 'x402' : 'direct';
}

// ---------- stats (best-effort persistence) ----------

function emptyStats(): ShieldStats {
  return {
    checksRun: 0,
    telegraphRequests: 0,
    byIntent: { GAS_PRICE: 0, ONCHAIN_TX_LOOKUP: 0, CRYPTO_PRICE: 0, TVL_LOOKUP: 0 },
  };
}

function loadStats(): ShieldStats {
  const stats = emptyStats();
  try {
    const parsed = JSON.parse(readFileSync(STATS_FILE, 'utf8')) as Partial<ShieldStats>;
    stats.checksRun = Number(parsed.checksRun) || 0;
    stats.telegraphRequests = Number(parsed.telegraphRequests) || 0;
    const by = parsed.byIntent;
    if (typeof by === 'object' && by !== null) {
      for (const key of Object.keys(stats.byIntent) as ShieldIntent[]) {
        stats.byIntent[key] = Number((by as Record<string, unknown>)[key]) || 0;
      }
    }
  } catch {
    // first run or unreadable file — start from zeros
  }
  return stats;
}

let persistChain: Promise<void> = Promise.resolve();
function persistStats(stats: ShieldStats): void {
  const snapshot = JSON.stringify(stats, null, 2);
  // fire-and-forget, serialized so concurrent checks never interleave writes
  persistChain = persistChain.then(() => writeFile(STATS_FILE, snapshot, 'utf8')).catch(() => {});
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
<p>Execution-safety checkpoint over live Telegraph miners. The dashboard has not been deployed to <code>src/shield/public/</code> yet — the API is live:</p>
<ul>
<li><code>POST /api/check</code> — body <code>{chain?, to?, valueEth?, txHash?, protocol?}</code> &rarr; go/no-go CheckReport</li>
<li><code>GET /api/verify/:txHash</code> — single-transaction verification report</li>
<li><code>GET /api/stats</code> — live Telegraph request counters</li>
<li><code>GET /healthz</code> — liveness</li>
</ul>
</main></body></html>`;

// ---------- server ----------

export function buildShieldServer() {
  const app = Fastify({ logger: true });
  const stats = loadStats();

  /**
   * One live Telegraph query. Counts stats up-front (a launched request is a
   * real Telegraph request whether or not it succeeds) and never rejects —
   * failures become ok:false outcomes the verdict engine renders as evidence.
   */
  const ask = async (intent: ShieldIntent, params: Record<string, string>): Promise<SignalOutcome> => {
    stats.telegraphRequests++;
    stats.byIntent[intent]++;
    const started = Date.now();
    try {
      return { ok: true, result: await askIntent(intent, params) };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        transport: defaultTransport(),
        latencyMs: Date.now() - started,
      };
    }
  };

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/stats', async () => stats);

  app.post('/api/check', async (req, reply) => {
    let parsed: CheckRequest;
    try {
      parsed = normalizeCheckRequest(req.body ?? {});
    } catch (err) {
      if (err instanceof ShieldInputError) {
        return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      }
      throw err;
    }

    const chain = parsed.chain ?? 'base';
    // Fan out only the intents this request can use — every one is a paid
    // (or at minimum live) Telegraph query, so unused signals are not burned.
    const jobs: Array<Promise<SignalOutcome> | undefined> = [
      ask('GAS_PRICE', { chain }),
      parsed.txHash !== undefined ? ask('ONCHAIN_TX_LOOKUP', { chain, hash: parsed.txHash }) : undefined,
      parsed.valueEth !== undefined ? ask('CRYPTO_PRICE', { symbol: 'ETH' }) : undefined,
      parsed.protocol !== undefined ? ask('TVL_LOOKUP', { protocol: parsed.protocol }) : undefined,
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
    stats.checksRun++;
    persistStats(stats);
    return report;
  });

  app.get('/api/verify/:txHash', async (req, reply) => {
    const { txHash } = req.params as { txHash: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: 'txHash must be a 32-byte 0x-hex string' });
    }
    const q = (req.query ?? {}) as Record<string, unknown>;
    const chain = typeof q.chain === 'string' && q.chain.trim() !== '' ? q.chain.trim().toLowerCase() : 'base';
    const result = await ask('ONCHAIN_TX_LOOKUP', { chain, hash: txHash.toLowerCase() });
    persistStats(stats);
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
