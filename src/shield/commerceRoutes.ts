/**
 * HTTP routes for the commerce desks, registered by server.ts:
 *
 *   POST /api/diligence      counterparty due diligence report (PROCEED / REVIEW / DECLINE)
 *   POST /api/investigate    enterprise decision assurance: the agent reads a decision brief,
 *                            investigates, and writes the case; rules decide
 *   POST /api/verify-work    independent verification of an agent's deliverable
 *                            (ACCEPTED / REJECTED / INCOMPLETE / REVIEW)
 *   GET  /api/work/:id       a stored, signed work memo
 *   GET  /api/works          the latest work memos (?kind=due-diligence|investigation|work-verification)
 *   GET  /api/business       the intelligence business's books: jobs, revenue, Telegraph cost, margin
 *
 * Each POST draws on the same free allowance (or x402 payment) as a desk run,
 * and every job is booked in the ledger at what was actually paid for it.
 * Work memos are checked with the existing POST /api/memo/verify.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DiligenceInputError, normalizeDiligenceRequest } from './commerce/diligence.js';
import { InvestigateInputError, normalizeInvestigateRequest } from './commerce/investigate.js';
import { llmInfo, LlmUnavailableError } from './commerce/llm.js';
import { FREE, type CommerceService, type Sale } from './commerce/service.js';
import type { StoredWork } from './commerce/store.js';
import { normalizeVerifyRequest, VerifyInputError } from './commerce/verifyWork.js';

export interface CommerceRouteDeps<A extends { admitted: boolean; paid?: unknown }> {
  admit(req: FastifyRequest, reply: FastifyReply): Promise<A>;
  settle(admission: A, reply: FastifyReply): Promise<{ success: boolean; transaction?: string | null | undefined; reason?: string | undefined } | null>;
  priceUsd(): number;
  checksLeft(ip: string): number;
  save(): void;
}

const ID = /^[A-Za-z0-9_-]{8}$/;

/**
 * Truvian's own ACP agent (acp/) calls these desks as the seller or evaluator of a job.
 * With SHIELD_INTERNAL_KEY as a bearer token it skips the public free allowance and x402,
 * because the ACP job carries its own payment; it books the sale itself through
 * POST /api/business/book once the job settles on ACP.
 */
function internal(req: FastifyRequest): boolean {
  const key = process.env.SHIELD_INTERNAL_KEY?.trim();
  if (!key || key.length < 24) return false;
  return req.headers.authorization === `Bearer ${key}`;
}

export function registerCommerceRoutes<A extends { admitted: boolean; paid?: unknown }>(app: FastifyInstance, service: CommerceService, deps: CommerceRouteDeps<A>): void {
  /** Admit, run, settle, book: the same for every commerce POST. */
  const sell = async (req: FastifyRequest, reply: FastifyReply, run: () => Promise<StoredWork>) => {
    if (internal(req)) {
      try {
        const stored = await run();
        deps.save();
        return reply.send({ ...stored, url: `/api/work/${stored.id}`, booked: null });
      } catch (err) {
        deps.save();
        if (err instanceof LlmUnavailableError) return reply.status(503).send({ error: 'AGENT_MODEL_UNAVAILABLE', message: `${err.message}. Nothing was bought.` });
        if (err instanceof InvestigateInputError) return reply.status(422).send({ error: 'BRIEF_UNREADABLE', message: err.message });
        throw err;
      }
    }
    const admission = await deps.admit(req, reply);
    if (!admission.admitted) return reply;
    let stored: StoredWork;
    try {
      stored = await run();
    } catch (err) {
      deps.save();
      if (err instanceof LlmUnavailableError) return reply.status(503).send({ error: 'AGENT_MODEL_UNAVAILABLE', message: `${err.message}. Nothing was bought.` });
      if (err instanceof InvestigateInputError) return reply.status(422).send({ error: 'BRIEF_UNREADABLE', message: err.message });
      throw err;
    }
    let sale: Sale = FREE;
    const settlement = await deps.settle(admission, reply);
    if (settlement?.success) sale = { channel: 'x402', priceUsd: deps.priceUsd(), payment: { network: 'base-sepolia', transaction: settlement.transaction ?? null }, acpJobId: null };
    const booked = service.book(stored, sale);
    deps.save();
    reply.header('X-Shield-Checks-Left', String(deps.checksLeft(req.ip)));
    return reply.send({ ...stored, url: `/api/work/${stored.id}`, booked, ...(settlement ? { payment: settlement } : {}) });
  };

  app.post('/api/diligence', async (req, reply) => {
    let parsed;
    try {
      parsed = normalizeDiligenceRequest(req.body ?? {});
    } catch (err) {
      if (err instanceof DiligenceInputError) return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      throw err;
    }
    return sell(req, reply, () => service.diligence(parsed));
  });

  app.post('/api/investigate', async (req, reply) => {
    let parsed;
    try {
      parsed = normalizeInvestigateRequest(req.body ?? {});
    } catch (err) {
      if (err instanceof InvestigateInputError) return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      throw err;
    }
    return sell(req, reply, () => service.investigate(parsed));
  });

  app.post('/api/verify-work', async (req, reply) => {
    let parsed;
    try {
      parsed = normalizeVerifyRequest(req.body ?? {});
    } catch (err) {
      if (err instanceof VerifyInputError) return reply.status(400).send({ error: 'INVALID_INPUT', message: err.message });
      throw err;
    }
    return sell(req, reply, () => service.verify(parsed));
  });

  app.get('/api/work/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = ID.test(id) ? service.store.get(id) : undefined;
    if (!entry) return reply.status(404).send({ error: 'NOT_FOUND', message: 'no stored work memo with that id' });
    return entry;
  });

  app.get('/api/works', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = Number(q.limit);
    const kinds = ['due-diligence', 'investigation', 'work-verification'] as const;
    const kind = kinds.find((k) => k === q.kind);
    return { works: service.store.recent(Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 12, kind) };
  });

  /** Book an ACP sale (internal): the job's memo, what the ACP job paid, and its id. Booked once per memo. */
  app.post('/api/business/book', async (req, reply) => {
    if (!internal(req)) return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'internal route' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const memoId = typeof b.memoId === 'string' && ID.test(b.memoId) ? b.memoId : null;
    const stored = memoId ? service.store.get(memoId) : undefined;
    if (!stored) return reply.status(404).send({ error: 'NOT_FOUND', message: 'no stored work memo with that id' });
    if (service.ledger.entries(5000).some((e) => e.memoId === stored.id)) return reply.status(409).send({ error: 'ALREADY_BOOKED', message: 'this memo is already in the ledger' });
    const price = Number(b.priceUsd);
    if (!Number.isFinite(price) || price < 0 || price > 1000) return reply.status(400).send({ error: 'INVALID_INPUT', message: 'priceUsd must be 0 to 1000' });
    const acpJobId = typeof b.acpJobId === 'string' && b.acpJobId.trim() ? b.acpJobId.trim().slice(0, 80) : null;
    const network = typeof b.network === 'string' && b.network.trim() ? b.network.trim().slice(0, 40) : 'base-sepolia';
    const booked = service.book(stored, { channel: 'acp', priceUsd: price, payment: price > 0 ? { network, transaction: typeof b.transaction === 'string' ? b.transaction.slice(0, 100) : null } : null, acpJobId });
    deps.save();
    return booked;
  });

  app.get('/api/business', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = Number(q.limit);
    return {
      summary: service.ledger.summary(),
      jobs: service.ledger.entries(Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : 25),
      pricing: { perJobUsd: deps.priceUsd(), freeRunsPerDay: 'same allowance as the desks' },
      agentModel: llmInfo(),
    };
  });
}
