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
