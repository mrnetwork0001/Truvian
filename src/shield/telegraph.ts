/**
 * Telegraph transport for Truvian Shield.
 *
 * Turns a Shield intent (GAS_PRICE / ONCHAIN_TX_LOOKUP / CRYPTO_PRICE /
 * TVL_LOOKUP) into a call against a LIVE Telegraph miner and returns a
 * uniform IntentResult. Two transports:
 *
 *  - 'x402'   — pays through the Telegraph node's miner dispatcher
 *               (POST|GET /miner-dispatcher/v1/{minerId}{path}) with an
 *               x402 v2 exact-scheme payment: USDC on Base Sepolia via a
 *               signed EIP-3009 TransferWithAuthorization, sent base64 in
 *               the PAYMENT-SIGNATURE header. Wire format verified against
 *               the live node's 402 challenge and the x402 v2 spec
 *               (see src/shield/X402-NOTES.md).
 *  - 'direct' — calls the same live miners on their public base_url from
 *               the node's FREE catalog (GET /api/miners). Still real
 *               Telegraph miners — dev/fallback mode, labeled in
 *               IntentResult.transport.
 *
 * Routing is deterministic: candidates come from the free catalog at
 * request time (60s cache), our own miner 8453 first for its two intents,
 * then curated known-good miners, then the rest ordered by their current
 * leaderboard rank for the intent. One retry to a different miner; 10s
 * timeout per request; this module never throws — total failure returns an
 * IntentResult whose answer starts with 'unavailable:'.
 */
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PrivateKeyAccount } from 'viem';

export type ShieldIntent = 'GAS_PRICE' | 'ONCHAIN_TX_LOOKUP' | 'CRYPTO_PRICE' | 'TVL_LOOKUP';

export interface IntentResult {
  answer: string;
  minerId?: string;
  minerName?: string;
  costUsd?: number;
  signalHash?: string;
  latencyMs: number;
  transport: 'x402' | 'direct';
  raw: unknown;
}

const NODE_URL = (process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com').replace(/\/+$/, '');
const CATALOG_URL = `${NODE_URL}/api/miners`;
const REQUEST_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 60_000;
/** First attempt + one retry to a different miner. */
const MAX_ATTEMPTS = 2;
const USDC_ATOMIC_PER_USD = 1_000_000;
/** Refuse to sign x402 payments above this many USD per request. */
const MAX_PAYMENT_USD_DEFAULT = 0.1;
const ANSWER_MAX_LEN = 600;

// ---------------------------------------------------------------------------
// Free miner catalog (GET /api/miners)
// ---------------------------------------------------------------------------

interface CatalogEndpoint {
  path?: string;
  method?: string;
  description?: string;
}

interface CatalogScore {
  intent_id?: string;
  rank?: number;
  score?: number;
}

interface CatalogMiner {
  id?: string;
  name?: string;
  base_url?: string;
  activation_status?: string;
  supported_intents?: string[];
  endpoints?: CatalogEndpoint[];
  input_schema?: { properties?: Record<string, unknown>; required?: string[] };
  scores?: CatalogScore[];
  total_requests_served?: number;
}

let catalogCache: { at: number; miners: CatalogMiner[] } | null = null;

/**
 * Minimal static fallback so Shield stays functional if the free catalog is
 * briefly unreachable. Same live miners the catalog listed at build time.
 */
const STATIC_MINERS: CatalogMiner[] = [
  {
    id: '8453',
    name: 'Truvian Exact On-Chain Truth Engine',
    base_url: 'https://miner.truvian.xyz',
    activation_status: 'active',
    supported_intents: ['ONCHAIN_TX_LOOKUP', 'GAS_PRICE'],
  },
  {
    id: '302',
    name: 'ChainSight — On-Chain Intelligence Hub',
    base_url: 'https://hub.shadrakbessanh.me',
    activation_status: 'active',
    supported_intents: ['CRYPTO_PRICE', 'TVL_LOOKUP', 'GAS_PRICE', 'ONCHAIN_TX_LOOKUP'],
  },
  {
    id: '7322',
    name: 'FinWire TVL Lookup',
    base_url: 'https://telegraph-fin.margyn.workers.dev',
    activation_status: 'active',
    supported_intents: ['TVL_LOOKUP'],
  },
  {
    id: '900',
    name: 'OnChain Intel Miner',
    base_url: 'https://telegraph-onchain-miner-production.up.railway.app',
    activation_status: 'active',
    supported_intents: ['GAS_PRICE', 'ONCHAIN_TX_LOOKUP', 'CRYPTO_PRICE', 'TVL_LOOKUP'],
  },
];

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http ${res.status} from ${url}`);
  return res.json();
}

async function loadCatalog(): Promise<CatalogMiner[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.miners;
  try {
    const body = await fetchJson(CATALOG_URL);
    if (Array.isArray(body) && body.length > 0) {
      catalogCache = { at: now, miners: body as CatalogMiner[] };
      return catalogCache.miners;
    }
  } catch {
    // fall through to whatever we have
  }
  return catalogCache?.miners ?? STATIC_MINERS;
}

// ---------------------------------------------------------------------------
// Route planning — deterministic candidate list per intent
// ---------------------------------------------------------------------------

interface PlannedCall {
  minerId: string;
  minerName: string;
  baseUrl: string;
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  mainnet: 1,
  eth: 1,
  'base-sepolia': 84532,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
};

/** Natural-language form of the request, for miners that take ?query=. */
function questionFor(intent: ShieldIntent, params: Record<string, string>): string {
  switch (intent) {
    case 'GAS_PRICE':
      return `What is the current gas price on ${params.chain ?? 'base'}?`;
    case 'ONCHAIN_TX_LOOKUP':
      return `What is the status of transaction ${params.hash ?? ''} on ${params.chain ?? 'base'}?`;
    case 'CRYPTO_PRICE':
      return `What is the current price of ${params.symbol ?? ''} in USD?`;
    case 'TVL_LOOKUP':
      return `What is the total value locked of ${params.protocol ?? ''}?`;
  }
}

/**
 * Known-good per-miner routes, verified against the live catalog and the
 * dispatcher OpenAPI. Checked before the generic catalog-driven mapping.
 */
function curatedCall(minerId: string, intent: ShieldIntent, params: Record<string, string>): { path: string; query: Record<string, string> } | null {
  const chain = params.chain ?? 'base';
  const table: Record<string, Partial<Record<ShieldIntent, { path: string; query: Record<string, string> }>>> = {
    '8453': {
      GAS_PRICE: { path: '/gas', query: { chain } },
      ONCHAIN_TX_LOOKUP: { path: '/tx', query: { chain, hash: params.hash ?? '' } },
    },
    '302': {
      GAS_PRICE: { path: '/gas', query: { chain } },
      ONCHAIN_TX_LOOKUP: { path: '/tx', query: { chain, hash: params.hash ?? '' } },
      CRYPTO_PRICE: { path: '/price', query: { symbol: params.symbol ?? '' } },
      TVL_LOOKUP: { path: '/tvl', query: { protocol: params.protocol ?? '' } },
    },
    '900': {
      GAS_PRICE: { path: '/gas-price', query: { chain } },
      ONCHAIN_TX_LOOKUP: { path: '/tx', query: { chain, hash: params.hash ?? '' } },
      CRYPTO_PRICE: { path: '/price', query: { symbol: params.symbol ?? '' } },
      TVL_LOOKUP: { path: '/tvl', query: { protocol: params.protocol ?? '' } },
    },
    '9010': {
      ONCHAIN_TX_LOOKUP: { path: '/lookup', query: { chain, tx_hash: params.hash ?? '' } },
    },
    '7322': {
      TVL_LOOKUP: { path: '/tvl', query: { protocol: params.protocol ?? '' } },
    },
    '147117': {
      CRYPTO_PRICE: { path: '/price', query: { symbol: (params.symbol ?? '').toUpperCase(), vs_currency: 'USD' } },
    },
  };
  return table[minerId]?.[intent] ?? null;
}

/** Preferred ordering per intent; our miner 8453 leads its two intents. */
const PRIORITY: Record<ShieldIntent, string[]> = {
  GAS_PRICE: ['8453', '302', '900'],
  ONCHAIN_TX_LOOKUP: ['8453', '302', '9010', '900'],
  CRYPTO_PRICE: ['302', '147117', '900'],
  TVL_LOOKUP: ['302', '7322', '900'],
};

const INTENT_ENDPOINT_HINT: Record<ShieldIntent, RegExp> = {
  GAS_PRICE: /GAS_PRICE|gas.?price/i,
  ONCHAIN_TX_LOOKUP: /ONCHAIN_TX_LOOKUP|transaction|lookup|\/tx\b/i,
  CRYPTO_PRICE: /CRYPTO_PRICE|price/i,
  TVL_LOOKUP: /TVL/i,
};

function isPublicHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

function rankFor(m: CatalogMiner, intent: ShieldIntent): number {
  const score = (m.scores ?? []).find((s) => s.intent_id === intent);
  return typeof score?.rank === 'number' ? score.rank : Number.MAX_SAFE_INTEGER;
}

/**
 * Catalog-driven mapping for miners without a curated route: pick the
 * endpoint whose path/description matches the intent, then fill parameters
 * from the miner's declared input_schema.
 */
function genericCall(m: CatalogMiner, intent: ShieldIntent, params: Record<string, string>): PlannedCall | null {
  const minerId = m.id;
  if (!minerId || !isPublicHttpUrl(m.base_url)) return null;
  const endpoints = (m.endpoints ?? []).filter((e) => typeof e.path === 'string');
  if (endpoints.length === 0) return null;
  const hint = INTENT_ENDPOINT_HINT[intent];
  const noGas = intent === 'CRYPTO_PRICE' ? /gas/i : null;
  const endpoint =
    endpoints.length === 1
      ? endpoints[0]
      : endpoints.find((e) => {
          const text = `${e.path} ${e.description ?? ''}`;
          return hint.test(text) && !(noGas && noGas.test(e.path ?? ''));
        });
  if (!endpoint?.path) return null;

  const props = m.input_schema?.properties ?? {};
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(props, k);
  const fields: Record<string, string> = {};
  const chain = params.chain ?? 'base';
  if (has('chain')) fields.chain = chain;
  const hash = params.hash;
  if (hash) {
    if (has('hash')) fields.hash = hash;
    else if (has('tx_hash')) fields.tx_hash = hash;
    else if (has('txHash')) fields.txHash = hash;
  }
  const symbol = params.symbol;
  if (symbol && has('symbol')) fields.symbol = symbol.toUpperCase();
  if (has('vs_currency') && (m.input_schema?.required ?? []).includes('vs_currency')) fields.vs_currency = 'USD';
  const protocol = params.protocol;
  if (protocol && has('protocol')) fields.protocol = protocol;
  if (has('query')) fields.query = questionFor(intent, params);
  else if (has('question')) fields.question = questionFor(intent, params);

  const method = (endpoint.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const call: PlannedCall = {
    minerId,
    minerName: m.name ?? minerId,
    baseUrl: m.base_url.replace(/\/+$/, ''),
    method,
    path: endpoint.path,
    query: method === 'GET' ? fields : {},
  };
  if (method === 'POST') {
    const body: Record<string, unknown> = { ...fields };
    if (has('chainId')) {
      const chainId = CHAIN_IDS[chain.toLowerCase()];
      if (chainId !== undefined) body.chainId = chainId;
    }
    if (!('query' in body) && !('question' in body)) body.query = questionFor(intent, params);
    call.body = body;
  }
  return call;
}

/** Deterministic candidate list: priority miners first, then by intent rank. */
function planCandidates(intent: ShieldIntent, params: Record<string, string>, miners: CatalogMiner[]): PlannedCall[] {
  const active = miners.filter(
    (m) =>
      typeof m.id === 'string' &&
      (m.activation_status ?? 'active') === 'active' &&
      (m.supported_intents ?? []).includes(intent) &&
      isPublicHttpUrl(m.base_url),
  );
  const byId = new Map(active.map((m) => [m.id as string, m]));
  const ordered: CatalogMiner[] = [];
  for (const id of PRIORITY[intent]) {
    const m = byId.get(id);
    if (m) {
      ordered.push(m);
      byId.delete(id);
    }
  }
  ordered.push(...[...byId.values()].sort((a, b) => rankFor(a, intent) - rankFor(b, intent)));

  const calls: PlannedCall[] = [];
  for (const m of ordered) {
    const minerId = m.id as string;
    const curated = curatedCall(minerId, intent, params);
    if (curated && m.base_url) {
      calls.push({
        minerId,
        minerName: m.name ?? minerId,
        baseUrl: m.base_url.replace(/\/+$/, ''),
        method: 'GET',
        path: curated.path,
        query: curated.query,
      });
      continue;
    }
    const generic = genericCall(m, intent, params);
    if (generic) calls.push(generic);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// x402 v2 payment (exact scheme, EIP-3009 on USDC Base Sepolia)
// ---------------------------------------------------------------------------

interface PaymentRequirement {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

interface PaymentChallenge {
  x402Version?: number;
  error?: string;
  resource?: unknown;
  extensions?: unknown;
  accepts?: PaymentRequirement[];
}

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function parseChallenge(res: Response): PaymentChallenge | null {
  const header = res.headers.get('payment-required');
  if (!header) return null;
  try {
    return decodeBase64Json(header) as PaymentChallenge;
  } catch {
    return null;
  }
}

function maxPaymentAtomic(): bigint {
  const raw = process.env.SHIELD_MAX_PAYMENT_USDC;
  const usd = raw ? Number(raw) : MAX_PAYMENT_USD_DEFAULT;
  if (!Number.isFinite(usd) || usd <= 0) return BigInt(Math.round(MAX_PAYMENT_USD_DEFAULT * USDC_ATOMIC_PER_USD));
  return BigInt(Math.round(usd * USDC_ATOMIC_PER_USD));
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Sign the chosen requirement and build the base64 PAYMENT-SIGNATURE value. */
async function buildPaymentSignature(
  account: PrivateKeyAccount,
  challenge: PaymentChallenge,
  requirement: PaymentRequirement,
): Promise<string> {
  const network = requirement.network ?? '';
  const chainIdMatch = /^eip155:(\d+)$/.exec(network);
  if (!chainIdMatch?.[1]) throw new Error(`unsupported x402 network ${network}`);
  const chainId = Number(chainIdMatch[1]);
  if (!requirement.asset || !requirement.payTo || !requirement.amount) {
    throw new Error('x402 challenge missing asset/payTo/amount');
  }
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 600);
  const validBefore = BigInt(now + Math.max(60, Math.min(requirement.maxTimeoutSeconds ?? 600, 600)));
  const value = BigInt(requirement.amount);
  const nonce = `0x${randomBytes(32).toString('hex')}` as Hex;

  const signature = await account.signTypedData({
    domain: {
      name: requirement.extra?.name ?? 'USDC',
      version: requirement.extra?.version ?? '2',
      chainId,
      verifyingContract: requirement.asset as Address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: requirement.payTo as Address,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const paymentPayload: Record<string, unknown> = {
    x402Version: challenge.x402Version ?? 2,
    accepted: requirement,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  if (challenge.resource !== undefined) paymentPayload.resource = challenge.resource;
  if (challenge.extensions !== undefined) paymentPayload.extensions = challenge.extensions;
  return Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
}

interface X402FetchResult {
  res: Response;
  paidAtomic?: bigint;
  settlement?: unknown;
}

/**
 * fetch() that answers an x402 v2 402 challenge: parse the PAYMENT-REQUIRED
 * header, sign an exact-scheme EIP-3009 authorization, retry once with the
 * PAYMENT-SIGNATURE header, and surface the PAYMENT-RESPONSE settlement.
 */
async function x402Fetch(url: string, init: RequestInit, account: PrivateKeyAccount): Promise<X402FetchResult> {
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (first.status !== 402) return { res: first };

  const challenge = parseChallenge(first);
  if (!challenge) throw new Error('402 without a parsable PAYMENT-REQUIRED header');
  const requirement = (challenge.accepts ?? []).find(
    (a) => a.scheme === 'exact' && typeof a.network === 'string' && a.network.startsWith('eip155:'),
  );
  if (!requirement) throw new Error('402 challenge offers no exact EVM payment option');
  const amount = BigInt(requirement.amount ?? '0');
  const cap = maxPaymentAtomic();
  if (amount > cap) throw new Error(`x402 price ${amount} exceeds cap ${cap} atomic USDC`);

  const paymentHeader = await buildPaymentSignature(account, challenge, requirement);
  const headers = new Headers(init.headers);
  headers.set('PAYMENT-SIGNATURE', paymentHeader);
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  let settlement: unknown;
  const settleHeader = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
  if (settleHeader) {
    try {
      settlement = decodeBase64Json(settleHeader);
    } catch {
      settlement = settleHeader;
    }
  }
  const result: X402FetchResult = { res, paidAtomic: amount };
  if (settlement !== undefined) result.settlement = settlement;
  return result;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

const ANSWER_FIELDS = ['answer', 'signal', 'summary', 'canonical', 'message', 'text'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function truncate(text: string): string {
  return text.length > ANSWER_MAX_LEN ? `${text.slice(0, ANSWER_MAX_LEN - 1)}…` : text;
}

interface ParsedBody {
  answer: string;
  minerId?: string;
  minerName?: string;
  costUsd?: number;
  signalHash?: string;
}

/**
 * Extract the text answer plus envelope metadata. Handles both the node's
 * envelope shape ({miner_id, miner_name, result, cost_usd, signal_hash, …})
 * and bare miner JSON (answer | signal | summary fields, else compact JSON).
 */
function parseAnswerBody(body: unknown, headers: Headers): ParsedBody {
  const record = asRecord(body);
  if (!record) {
    const text = typeof body === 'string' ? body.trim() : JSON.stringify(body);
    return { answer: truncate(text || 'empty response') };
  }

  const out: ParsedBody = { answer: '' };
  const envelopeResult = 'result' in record ? record.result : undefined;
  const inner = asRecord(envelopeResult) ?? record;

  let answer = firstString(inner, ANSWER_FIELDS);
  if (!answer && typeof envelopeResult === 'string') answer = envelopeResult.trim();
  if (!answer) answer = firstString(record, ANSWER_FIELDS);
  out.answer = truncate(answer ?? JSON.stringify(inner));

  const minerId = record.miner_id ?? record.minerId;
  if (typeof minerId === 'string' || typeof minerId === 'number') out.minerId = String(minerId);
  const minerName = firstString(record, ['miner_name', 'minerName']);
  if (minerName) out.minerName = minerName;
  const cost = record.cost_usd ?? record.costUsd;
  if (typeof cost === 'number' && Number.isFinite(cost)) out.costUsd = cost;
  const signalHash =
    firstString(record, ['signal_hash', 'signalHash']) ??
    firstString(inner, ['signal_hash', 'signalHash']) ??
    headers.get('signal-hash') ??
    headers.get('x-signal-hash') ??
    undefined;
  if (signalHash) out.signalHash = signalHash;
  return out;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// askIntent — the Shield-facing entry point
// ---------------------------------------------------------------------------

function resolveTransport(): 'x402' | 'direct' {
  const forced = process.env.SHIELD_TRANSPORT;
  if (forced === 'x402' || forced === 'direct') return forced;
  return process.env.TELEGRAPH_PAYER_KEY ? 'x402' : 'direct';
}

function payerAccount(): PrivateKeyAccount | null {
  const key = process.env.TELEGRAPH_PAYER_KEY?.trim();
  if (!key) return null;
  try {
    return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  } catch {
    return null;
  }
}

function requiredParamFor(intent: ShieldIntent): string | null {
  if (intent === 'ONCHAIN_TX_LOOKUP') return 'hash';
  if (intent === 'CRYPTO_PRICE') return 'symbol';
  if (intent === 'TVL_LOOKUP') return 'protocol';
  return null;
}

function unavailable(transport: 'x402' | 'direct', reason: string, startedAt: number, detail: unknown): IntentResult {
  return {
    answer: `unavailable: ${reason}`,
    latencyMs: Date.now() - startedAt,
    transport,
    raw: { status: 'error', reason, detail },
  };
}

async function executeCall(
  call: PlannedCall,
  transport: 'x402' | 'direct',
  account: PrivateKeyAccount | null,
): Promise<{ body: unknown; headers: Headers; paidAtomic?: bigint; settlement?: unknown; latencyMs: number }> {
  const qs = new URLSearchParams(call.query).toString();
  const base = transport === 'x402' ? `${NODE_URL}/miner-dispatcher/v1/${call.minerId}${call.path}` : `${call.baseUrl}${call.path}`;
  const url = qs ? `${base}?${qs}` : base;
  const init: RequestInit = { method: call.method };
  if (call.method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(call.body ?? {});
  }

  const startedAt = Date.now();
  let res: Response;
  let paidAtomic: bigint | undefined;
  let settlement: unknown;
  if (transport === 'x402') {
    if (!account) throw new Error('TELEGRAPH_PAYER_KEY is not set or invalid');
    const paid = await x402Fetch(url, init, account);
    res = paid.res;
    paidAtomic = paid.paidAtomic;
    settlement = paid.settlement;
  } else {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
  const body = await readBody(res);
  if (!res.ok) {
    // A rejected x402 payment answers 402 again with the reason in the
    // PAYMENT-RESPONSE settlement (e.g. invalid_exact_evm_insufficient_balance).
    const settleReason = asRecord(settlement)?.errorReason;
    const hint = typeof settleReason === 'string' ? `payment rejected: ${settleReason}` : typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`http ${res.status}: ${hint.slice(0, 160)}`);
  }
  const out: { body: unknown; headers: Headers; paidAtomic?: bigint; settlement?: unknown; latencyMs: number } = {
    body,
    headers: res.headers,
    latencyMs: Date.now() - startedAt,
  };
  if (paidAtomic !== undefined) out.paidAtomic = paidAtomic;
  if (settlement !== undefined) out.settlement = settlement;
  return out;
}

/**
 * Ask one Shield intent against live Telegraph miners.
 * params by intent: GAS_PRICE {chain}; ONCHAIN_TX_LOOKUP {chain, hash};
 * CRYPTO_PRICE {symbol}; TVL_LOOKUP {protocol}. Never throws.
 */
export async function askIntent(intent: ShieldIntent, params: Record<string, string>): Promise<IntentResult> {
  const startedAt = Date.now();
  const transport = resolveTransport();
  try {
    const required = requiredParamFor(intent);
    if (required && !params[required]) {
      return unavailable(transport, `missing required param '${required}' for ${intent}`, startedAt, { params });
    }
    const account = payerAccount();
    if (transport === 'x402' && !account) {
      return unavailable(transport, 'x402 transport selected but TELEGRAPH_PAYER_KEY is not set or invalid', startedAt, null);
    }

    const miners = await loadCatalog();
    const candidates = planCandidates(intent, params, miners);
    if (candidates.length === 0) {
      return unavailable(transport, `no active Telegraph miner serves ${intent}`, startedAt, { catalogSize: miners.length });
    }

    const failures: Array<{ minerId: string; error: string }> = [];
    for (const call of candidates.slice(0, MAX_ATTEMPTS)) {
      try {
        const done = await executeCall(call, transport, account);
        const parsed = parseAnswerBody(done.body, done.headers);
        let raw: unknown = done.body;
        if (done.settlement !== undefined) {
          const record = asRecord(done.body);
          raw = record ? { ...record, _x402Settlement: done.settlement } : { body: done.body, _x402Settlement: done.settlement };
        }
        const result: IntentResult = {
          answer: parsed.answer,
          minerId: parsed.minerId ?? call.minerId,
          minerName: parsed.minerName ?? call.minerName,
          latencyMs: done.latencyMs,
          transport,
          raw,
        };
        if (parsed.signalHash) result.signalHash = parsed.signalHash;
        if (parsed.costUsd !== undefined) result.costUsd = parsed.costUsd;
        else if (done.paidAtomic !== undefined) result.costUsd = Number(done.paidAtomic) / USDC_ATOMIC_PER_USD;
        else if (transport === 'direct') result.costUsd = 0;
        return result;
      } catch (err) {
        failures.push({ minerId: call.minerId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const summary = failures.map((f) => `${f.minerId}: ${f.error}`).join('; ');
    return unavailable(transport, `all ${failures.length} miner attempt(s) failed — ${summary}`, startedAt, { failures });
  } catch (err) {
    return unavailable(transport, err instanceof Error ? err.message : String(err), startedAt, null);
  }
}
