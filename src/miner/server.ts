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

  app.post('/intents/ONCHAIN_TX_LOOKUP', async (req, reply) => {
    const input = validateTxLookupInput(req.body);
    const result = await handleTxLookup(input);
    return reply.send({ minerId: MINER_ID, intent: 'ONCHAIN_TX_LOOKUP', result });
  });

  app.post('/intents/GAS_PRICE', async (req, reply) => {
    const input = validateGasPriceInput(req.body);
    const result = await handleGasPrice(input);
    return reply.send({ minerId: MINER_ID, intent: 'GAS_PRICE', result });
  });

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
  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
