/**
 * Enterprise decision assurance (Tencent "Enterprise Decision Assurance"):
 * an agent that investigates a counterparty before a business commits.
 *
 *   1. The agent model (Hunyuan when configured, llm.ts) reads the decision
 *      brief, in the business's own words, into a subject: who the
 *      counterparty is, where it is registered, which wallets matter.
 *   2. Truvian runs due diligence on it (diligence.ts): sanctions and
 *      registry bought from Telegraph's ranked miners with receipts, wallet
 *      balances read from the chain.
 *   3. Missing information is investigated: when the registry has no record
 *      of the name given, or the record is for another entity, the model
 *      proposes up to two other names or jurisdictions the company may be
 *      registered under, and Truvian buys those lookups too. A follow-up
 *      record counts only if it names the entity asked about.
 *   4. Fixed rules decide PROCEED, REVIEW or DECLINE. The model then writes
 *      the case for the decision-maker from the findings; it cannot change
 *      the decision, and the memo records what it wrote and which model
 *      wrote it.
 */
import { buy, memoCost, Spend, type FactContext, type Finding, type PreflightRequest, type Purchase } from '../preflight.js';
import { countryOf, normName, registryJudge, sanctionsJudge } from '../settlement.js';
import { chat, firstJson, llmConfig, LlmUnavailableError, newUse, type LlmUse } from './llm.js';
import { DiligenceInputError, normalizeDiligenceRequest, recommend, runDiligence, type DiligenceMemo, type DiligenceRequest, type Recommendation } from './diligence.js';

export interface InvestigateRequest {
  /** The decision, in the business's own words */
  brief: string;
  /** The subject, when the caller already has it structured (skips reading the brief) */
  subject: DiligenceRequest | null;
}

export class InvestigateInputError extends Error {}

export function normalizeInvestigateRequest(raw: unknown): InvestigateRequest {
  if (typeof raw !== 'object' || raw === null) throw new InvestigateInputError('body must be a JSON object');
  const b = raw as Record<string, unknown>;
  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (brief.length < 20 || brief.length > 4000) throw new InvestigateInputError('brief must describe the decision in 20 to 4000 characters');
  let subject: DiligenceRequest | null = null;
  if (b.subject !== undefined && b.subject !== null) {
    try {
      subject = normalizeDiligenceRequest(b.subject);
    } catch (err) {
      if (err instanceof DiligenceInputError) throw new InvestigateInputError(`subject: ${err.message}`);
      throw err;
    }
  }
  return { brief, subject };
}

export interface FollowUp {
  /** registry: another name or jurisdiction for the record; sanctions: the legal name a follow-up record gave, screened too */
  kind: 'registry' | 'sanctions';
  why: string;
  asked: { company: string; jurisdiction: string };
  /** The model's reason for this name */
  reason: string;
  purchase: Purchase | null;
  /** True when the answer named the entity asked about and is used as evidence */
  used: boolean;
  outcome: string;
}

export interface InvestigationMemo {
  version: 'truvian-work-memo/1';
  kind: 'investigation';
  createdAt: string;
  brief: string;
  /** How the subject was obtained */
  subjectFrom: 'given' | 'read-by-model';
  /** What the model read from the brief: the decision and the subject */
  reading: { decision: string | null; proposedAction: string | null; amountUsd: number | null; raw: string | null };
  subject: DiligenceRequest;
  diligence: DiligenceMemo;
  followUps: FollowUp[];
  findings: Finding[];
  recommendation: Recommendation;
  recommendationRule: string;
  /** True when the evidence holds back what the brief proposed */
  changesOutcome: boolean;
  /** The case for the decision-maker, written by the model from the findings; the error when the model did not write it; null when no model is configured */
  case: { text: string } | { error: string } | null;
  llm: LlmUse | null;
  cost: { telegraphUsd: number; paidRequests: number; failedRequests: number; llmTokens: number | null };
  latencyMs: number;
}

const READ_SYSTEM = `You read a business decision brief and pull out the counterparty to investigate. Use only what the brief says; never use your own knowledge of the company. Answer with JSON only:
{"decision":"<one sentence: what the business is about to decide>","proposedAction":"<what the brief proposes, e.g. pay, sign, onboard, invest>","amountUsd":<number or null>,"entity":"<the counterparty's legal name as written>","jurisdiction":"<where the brief says it is registered (country, or ISO code); null if not said>","wallets":[{"chain":"ethereum|base|arbitrum|optimism|polygon|bsc|solana|solana-devnet","address":"<as written>","token":"<token contract or mint, as written>"}]}
List a wallet only if the brief gives its chain, address and token.`;

async function readBrief(brief: string, use: LlmUse): Promise<{ subject: DiligenceRequest; reading: InvestigationMemo['reading'] }> {
  const { text } = await chat(READ_SYSTEM, brief, use, 800);
  let j: Record<string, unknown>;
  try {
    j = firstJson(text) as Record<string, unknown>;
  } catch (err) {
    throw new InvestigateInputError(`the agent model could not read the brief: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof j.jurisdiction !== 'string' || !j.jurisdiction.trim()) throw new InvestigateInputError('the brief does not say where the counterparty is registered; add its jurisdiction');
  let subject: DiligenceRequest;
  try {
    subject = normalizeDiligenceRequest({ entity: j.entity, jurisdiction: j.jurisdiction, wallets: Array.isArray(j.wallets) ? j.wallets.slice(0, 3) : [], purpose: j.decision });
  } catch (err) {
    if (err instanceof DiligenceInputError) throw new InvestigateInputError(`the counterparty read from the brief is not usable: ${err.message}`);
    throw err;
  }
  const amount = typeof j.amountUsd === 'number' && Number.isFinite(j.amountUsd) ? j.amountUsd : null;
  return { subject, reading: { decision: typeof j.decision === 'string' ? j.decision : null, proposedAction: typeof j.proposedAction === 'string' ? j.proposedAction : null, amountUsd: amount, raw: text } };
}

const FOLLOW_SYSTEM = `A corporate registry lookup found no usable record for a company. Propose at most two other ways the SAME company may be registered: its full legal name with the legal form spelled out or abbreviated differently, or the registering state or country if the brief suggests one. Never propose a different company, a parent, or a subsidiary. Answer with JSON only: {"tries":[{"company":"...","jurisdiction":"...","reason":"..."}]}`;

/** The registry finding is no evidence: nothing came back, or it is about someone else. */
const registryLacking = (f: Finding): boolean => ['registry.unavailable', 'registry.missing', 'registry.other_entity'].includes(f.rule);
/** Worth a follow-up: no evidence, or a record from another country (often another company with a similar short name). */
const registryUnsettled = (f: Finding): boolean => registryLacking(f) || f.rule === 'registry.jurisdiction_conflict';

async function followUps(subject: DiligenceRequest, brief: string, d: DiligenceMemo, use: LlmUse): Promise<FollowUp[]> {
  const lacking = d.findings.find(registryUnsettled);
  if (!lacking) return [];
  const { text } = await chat(FOLLOW_SYSTEM, `Brief:\n${brief}\n\nCompany asked: ${subject.entity} (${subject.jurisdiction})\nWhy no usable record: ${lacking.detail}`, use, 500);
  let tries: Array<{ company: string; jurisdiction: string; reason: string }> = [];
  try {
    const j = firstJson(text) as { tries?: unknown };
    tries = (Array.isArray(j.tries) ? j.tries : []).flatMap((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const company = typeof o.company === 'string' ? o.company.trim() : '';
      const jurisdiction = typeof o.jurisdiction === 'string' ? o.jurisdiction.trim() : subject.jurisdiction;
      if (company.length < 2 || company.length > 160) return [];
      return [{ company, jurisdiction: jurisdiction || subject.jurisdiction, reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '' }];
    });
  } catch {
    tries = [];
  }
  // Never the same request again, never more than two, and the name must still be recognisably the same company
  const core = (s: string) => normName(s).split(' ').filter((w) => w.length > 2);
  const asked = core(subject.entity);
  tries = tries.filter((t) => !(normName(t.company) === normName(subject.entity) && countryOf(t.jurisdiction) === countryOf(subject.jurisdiction)))
    .filter((t) => asked.length === 0 || core(t.company).some((w) => asked.includes(w)))
    .slice(0, 2);
  const spend = new Spend(0.03, 0);
  const out: FollowUp[] = [];
  for (const t of tries) {
    const fu: FollowUp = { kind: 'registry', why: lacking.title, asked: { company: t.company, jurisdiction: t.jurisdiction }, reason: t.reason, purchase: null, used: false, outcome: '' };
    if (!spend.take(0.01)) {
      fu.outcome = 'not asked: over the follow-up budget';
      out.push(fu);
      continue;
    }
    const judgeAll = (p: Purchase) => registryJudge(p, t.company, t.jurisdiction);
    const ctx = { req: { mode: 'listing', chain: 'ethereum', token: '0x0000000000000000000000000000000000000000', issuer: t.company } as unknown as PreflightRequest, facts: null as unknown as FactContext['facts'], treasuryRead: null, judgeAll, spend };
    fu.purchase = await buy({ key: 'registry', intent: 'CORPORATE_REGISTRY_LOOKUP_GENERAL', params: { company: t.company, jurisdiction: t.jurisdiction }, question: `Corporate registry record of ${t.company} (${t.jurisdiction}): legal name, registration id, active or not, jurisdiction.` }, ctx);
    const got = judgeAll(fu.purchase);
    fu.used = !got.some(registryUnsettled);
    fu.outcome = fu.used ? `record found: ${got.map((f) => f.title).join('; ')}` : `no usable record either: ${got.map((f) => f.title).join('; ')}`;
    out.push(fu);
    if (fu.used) {
      // The record names the company in full: screen that name too, not only the short one the brief used
      const legal = typeof fu.purchase.fields?.legal_name === 'string' ? fu.purchase.fields.legal_name.trim() : '';
      if (legal && normName(legal) !== normName(subject.entity) && spend.take(0.01)) {
        const sj = (p: Purchase) => sanctionsJudge(p, legal);
        const sctx = { ...ctx, judgeAll: sj };
        const p = await buy({ key: 'sanctions', intent: 'SANCTIONS_SCREENING_MATCH_GENERAL', params: { name: legal }, question: `Is ${legal} on a sanctions list?` }, sctx);
        const f = sj(p);
        out.push({ kind: 'sanctions', why: `the registry record names the company "${legal}"`, asked: { company: legal, jurisdiction: t.jurisdiction }, reason: 'screen the full legal name as well as the name in the brief', purchase: p, used: true, outcome: f.map((x) => x.title).join('; ') });
      }
      break;
    }
  }
  return out;
}

const CASE_SYSTEM = `You write the case for a business decision-maker from an evidence memo. The decision has already been made by fixed rules; state it and never argue against it. Use only the findings given: cite each fact you use with its rule id in brackets, e.g. [sanctions.match]. Say what was not verified. Plain words, at most 180 words, no headings, no em dashes.`;

export async function runInvestigation(req: InvestigateRequest): Promise<InvestigationMemo> {
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const cfg = llmConfig();
  if (!req.subject && !cfg) throw new LlmUnavailableError('no agent model is configured, so the brief cannot be read; pass subject {entity, jurisdiction, wallets} instead');
  const use = cfg ? newUse(cfg) : null;

  let subject: DiligenceRequest;
  let reading: InvestigationMemo['reading'] = { decision: null, proposedAction: null, amountUsd: null, raw: null };
  let subjectFrom: InvestigationMemo['subjectFrom'] = 'given';
  if (req.subject) subject = { ...req.subject, purpose: req.subject.purpose ?? req.brief.slice(0, 500) };
  else {
    ({ subject, reading } = await readBrief(req.brief, use!));
    subjectFrom = 'read-by-model';
  }

  const diligence = await runDiligence(subject);
  const fus = use ? await followUps(subject, req.brief, diligence, use) : [];

  // A used follow-up replaces the registry finding it settled. The record it found is under a name the
  // agent proposed, so a person must confirm that it is the counterparty: the agent can add evidence,
  // never clear a counterparty on an identity it inferred.
  const used = fus.find((f) => f.kind === 'registry' && f.used && f.purchase);
  const screened = fus.find((f) => f.kind === 'sanctions' && f.purchase);
  let findings = diligence.findings;
  if (used) {
    const legal = typeof used.purchase!.fields?.legal_name === 'string' ? used.purchase!.fields.legal_name : used.asked.company;
    findings = [
      ...findings.filter((f) => !registryUnsettled(f)),
      ...registryJudge(used.purchase!, used.asked.company, used.asked.jurisdiction).map((f) => ({ ...f, title: `Follow-up (${used.asked.company}): ${f.title}` })),
      ...(screened ? sanctionsJudge(screened.purchase!, screened.asked.company).map((f) => ({ ...f, title: `Follow-up (${screened.asked.company}): ${f.title}` })) : []),
      { rule: 'identity.inferred', severity: 'review', title: `Confirm the counterparty is ${legal}`, detail: `The brief names "${subject.entity}" (${subject.jurisdiction}). The first registry answer did not settle who that is (${used.why}). The agent then asked for "${used.asked.company}" (${used.asked.jurisdiction}): ${used.reason || 'no reason given'}. That record is evidence about ${legal}; a person must confirm it is the counterparty in the brief.`, source: 'policy', evidence: ['registry'] },
    ];
  }
  const order = { block: 0, review: 1, info: 2, pass: 3 } as const;
  findings = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const { recommendation, rule } = recommend(findings);

  let caseText: InvestigationMemo['case'] = null;
  if (use) {
    const lines = findings.map((f) => `[${f.rule}] (${f.severity}) ${f.title}: ${f.detail}`).join('\n');
    try {
      const { text } = await chat(CASE_SYSTEM, `Decision brief:\n${req.brief}\n\nDecision by the rules: ${recommendation} (${rule}).\n\nFindings:\n${lines}`, use, 600);
      caseText = { text: text.replace(/—/g, ',').trim() };
    } catch (err) {
      // The decision stands on the rules; a missing write-up is recorded, not hidden
      if (!(err instanceof LlmUnavailableError)) throw err;
      caseText = { error: err.message };
    }
  }

  const all = [...diligence.purchases, ...fus.flatMap((f) => (f.purchase ? [f.purchase] : []))];
  const c = memoCost(all);
  return {
    version: 'truvian-work-memo/1',
    kind: 'investigation',
    createdAt,
    brief: req.brief,
    subjectFrom,
    reading,
    subject,
    diligence,
    followUps: fus,
    findings,
    recommendation,
    recommendationRule: rule,
    changesOutcome: recommendation !== 'PROCEED',
    case: caseText,
    llm: use,
    cost: { telegraphUsd: c.telegraphUsd, paidRequests: c.paidRequests, failedRequests: c.failedRequests, llmTokens: use?.totalTokens ?? null },
    latencyMs: Date.now() - started,
  };
}
