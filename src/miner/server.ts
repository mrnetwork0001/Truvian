/**
 * Truvian Miner HTTP server.
 *
 * Routes expose our envelope-agnostic intent handlers directly. When recon
 * confirms Telegraph's actual miner contract (registration + request/response
 * envelope), a thin adapter route is added alongside these — the handlers do
 * not change.
 */
import Fastify from 'fastify';
import { handleGasPrice, validateGasPriceInput } from './gasPrice.js';
import { handleTxLookup, validateTxLookupInput } from './txLookup.js';
import { IntentError } from '../types/index.js';

const MINER_ID = process.env.TRUVIAN_MINER_ID ?? 'truvian-miner-01';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true, minerId: MINER_ID }));

  // Human-facing landing page — validators never call this, but judges and
  // builders who open the base_url in a browser should not meet a 404.
  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truvian — Exact On-Chain Truth Engine</title>
<style>
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:640px;padding:2.5rem 1.5rem}
h1{font-size:1.5rem;margin:0 0 .25rem}
.badge{display:inline-block;border:1px solid #caa53d;color:#caa53d;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;margin:.5rem 0 1.25rem}
p{color:#9a9a9a;line-height:1.6;font-size:.9rem}
code{background:#161616;border:1px solid #262626;border-radius:4px;padding:.15rem .4rem;font-size:.85rem}
ul{list-style:none;padding:0}li{margin:.6rem 0}
a{color:#7db4ff;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><main>
<h1>🛡️ Truvian</h1>
<div class="badge">🏆 champion scorer · ONCHAIN_TX_LOOKUP</div>
<p>Exact on-chain answers for Base &amp; Ethereum, read live from JSON-RPC. Telegraph miner <code>truvian-onchain-truth</code> (reg #172) serving <code>ONCHAIN_TX_LOOKUP</code> and <code>GAS_PRICE</code>.</p>
<ul>
<li><code>GET /tx?chain=base&amp;hash=0x…</code> — full canonical transaction facts, incl. the OP-stack L1 data fee</li>
<li><code>GET /gas?chain=base</code> — block-anchored fee snapshot with EIP-1559 percentiles</li>
<li><code>GET /health</code> — liveness</li>
</ul>
<p><a href="https://github.com/mrnetwork0001/Truvian">source &amp; methodology</a> · <a href="https://explorer.telegraphprotocol.com/">telegraph explorer</a> · built for the <a href="https://hackathon.telegraphprotocol.com/">Telegraph Season I hackathon</a></p>
</main></body></html>`);
  });

  // Primary Telegraph-facing endpoints (GET + query params, the shape used by
  // the miners that actually score). The response body IS the payload — the
  // `answer` field leads so text-based validator scoring sees the facts first.
  app.get('/tx', async (req) => handleTxLookup(validateTxLookupInput(req.query)));
  app.get('/gas', async (req) => handleGasPrice(validateGasPriceInput(req.query ?? {})));

  // POST equivalents for JSON-body callers
  app.post('/tx', async (req) => handleTxLookup(validateTxLookupInput(req.body)));
  app.post('/gas', async (req) => handleGasPrice(validateGasPriceInput(req.body ?? {})));

  // Legacy intent-named routes (kept for local tooling)
  app.post('/intents/ONCHAIN_TX_LOOKUP', async (req) => handleTxLookup(validateTxLookupInput(req.body)));
  app.post('/intents/GAS_PRICE', async (req) => handleGasPrice(validateGasPriceInput(req.body ?? {})));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof IntentError) {
      const status = err.code === 'TX_NOT_FOUND' ? 404 : err.code === 'UPSTREAM_RPC_ERROR' ? 502 : 400;
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'internal error' });
  });

  return app;
}

// Run directly (npm run dev)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8787);
  // In production HOST=127.0.0.1 — nginx terminates TLS and proxies in.
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
