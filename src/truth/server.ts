/**
 * Truvian truth API: a free, keyless HTTP API for facts Telegraph scores
 * miners against, where no independent keyless API exists.
 *
 *   GET /balance?chain=polygon&address=0x...&block=81555727
 *   GET /total-supply?token=USDC (0xA0b8...) on Ethereum
 *   GET /wallet-balance?address=0x...&chain=ethereum&token=USDC
 *   GET /tx?tx_hash=0x...&chain=ethereum
 *
 * /balance: native balance (wei and gwei, decimal strings) and nonce of an
 * address at a block on Ethereum, Polygon PoS or Arbitrum One
 * (src/truth/balance.ts). /total-supply and /wallet-balance: an ERC-20's
 * total supply, and an address's native or ERC-20 balance, in whole units at
 * a block just below the tip (src/truth/state.ts). /tx: the block a
 * transaction was included in (src/truth/tx.ts). Each is accepted only when
 * two endpoints run by different providers agree exactly. Errors are real
 * HTTP statuses with a JSON body, so a caller can never mistake one for a
 * value.
 */
import 'dotenv/config';
import Fastify from 'fastify';
import { TRUTH_CHAINS, TruthError, balanceAt, parseBalanceQuery } from './balance.js';
import { CURRENT_CHAINS } from './endpoints.js';
import { parseSupplyQuery, parseWalletQuery, totalSupply, walletBalance } from './state.js';
import { parseTxQuery, txBlock } from './tx.js';

export function buildTruthServer() {
  const app = Fastify({ logger: true, trustProxy: true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/', async () => ({
    name: 'Truvian truth API',
    endpoints: {
      '/balance': `native balance and nonce of an address at a block; chain one of ${TRUTH_CHAINS.join(', ')}; two independent archive endpoints must agree`,
      '/total-supply': `total supply of an ERC-20 in whole tokens, now; token "<symbol or contract address> on <chain>", chain one of ${CURRENT_CHAINS.join(', ')}`,
      '/wallet-balance': `native or ERC-20 balance of an address in whole units, now; chain one of ${CURRENT_CHAINS.join(', ')}; token empty for the native coin`,
      '/tx': `the block a transaction was included in; chain one of ${CURRENT_CHAINS.join(', ')}`,
    },
    examples: [
      '/balance?chain=polygon&address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&block=81555727',
      '/total-supply?token=USDC%20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)%20on%20Ethereum',
      '/wallet-balance?address=0x00000000219ab540356cBB839Cbe05303d7705Fa&chain=ethereum',
      '/tx?tx_hash=0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060&chain=ethereum',
    ],
    source: 'https://github.com/mrnetwork0001/Truvian/tree/main/src/truth',
  }));

  /** One route: parse, answer, and turn a TruthError into its HTTP status. */
  const route = (path: string, answer: (query: Record<string, unknown>) => Promise<unknown>) => {
    app.get(path, async (req, reply) => {
      try {
        return await answer((req.query ?? {}) as Record<string, unknown>);
      } catch (err) {
        if (err instanceof TruthError) {
          return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
        }
        req.log.error(err);
        return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
      }
    });
  };
  route('/balance', async (q) => balanceAt(parseBalanceQuery(q)));
  route('/total-supply', async (q) => totalSupply(parseSupplyQuery(q)));
  route('/wallet-balance', async (q) => walletBalance(parseWalletQuery(q)));
  route('/tx', async (q) => txBlock(parseTxQuery(q)));

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
