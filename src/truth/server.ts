/**
 * Truvian truth API: a free, keyless HTTP API for facts Telegraph scores
 * miners against, where no independent keyless API exists.
 *
 *   GET /balance?chain=polygon&address=0x...&block=81555727
 *
 * Native balance (wei and gwei, decimal strings) and nonce of an address at a
 * block on Ethereum, Polygon PoS or Arbitrum One, accepted only when two
 * independent archive endpoints agree exactly (src/truth/balance.ts). Errors
 * are real HTTP statuses with a JSON body, so a caller can never mistake one
 * for a value.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import { TRUTH_CHAINS, TruthError, balanceAt, parseBalanceQuery } from './balance.js';

export function buildTruthServer() {
  const app = Fastify({ logger: true, trustProxy: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/', async () => ({
    name: 'Truvian truth API',
    endpoints: {
      '/balance': `native balance and nonce of an address at a block; chain one of ${TRUTH_CHAINS.join(', ')}; two independent archive endpoints must agree`,
    },
    example: '/balance?chain=polygon&address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&block=81555727',
    source: 'https://github.com/mrnetwork0001/Truvian/tree/main/src/truth',
  }));

  app.get('/balance', async (req, reply) => {
    try {
      return await balanceAt(parseBalanceQuery((req.query ?? {}) as Record<string, unknown>));
    } catch (err) {
      if (err instanceof TruthError) {
        return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      }
      req.log.error(err);
      return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
    }
  });

  return app;
}

// Run directly: npx tsx src/truth/server.ts
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const app = buildTruthServer();
  const port = Number(process.env.TRUTH_PORT ?? 8790);
  const host = process.env.TRUTH_HOST ?? '127.0.0.1';
  app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
