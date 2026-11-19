/**
 * Truvian Miner HTTP server.
 *
 * Routes expose the intent handlers directly: the response body is the
 * payload, carrying the fields of Telegraph's V2 response format by name.
 * telegraph/truvian-miner.yaml tells the node how to call these routes and
 * where each field sits (intent_mapping).
 */
import Fastify from 'fastify';
import { handleGasPrice, validateGasPriceInput } from './gasPrice.js';
import { handleTxLookup, validateTxLookupInput } from './txLookup.js';
import { IntentError } from '../types/index.js';

const MINER_ID = process.env.TRUVIAN_MINER_ID ?? 'truvian-miner-01';

/** Routes that serve a Telegraph intent and must always return answer text. */
function isIntentRoute(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] ?? '';
  return path === '/tx' || path === '/gas' || path.startsWith('/intents/');
}

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ ok: true, minerId: MINER_ID }));

  // Human-facing landing page - validators never call this, but judges and
  // builders who open the base_url in a browser should not meet a 404.
  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truvian - Exact Onchain Truth Engine</title>
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
<div class="badge">Telegraph miner · truvian-onchain-truth</div>
<p>Exact onchain answers read live from public JSON-RPC on Base, Ethereum, Arbitrum One, OP Mainnet, Polygon, BNB Smart Chain, Avalanche, Scroll, Linea, Gnosis, ZKsync Era, X Layer, Ethereum Sepolia and Base Sepolia. Serves the Telegraph intents <code>ONCHAIN_TX_LOOKUP_GENERAL</code> and <code>GAS_PRICE_GENERAL</code>.</p>
<ul>
<li><code>GET /tx?tx_hash=0x…&amp;chain=base</code> - status, inclusion block, sender, recipient and value of a transaction, plus the exact total fee incl. the L1 data fee on rollups that bill it</li>
<li><code>GET /gas?chain=base</code> - block-anchored gas price in gwei with EIP-1559 percentiles</li>
<li><code>GET /health</code> - liveness</li>
</ul>
<p><a href="https://github.com/mrnetwork0001/Truvian">source &amp; methodology</a> · <a href="https://explorer.telegraphprotocol.com/">telegraph explorer</a> · 3rd place, Miner track, Telegraph Season I</p>
</main></body></html>`);
  });

  // Primary Telegraph-facing endpoints (GET + query params). The response
  // body IS the payload: `answer` leads for nodes that read the whole answer
  // with a parser model; the intent's own fields follow for nodes that read by path.
  app.get('/tx', async (req) => handleTxLookup(validateTxLookupInput(req.query)));
  app.get('/gas', async (req) => handleGasPrice(validateGasPriceInput(req.query ?? {})));

  // POST equivalents for JSON-body callers
  app.post('/tx', async (req) => handleTxLookup(validateTxLookupInput(req.body)));
  app.post('/gas', async (req) => handleGasPrice(validateGasPriceInput(req.body ?? {})));

  // Legacy intent-named routes (kept for local tooling)
  app.post('/intents/ONCHAIN_TX_LOOKUP', async (req) => handleTxLookup(validateTxLookupInput(req.body)));
  app.post('/intents/GAS_PRICE', async (req) => handleGasPrice(validateGasPriceInput(req.body ?? {})));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof IntentError) {
      // Intent routes must ALWAYS return a scoreable `answer` string. Validators
      // score the answer text; a bare error body carries none and scores exactly
      // 0 - strictly worse than stating plainly that the record was not found.
      // (Measured: every miner that degrades to 200+prose scores above zero;
      // every miner that returns an answer-less error scores zero.)
      if (isIntentRoute(req.url) && err.code !== 'UPSTREAM_RPC_ERROR') {
        return reply.status(200).send({
          answer: err.answerText,
          signal: err.answerText,
          source: 'Truvian onchain lookup over public JSON-RPC',
          confidence: 0,
          ...err.fields,
          resolved: false,
          error: err.code,
          message: err.message,
        });
      }
      const status = err.code === 'UPSTREAM_RPC_ERROR' ? 502 : 400;
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
  // In production HOST=127.0.0.1 - nginx terminates TLS and proxies in.
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
