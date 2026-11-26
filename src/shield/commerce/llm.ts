/**
 * The agent model: Tencent Hunyuan when it is configured, an OpenAI-compatible
 * fallback otherwise. Every use is recorded (provider, model, tokens, time) in
 * the memo it served, so a memo always says which model did the work.
 *
 *   HUNYUAN_API_KEY, HUNYUAN_BASE_URL, HUNYUAN_MODEL   Tencent Cloud (TokenHub,
 *       OpenAI-compatible /chat/completions). All three are required.
 *   AGENT_LLM_MODEL (or the first of LLM_MODELS), LLM_BASE_URL, LLM_API_KEY
 *       the fallback, used only when Hunyuan is not configured.
 *
 * The model never decides. It reads text (a decision brief, a deliverable)
 * into structured input, proposes follow-up questions, and writes the case.
 * Fixed rules over bought evidence make every decision.
 */

export interface LlmConfig {
  provider: 'tencent-hunyuan' | 'openai-compatible';
  baseUrl: string;
  model: string;
  key: string;
}

export interface LlmUse {
  provider: LlmConfig['provider'];
  model: string;
  calls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
}

export class LlmUnavailableError extends Error {}

export function llmConfig(): LlmConfig | null {
  const hk = process.env.HUNYUAN_API_KEY?.trim(), hb = process.env.HUNYUAN_BASE_URL?.trim(), hm = process.env.HUNYUAN_MODEL?.trim();
  if (hk && hb && hm) return { provider: 'tencent-hunyuan', baseUrl: hb, model: hm, key: hk };
  const k = process.env.LLM_API_KEY?.trim(), b = process.env.LLM_BASE_URL?.trim();
  const m = process.env.AGENT_LLM_MODEL?.trim() || (process.env.LLM_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (k && b && m) return { provider: 'openai-compatible', baseUrl: b, model: m, key: k };
  return null;
}

/** Which model the agent uses, without the key: for /api/stats and the pages. */
export function llmInfo(): { provider: LlmConfig['provider']; model: string } | null {
  const c = llmConfig();
  return c ? { provider: c.provider, model: c.model } : null;
}

export function newUse(c: LlmConfig): LlmUse {
  return { provider: c.provider, model: c.model, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 };
}

const add = (a: number | null, b: unknown): number | null => (a === null || typeof b !== 'number' ? null : a + b);

const TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS) > 0 ? Number(process.env.AGENT_LLM_TIMEOUT_MS) : 90_000;

/** One chat completion. Throws LlmUnavailableError when no model is configured or the call fails. */
export async function chat(system: string, user: string, use?: LlmUse, maxTokens = 2000): Promise<{ text: string; use: LlmUse }> {
  const c = llmConfig();
  if (!c) throw new LlmUnavailableError('no agent model is configured: set HUNYUAN_API_KEY, HUNYUAN_BASE_URL and HUNYUAN_MODEL (or the LLM_* fallback)');
  const u = use ?? newUse(c);
  const t0 = Date.now();
  const body = (temperature: boolean) => JSON.stringify({
    model: c.model, max_tokens: maxTokens, ...(temperature ? { temperature: 0 } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const post = (temperature: boolean) => fetch(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
    body: body(temperature),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res: Response;
  let json: any;
  try {
    res = await post(true);
    json = await res.json().catch(() => ({}));
    if (res.status === 400 && /temperature/i.test(JSON.stringify(json))) {
      res = await post(false);
      json = await res.json().catch(() => ({}));
    }
  } catch (err) {
    throw new LlmUnavailableError(`${c.provider} ${c.model} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  u.calls += 1;
  u.latencyMs += Date.now() - t0;
  if (!res.ok) throw new LlmUnavailableError(`${c.provider} ${c.model}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  u.promptTokens = add(u.promptTokens, json?.usage?.prompt_tokens);
  u.completionTokens = add(u.completionTokens, json?.usage?.completion_tokens);
  u.totalTokens = add(u.totalTokens, json?.usage?.total_tokens);
  const text = String(json?.choices?.[0]?.message?.content ?? '');
  const finish = json?.choices?.[0]?.finish_reason;
  if (!text.trim()) throw new LlmUnavailableError(`${c.provider} ${c.model} returned an empty answer${finish ? ` (finish_reason ${finish}${finish === 'content_filter' ? ': the provider filtered the topic' : ''})` : ''}`);
  return { text, use: u };
}

/** The first JSON object or array in a reply (models wrap JSON in prose or fences). */
export function firstJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1]! : text;
  const start = src.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in the reply');
  const open = src[start]!, close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in the reply');
}

export const CLAIM_SCHEMA_TEXT = `Each claim is one of:
{"kind":"sanctions","entity":"<legal name>","listed":true|false}
{"kind":"registry","entity":"<legal name>","jurisdiction":"<country or ISO code>","active":true|false,"registrationId":"<id, optional>","legalName":"<optional>"}
{"kind":"token_balance","chain":"ethereum|base|arbitrum|optimism|polygon|bsc|solana|solana-devnet","wallet":"<address>","token":"<token contract or mint>","balance":"<whole tokens, digits only>"}
{"kind":"token_supply","chain":"<as above>","token":"<token contract or mint>","totalSupply":"<whole tokens, digits only>"}`;

/**
 * Read a free-text deliverable into claims. The model is told to copy what the
 * text asserts, not to judge it, and to leave out anything it cannot type.
 */
export async function extractClaims(task: string, text: string): Promise<{ claims: unknown[]; raw: string; use: LlmUse }> {
  const system = `You turn an agent's deliverable into checkable claims. Copy exactly what the deliverable asserts; do not correct, judge or add anything, and do not use your own knowledge. Leave out statements that fit none of the claim kinds. Addresses and numbers must be copied character for character.
${CLAIM_SCHEMA_TEXT}
Answer with JSON only: {"claims":[...]}`;
  const { text: raw, use } = await chat(system, `Task the agent was given:\n${task}\n\nDeliverable:\n${text}`);
  let parsed: unknown;
  try {
    parsed = firstJson(raw);
  } catch (err) {
    throw new LlmUnavailableError(`the agent model's extraction was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const claims = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { claims?: unknown })?.claims) ? (parsed as { claims: unknown[] }).claims : null;
  if (!claims) throw new LlmUnavailableError('the agent model\'s extraction carried no claims list');
  return { claims, raw, use };
}
