/**
 * One place that runs a commerce job, signs its memo, stores it and books it.
 * The HTTP routes (commerceRoutes.ts) and the ACP agent (src/acp) both sell
 * through it, so every job lands in the same store and the same ledger.
 */
import { signAnyMemo } from '../memo.js';
import { runDiligence, type DiligenceEvents, type DiligenceRequest } from './diligence.js';
import { runInvestigation, type InvestigateRequest } from './investigate.js';
import { runVerifyWork, type VerifyEvents, type VerifyWorkRequest } from './verifyWork.js';
import type { AnyWorkMemo, Channel, Ledger, LedgerEntry, StoredWork, WorkStore } from './store.js';

/** How the job was sold. The price is booked only once the payment settled. */
export interface Sale {
  channel: Channel;
  priceUsd: number;
  payment: { network: string; transaction: string | null } | null;
  acpJobId: string | null;
}

export const FREE: Sale = { channel: 'free', priceUsd: 0, payment: null, acpJobId: null };

export interface CommerceService {
  diligence(req: DiligenceRequest, events?: DiligenceEvents): Promise<StoredWork>;
  verify(req: VerifyWorkRequest, events?: VerifyEvents): Promise<StoredWork>;
  investigate(req: InvestigateRequest): Promise<StoredWork>;
  /** Book a stored job once its sale is known (after the payment settled, or as free) */
  book(stored: StoredWork, sale: Sale): LedgerEntry;
  store: WorkStore;
  ledger: Ledger;
}

export interface CommerceDeps {
  store: WorkStore;
  ledger: Ledger;
  /** Shield's counters: one desk decision, its Telegraph spend and requests */
  recordSpend(usd: number, requests: number): void;
}

function telegraphOf(m: AnyWorkMemo): { usd: number; requests: number } {
  return { usd: m.cost.telegraphUsd, requests: m.cost.paidRequests + m.cost.failedRequests };
}

function llmOf(m: AnyWorkMemo): { tokens: number | null; model: string | null } {
  if (m.kind === 'investigation') return { tokens: m.llm?.totalTokens ?? null, model: m.llm ? `${m.llm.provider}/${m.llm.model}` : null };
  if (m.kind === 'work-verification') return { tokens: m.extraction?.totalTokens ?? null, model: m.extraction ? `${m.extraction.provider}/${m.extraction.model}` : null };
  return { tokens: null, model: null };
}

export function createCommerceService(deps: CommerceDeps): CommerceService {
  const seal = async (memo: AnyWorkMemo): Promise<StoredWork> => {
    const t = telegraphOf(memo);
    deps.recordSpend(t.usd, t.requests);
    return deps.store.add({ memo, ...(await signAnyMemo(memo)) });
  };
  return {
    store: deps.store,
    ledger: deps.ledger,
    diligence: async (req, events) => seal(await runDiligence(req, events)),
    verify: async (req, events) => seal(await runVerifyWork(req, events)),
    investigate: async (req) => seal(await runInvestigation(req)),
    book(stored, sale) {
      const t = telegraphOf(stored.memo);
      const l = llmOf(stored.memo);
      return deps.ledger.record({
        memoId: stored.id, product: stored.memo.kind, channel: sale.channel, priceUsd: sale.priceUsd, payment: sale.payment, acpJobId: sale.acpJobId,
        telegraphUsd: t.usd, telegraphRequests: t.requests, llmTokens: l.tokens, llmModel: l.model,
      });
    },
  };
}
