/**
 * HTTP routes for Truvian Resolve, registered by server.ts:
 *
 *   POST /api/resolve          run a resolution (same free allowance or x402 payment as a preflight);
 *                              ?stream=1 sends NDJSON: start, market, plan, answer..., memo, payment?, done
 *   GET  /api/resolution/:id   a stored resolution (signed memo + Solana anchor)
 *   GET  /api/resolutions      the latest resolutions
 *   GET  /resolve              the desk's page
 *
 * A resolution's memo is checked with the existing POST /api/memo/verify.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolve as resolvePath } from 'node:path';
import { MarketReadError, ResolveInputError, createResolveStore, normalizeResolveRequest, runResolve, sealResolution, type ResolveRequest } from './resolve.js';

export interface ResolveRouteDeps<A extends { admitted: boolean; paid?: unknown }> {
  admit(req: FastifyRequest, reply: FastifyReply): Promise<A>;
  /** Settle a verified payment after the work succeeded; reports the result. */
  settle(admission: A, reply: FastifyReply): Promise<{ success: boolean; transaction?: string | null | undefined; reason?: string | undefined } | null>;
  recordSpend(usd: number, requests: number): void;
  checksLeft(ip: string): number;
  save(): void;
  sendPage(reply: FastifyReply, file: string): Promise<boolean>;
}

const STORE_FILE = process.env.SHIELD_RESOLVE_MEMOS_FILE ?? resolvePath(process.cwd(), '.shield-resolve-memos.json');

export function registerResolveRoutes<A extends { admitted: boolean; paid?: unknown }>(app: FastifyInstance, deps: ResolveRouteDeps<A>): void {
  const store = createResolveStore(STORE_FILE);

  app.post('/api/resolve', async (req, reply) => {
    let parsed: ResolveRequest;
    try {
      parsed = normalizeResolveRequest((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ResolveInputError) return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      throw err;
    }
    const admission = await deps.admit(req, reply);
    if (!admission.admitted) return reply;

    const q = (req.query ?? {}) as Record<string, unknown>;
    const streaming = q.stream === '1' || String(req.headers.accept ?? '').includes('application/x-ndjson');
    let emit: (event: Record<string, unknown>) => void = () => {};
    if (streaming) {
      reply.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-store');
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.raw.flushHeaders();
      emit = (event) => {
        try { reply.raw.write(`${JSON.stringify(event)}\n`); } catch { /* client left; the work still finishes */ }
      };
    }
    emit({ type: 'start', input: parsed, startedAt: new Date().toISOString() });

    let result: Record<string, unknown>;
    let status = 200;
    try {
      const memo = await runResolve(parsed, {
        onMarket: (market) => emit({ type: 'market', market }),
        onPlan: (plan) => emit({ type: 'plan', plan }),
        onAnswer: (answer) => emit({ type: 'answer', answer }),
      });
      deps.recordSpend(memo.cost.telegraphUsd, memo.cost.paidRequests + memo.cost.failedRequests);
      const stored = store.add(await sealResolution(memo));
      result = { type: 'memo', ...stored, url: `/resolve?r=${stored.id}` };
    } catch (err) {
      if (!(err instanceof MarketReadError)) throw err;
      status = 502;
      result = { type: 'error', error: 'MARKET_UNREADABLE', message: `${err.message}. Nothing was bought and no decision was made.` };
    }

    if (streaming) {
      emit(result);
      if (status === 200) {
        const settlement = await deps.settle(admission, reply);
        if (settlement) emit({ type: 'payment', success: settlement.success, transaction: settlement.transaction ?? null, reason: settlement.reason });
      }
      emit({ type: 'done', checksLeftToday: deps.checksLeft(req.ip) });
      deps.save();
      reply.raw.end();
      return reply;
    }
    if (status === 200) await deps.settle(admission, reply);
    deps.save();
    reply.header('X-Shield-Checks-Left', String(deps.checksLeft(req.ip)));
    return reply.status(status).send(result);
  });

  app.get('/api/resolution/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = /^[A-Za-z0-9_-]{8}$/.test(id) ? store.get(id) : undefined;
    if (!entry) return reply.status(404).send({ error: 'NOT_FOUND', message: 'no stored resolution with that id' });
    return entry;
  });

  app.get('/api/resolutions', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = Number(q.limit);
    return { resolutions: store.recent(Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 12) };
  });

  app.get('/resolve', async (_req, reply) => {
    if (await deps.sendPage(reply, 'resolve.html')) return reply;
    return reply.status(404).send({ error: 'NOT_FOUND', message: 'resolve.html is missing' });
  });
}
