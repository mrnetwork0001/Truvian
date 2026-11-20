/**
 * Telegraph transport for Truvian Shield.
 *
 * Turns a Shield intent (GAS_PRICE / ONCHAIN_TX_LOOKUP / CRYPTO_PRICE /
 * TVL_LOOKUP) into a request to LIVE Telegraph miners and returns a uniform
 * IntentResult.
 *
 * Telegraph V2 (verified against the live node, 2026-11-19):
 *  - Intents were renamed (GAS_PRICE_GENERAL, ONCHAIN_TX_LOOKUP_GENERAL,
 *    CRYPTO_PRICE_USD, TVL_LOOKUP_GENERAL). Asking for the Season I names
 *    finds no miner, which is why Shield returned empty checks after V2.
 *  - A request names the intent and its typed params (POST /engine/v1/ask)
 *    and the node routes it to its ranked miner. Shield no longer picks
 *    miners itself on the paid routes.
 *  - `result` is the intent's response format, the same keys whichever miner
 *    answered (`result_shape: "intent"`), not the miner's own JSON.
 *
 * Three transports:
 *  - 'x402'   - the routed ask, paid per request with an x402 v2 exact-scheme
 *               payment (signed EIP-3009 TransferWithAuthorization, base64 in
 *               PAYMENT-SIGNATURE) from TELEGRAPH_PAYER_KEY. The node offers
 *               several networks; Shield pays on the one its wallet is funded
 *               on (X402_CHAIN_ID, default Base Sepolia). See X402-NOTES.md.
 *  - 'apikey' - the same routed ask through Anjoman's API with
 *               TELEGRAPH_API_KEY, paid from that account's escrow balance.
 *               No wallet and no settlement per call.
 *  - 'direct' - calls a live miner on its public base_url from the node's
 *               FREE catalog (GET /api/miners). Unpaid dev/fallback mode,
 *               labeled in IntentResult.transport.
 *
 * When the configured paid route fails and the other one is configured too,
 * the other is tried once. This module never throws: total failure returns
 * an IntentResult whose answer starts with 'unavailable:'.
 */
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PrivateKeyAccount } from 'viem';

export type ShieldIntent = 'GAS_PRICE' | 'ONCHAIN_TX_LOOKUP' | 'CRYPTO_PRICE' | 'TVL_LOOKUP';

type Transport = 'x402' | 'apikey' | 'direct';

export interface IntentResult {
  answer: string;
  minerId?: string;
  minerName?: string;
  costUsd?: number;
  signalHash?: string;
  latencyMs: number;
  transport: Transport;
  /** The intent's V2 response fields, when the node returned them in that shape */
  fields?: Record<string, unknown>;
  raw: unknown;
}

const NODE_URL = (process.env.TELEGRAPH_NODE_URL ?? 'https://devnode.telegraphprotocol.com').replace(/\/+$/, '');
const CATALOG_URL = `${NODE_URL}/api/miners`;
const API_URL = (process.env.TELEGRAPH_API_URL ?? 'https://backend.telegraphprotocol.com').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 10_000;
/** The API route answers after the node has routed and the miner has replied; 12 s was observed. */
const API_KEY_TIMEOUT_MS = 90_000;
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
    name: 'ChainSight - On-Chain Intelligence Hub',
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
// Route planning - deterministic candidate list per intent
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
  const score = (m.scores ?? []).find((s) => s.intent_id === V2_INTENT[intent] || s.intent_id === intent);
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
      (m.supported_intents ?? []).some((name) => name === V2_INTENT[intent] || name === intent) &&
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
// The facilitator rejects overlapping authorizations from one payer
// ("batch_send_failed: missing_or_invalid_parameters…" - observed when four
// checks paid at once), so payments are serialized per process. A check with
// four paid intents costs ~4 sequential round-trips (~10 s), well inside the
// proxy timeout, and nothing is lost to a rejected batch.
let paymentQueue: Promise<unknown> = Promise.resolve();
const PAYMENT_RETRY_DELAY_MS = 800;

async function x402Fetch(url: string, init: RequestInit, account: PrivateKeyAccount): Promise<X402FetchResult> {
  const run = paymentQueue.then(() => x402FetchUnlocked(url, init, account));
  paymentQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function x402FetchUnlocked(url: string, init: RequestInit, account: PrivateKeyAccount): Promise<X402FetchResult> {
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (first.status !== 402) return { res: first };

  const challenge = parseChallenge(first);
  if (!challenge) throw new Error('402 without a parsable PAYMENT-REQUIRED header');
  // V2 offers the same price on several networks (Ethereum Sepolia first,
  // then Base Sepolia, then Solana). Pay on the one the payer wallet holds
  // USDC on; taking the first EVM option signed a payment from an empty
  // balance.
  const exactEvm = (challenge.accepts ?? []).filter(
    (a) => a.scheme === 'exact' && typeof a.network === 'string' && a.network.startsWith('eip155:'),
  );
  const funded = `eip155:${process.env.X402_CHAIN_ID ?? '84532'}`;
  const requirement = exactEvm.find((a) => a.network === funded) ?? exactEvm[0];
  if (!requirement) throw new Error('402 challenge offers no exact EVM payment option');
  const amount = BigInt(requirement.amount ?? '0');
  const cap = maxPaymentAtomic();
  if (amount > cap) throw new Error(`x402 price ${amount} exceeds cap ${cap} atomic USDC`);

  // A fresh authorization (new nonce) per attempt; one retry if the
  // facilitator rejects the first.
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, PAYMENT_RETRY_DELAY_MS));
    const paymentHeader = await buildPaymentSignature(account, challenge, requirement);
    const headers = new Headers(init.headers);
    headers.set('PAYMENT-SIGNATURE', paymentHeader);
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status !== 402) break;
  }
  if (!res) throw new Error('x402: no response');

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
// Telegraph V2: intent names, typed params, and the response format
// ---------------------------------------------------------------------------

/** What Telegraph V2 calls each Shield intent (GET /engine/v1/intents, read 2026-11-19). */
export const V2_INTENT: Record<ShieldIntent, string> = {
  GAS_PRICE: 'GAS_PRICE_GENERAL',
  ONCHAIN_TX_LOOKUP: 'ONCHAIN_TX_LOOKUP_GENERAL',
  CRYPTO_PRICE: 'CRYPTO_PRICE_USD',
  TVL_LOOKUP: 'TVL_LOOKUP_GENERAL',
};

/** The typed params each intent's input schema takes (GET /engine/v1/intents/<name> -> request.params). */
export function v2Params(intent: ShieldIntent, params: Record<string, string>): Record<string, string> {
  switch (intent) {
    case 'GAS_PRICE':
      return { chain: params.chain ?? 'base' };
    case 'ONCHAIN_TX_LOOKUP':
      return { tx_hash: params.hash ?? '', chain: params.chain ?? 'base' };
    case 'CRYPTO_PRICE':
      return { symbol: (params.symbol ?? '').toUpperCase() };
    case 'TVL_LOOKUP':
      return { protocol: params.protocol ?? '' };
  }
}

/** A finite number from a field the node typed as a number (it may arrive as a numeric string). */
function fieldNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Plain decimal text for a number, never exponent form ("1.1e-8" reads as "8 gwei" to a text parser). */
function plainNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

function usd(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return `$${int!.replace(/\B(?=(\d{3})+$)/g, ',')}.${dec}`;
}

/**
 * State an intent's V2 response fields as one sentence.
 *
 * The verdict engine and the dashboard both work from an answer in words,
 * which is what miners returned before V2. V2 returns typed fields, so the
 * sentence is written here, from those fields only and in a fixed wording:
 * the same fields always give the same sentence. Returns null when the
 * field the check depends on is absent, so that a missing value is never
 * phrased as if it had been reported.
 */
export function composeAnswer(intent: ShieldIntent, fields: Record<string, unknown>, sent: Record<string, string>): string | null {
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  switch (intent) {
    case 'GAS_PRICE': {
      const gwei = fieldNumber(fields.gas_price_gwei);
      if (gwei === null) return null;
      return `The current gas price on ${text(fields.chain) ?? sent.chain} is ${plainNumber(gwei)} gwei.`;
    }
    case 'CRYPTO_PRICE': {
      const price = fieldNumber(fields.price_usd);
      if (price === null) return null;
      return `The current price of ${sent.symbol} is ${usd(price)}.`;
    }
    case 'TVL_LOOKUP': {
      const tvl = fieldNumber(fields.tvl_usd);
      if (tvl === null) return null;
      return `The total value locked of ${text(fields.protocol_or_chain) ?? sent.protocol} is ${usd(tvl)}.`;
    }
    case 'ONCHAIN_TX_LOOKUP': {
      const status = text(fields.status);
      if (status === null) return null;
      const hash = text(fields.tx_hash) ?? sent.tx_hash;
      const chain = sent.chain;
      if (status === 'not_found') return `Transaction ${hash} was not found on ${chain}.`;
      if (status === 'pending') return `Transaction ${hash} on ${chain} is pending and not yet included in a block.`;
      const block = fieldNumber(fields.block_number);
      const from = text(fields.from);
      const to = text(fields.to);
      const value = fieldNumber(fields.value_eth);
      const outcome = status === 'reverted' ? 'reverted' : 'was confirmed';
      return [
        `Transaction ${hash} on ${chain} ${outcome}${block !== null ? ` in block ${block}` : ''}.`,
        from !== null || to !== null ? `It was sent${from !== null ? ` from ${from}` : ''}${to !== null ? ` to ${to}` : ''}${value !== null ? ` with a value of ${plainNumber(value)} native coins` : ''}.` : '',
      ].filter(Boolean).join(' ');
    }
  }
}

/** The routed ask through the engine, paid by x402. */
async function askRoutedX402(
  intent: ShieldIntent,
  sent: Record<string, string>,
  account: PrivateKeyAccount,
): Promise<{ body: unknown; headers: Headers; paidAtomic?: bigint; settlement?: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  const paid = await x402Fetch(
    `${NODE_URL}/engine/v1/ask`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: V2_INTENT[intent], params: sent }) },
    account,
  );
  const body = await readBody(paid.res);
  if (!paid.res.ok) {
    const settleReason = asRecord(paid.settlement)?.errorReason;
    const hint = typeof settleReason === 'string' ? `payment rejected: ${settleReason}` : typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`http ${paid.res.status}: ${hint.slice(0, 200)}`);
  }
  const out: { body: unknown; headers: Headers; paidAtomic?: bigint; settlement?: unknown; latencyMs: number } = {
    body, headers: paid.res.headers, latencyMs: Date.now() - startedAt,
  };
  if (paid.paidAtomic !== undefined) out.paidAtomic = paid.paidAtomic;
  if (paid.settlement !== undefined) out.settlement = paid.settlement;
  return out;
}

/** Most the API route may reserve for one question. The node reserves $0.26 and bills the calls it uses (about $0.01). */
function apiKeyMaxSpendUsd(): number {
  const n = Number(process.env.SHIELD_API_KEY_MAX_SPEND_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.3;
}

/**
 * Anjoman runs at most three jobs per account at once and answers a fourth
 * with 429 "You already have 3 jobs running" (observed 2026-11-19). A safety
 * check asks four intents, so requests wait here for a slot instead.
 */
const API_KEY_CONCURRENCY = Math.max(1, Number(process.env.SHIELD_API_KEY_CONCURRENCY) || 3);
let apiKeyActive = 0;
const apiKeyWaiting: Array<() => void> = [];

async function apiKeySlot(): Promise<() => void> {
  if (apiKeyActive >= API_KEY_CONCURRENCY) await new Promise<void>((resolve) => apiKeyWaiting.push(resolve));
  apiKeyActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    apiKeyActive--;
    apiKeyWaiting.shift()?.();
  };
}

/**
 * Stop a job once Shield has what it needs. A job keeps running after its
 * stream is closed (the agent goes on to write a prose answer for several
 * seconds) and holds one of the account's three slots until it ends.
 * Cancelling does not change what is billed: the miner call is paid either way.
 */
async function cancelApiKeyJob(jobId: string, key: string): Promise<void> {
  try {
    await fetch(`${API_URL}/agent/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // the job ends on its own; only the slot is held a little longer
  }
}

/**
 * The routed ask through Anjoman's API (POST /agent/chat with intent +
 * params). The reply is an event stream; the `trace` event carries the
 * node's own envelope for the miner call, which is all Shield needs, so the
 * job is cancelled as soon as it arrives.
 */
async function askRoutedApiKey(
  v2Intent: string,
  sent: Record<string, unknown>,
  key: string,
  question: string,
): Promise<{ body: unknown; headers: Headers; latencyMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + API_KEY_TIMEOUT_MS;
  const release = await apiKeySlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, deadline - Date.now()));
  let jobId: string | null = null;
  try {
    let res: Response;
    for (;;) {
      res = await fetch(`${API_URL}/agent/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, intent: v2Intent, params: sent, maxSpendUsd: apiKeyMaxSpendUsd() }),
        signal: controller.signal,
      });
      // Another process (or a slot not yet freed by a cancel) may hold the account's jobs: wait and retry.
      if (res.status !== 429 || Date.now() + 2_000 > deadline) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (!res.ok || !res.body) {
      const body = await readBody(res);
      throw new Error(`http ${res.status}: ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        if (event !== 'job' && event !== 'trace' && event !== 'error' && event !== 'done') continue;
        let data: unknown;
        try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
        const record = asRecord(data);
        if (event === 'job') {
          if (typeof record?.jobId === 'string') jobId = record.jobId;
          continue;
        }
        if (event === 'error') throw new Error(`api error: ${String(record?.message ?? 'unknown').slice(0, 200)}`);
        if (event === 'done') {
          jobId = null; // already finished, nothing to cancel
          throw new Error(`api finished without a miner answer: ${String(record?.status ?? 'unknown')}`);
        }
        const step = asRecord(Array.isArray(record?.steps) ? record.steps[0] : null);
        if (!step) continue;
        if (step.status === 'answered' && asRecord(step.result)) {
          return { body: step.result, headers: res.headers, latencyMs: Date.now() - startedAt };
        }
        if (step.status === 'failed') {
          const attempt = asRecord(Array.isArray(step.attempts) ? step.attempts[0] : null);
          throw new Error(`miner step failed: ${String(attempt?.error ?? step.reason ?? 'unknown').slice(0, 200)}`);
        }
      }
    }
    throw new Error('api stream ended without a miner answer');
  } finally {
    clearTimeout(timer);
    controller.abort(); // leave the stream
    if (jobId) await cancelApiKeyJob(jobId, key);
    release();
  }
}

/**
 * The API-key ask, retried once when the failure was in the plumbing rather
 * than in the answer. Both seen live on 2026-11-19:
 *  - one of four parallel streams ended with "terminated" (the server closed
 *    it) while the other three answered
 *  - two of four questions failed with "Payment was rejected by the
 *    facilitator. Please try again." while the other two were paid and
 *    answered in the same second
 * A miner that answered badly is not retried: that is a real answer.
 */
async function askApiKeyWithRetry(
  v2Intent: string,
  sent: Record<string, unknown>,
  key: string,
  question: string,
): Promise<{ body: unknown; headers: Headers; latencyMs: number }> {
  const transient = (message: string) =>
    /^(terminated|fetch failed)$|^http 5\d\d|api stream ended without a miner answer|payment was rejected by the facilitator/i.test(message);
  // Two retries with a short backoff: on 2026-11-20 one liquidity ask was
  // refused by the facilitator twice in a row, a second apart.
  for (let attempt = 0; ; attempt++) {
    try {
      return await askRoutedApiKey(v2Intent, sent, key, question);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= 2 || !transient(message)) throw err;
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
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
  fields?: Record<string, unknown>;
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
function parseAnswerBody(body: unknown, headers: Headers, v2?: { intent: ShieldIntent; sent: Record<string, string> }): ParsedBody {
  const record = asRecord(body);
  if (!record) {
    const text = typeof body === 'string' ? body.trim() : JSON.stringify(body);
    return { answer: truncate(text || 'empty response') };
  }

  const out: ParsedBody = { answer: '' };
  const envelopeResult = 'result' in record ? record.result : undefined;
  const inner = asRecord(envelopeResult) ?? record;

  if (v2 && record.result_shape === 'intent' && asRecord(envelopeResult)) {
    // V2: `result` is the intent's response format. Say it in words, from the fields alone.
    out.fields = inner;
    const composed = composeAnswer(v2.intent, inner, v2.sent);
    const status = asRecord(record.field_status);
    out.answer = truncate(
      composed ??
        `unavailable: the miner's answer did not carry the value this check needs (field status: ${JSON.stringify(status ?? {})})`,
    );
  } else {
    let answer = firstString(inner, ANSWER_FIELDS);
    if (!answer && typeof envelopeResult === 'string') answer = envelopeResult.trim();
    if (!answer) answer = firstString(record, ANSWER_FIELDS);
    out.answer = truncate(answer ?? JSON.stringify(inner));
  }

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
// askIntent - the Shield-facing entry point
// ---------------------------------------------------------------------------

function apiKey(): string | null {
  const key = process.env.TELEGRAPH_API_KEY?.trim();
  return key ? key : null;
}

/**
 * The transport Shield uses: SHIELD_TRANSPORT when set, otherwise the API key
 * when one is configured, then x402, then direct.
 *
 * The API key comes before x402 because x402 "exact" payments to the node
 * have failed at settlement since 17 November (the facilitator times out:
 * telegraphprotocol/bounties#214), on both Base Sepolia and Ethereum Sepolia.
 */
export function resolveTransport(): Transport {
  const forced = process.env.SHIELD_TRANSPORT;
  if (forced === 'x402' || forced === 'apikey' || forced === 'direct') return forced;
  if (apiKey()) return 'apikey';
  return process.env.TELEGRAPH_PAYER_KEY ? 'x402' : 'direct';
}

/**
 * Balance the API-key route is paid from (Anjoman escrow, effectiveBalance),
 * in whole dollars; null when there is no key or it cannot be read.
 */
export async function apiKeyBalanceUsd(): Promise<number | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${API_URL}/engine/escrow/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = asRecord(await res.json());
    const n = Number(body?.effectiveBalance);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
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

function unavailable(transport: Transport, reason: string, startedAt: number, detail: unknown): IntentResult {
  return {
    answer: `unavailable: ${reason}`,
    latencyMs: Date.now() - startedAt,
    transport,
    raw: { status: 'error', reason, detail },
  };
}

async function executeCall(
  call: PlannedCall,
  transport: Transport,
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
    // The engine's direct-ask route wraps the miner's answer in the node
    // envelope ({miner_id, result, cost_usd, signal_hash, …}); the dispatcher
    // route returns bare miner JSON with no signal hash. Prefer the engine and
    // fall back to the dispatcher if the engine refuses the call shape.
    const route = process.env.SHIELD_X402_ROUTE === 'dispatcher' ? 'dispatcher' : 'engine';
    let paid: X402FetchResult | undefined;
    if (route === 'engine') {
      const engineUrl = `${NODE_URL}/engine/v1/ask/${call.minerId}`;
      const engineInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: call.method,
          endpoint: call.path,
          payload: call.method === 'GET' ? call.query : (call.body ?? {}),
        }),
      };
      paid = await x402Fetch(engineUrl, engineInit, account);
      if (paid.res.status >= 400 && paid.res.status !== 402) paid = undefined; // shape refused: use dispatcher
    }
    if (!paid) paid = await x402Fetch(url, init, account);
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
    const key = apiKey();
    if (transport === 'apikey' && !key) {
      return unavailable(transport, 'apikey transport selected but TELEGRAPH_API_KEY is not set', startedAt, null);
    }

    if (transport !== 'direct') {
      // Paid routes: name the V2 intent and let the node route to its ranked
      // miner. The configured route first, then the other if it is set up.
      const sent = v2Params(intent, params);
      const routes: Array<'x402' | 'apikey'> = transport === 'x402' ? ['x402', 'apikey'] : ['apikey', 'x402'];
      const failures: Array<{ route: string; error: string }> = [];
      for (const route of routes) {
        if (route === 'x402' && !account) continue;
        if (route === 'apikey' && !key) continue;
        try {
          const done: { body: unknown; headers: Headers; paidAtomic?: bigint; settlement?: unknown; latencyMs: number } =
            route === 'x402'
              ? await askRoutedX402(intent, sent, account!)
              : await askApiKeyWithRetry(V2_INTENT[intent], sent, key!, questionFor(intent, params));
          const parsed = parseAnswerBody(done.body, done.headers, { intent, sent });
          let raw: unknown = done.body;
          if (done.settlement !== undefined) {
            const record = asRecord(done.body);
            raw = record ? { ...record, _x402Settlement: done.settlement } : { body: done.body, _x402Settlement: done.settlement };
          }
          const result: IntentResult = { answer: parsed.answer, latencyMs: done.latencyMs, transport: route, raw };
          if (parsed.minerId) result.minerId = parsed.minerId;
          if (parsed.minerName) result.minerName = parsed.minerName;
          if (parsed.fields) result.fields = parsed.fields;
          if (parsed.signalHash) result.signalHash = parsed.signalHash;
          if (parsed.costUsd !== undefined) result.costUsd = parsed.costUsd;
          else if (done.paidAtomic !== undefined) result.costUsd = Number(done.paidAtomic) / USDC_ATOMIC_PER_USD;
          return result;
        } catch (err) {
          failures.push({ route, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const summary = failures.map((f) => `${f.route}: ${f.error}`).join('; ');
      return unavailable(transport, `Telegraph did not answer ${V2_INTENT[intent]} - ${summary}`, startedAt, { failures });
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
    return unavailable(transport, `all ${failures.length} miner attempt(s) failed - ${summary}`, startedAt, { failures });
  } catch (err) {
    return unavailable(transport, err instanceof Error ? err.message : String(err), startedAt, null);
  }
}

// ---------------------------------------------------------------------------
// askTypedIntent - any V2 intent, for the preflight and listing desks
// ---------------------------------------------------------------------------

/** One answer to a V2 intent, as the node returned it. */
export interface TypedAnswer {
  /** The V2 intent name asked, e.g. SECURITY_REVIEW_GENERAL */
  intent: string;
  /** The params sent, exactly */
  params: Record<string, unknown>;
  /** True when the node returned the intent's response fields */
  ok: boolean;
  /** The intent's response fields (`result` with result_shape "intent"), null when there are none */
  fields: Record<string, unknown> | null;
  /** The node's state for each field: ok, missing, rejected, ... */
  fieldStatus: Record<string, string>;
  minerId?: string;
  minerName?: string;
  /** What the answer was billed, in USD */
  costUsd?: number;
  /** Telegraph signal hash, resolvable at GET /engine/v1/signal/{hash} */
  signalHash?: string;
  latencyMs: number;
  /** Why there is no answer, when ok is false */
  error?: string;
}

/**
 * Ask any V2 intent by name with its typed params (GET /engine/v1/intents/<name>
 * -> request.params). The node routes the ask to its ranked miner once: one
 * paid call per question, not the same fact bought from several miners.
 *
 * Paid from the API key's escrow. The x402 route is not used here because its
 * settlement has failed since 17 November (bounties#214). Never throws.
 */
export async function askTypedIntent(intent: string, params: Record<string, unknown>, question: string): Promise<TypedAnswer> {
  const startedAt = Date.now();
  const key = apiKey();
  if (!key) {
    return { intent, params, ok: false, fields: null, fieldStatus: {}, latencyMs: 0, error: 'TELEGRAPH_API_KEY is not set, so no paid Telegraph request can be made' };
  }
  try {
    const done = await askApiKeyWithRetry(intent, params, key, question);
    const record = asRecord(done.body) ?? {};
    const fields = record.result_shape === 'intent' ? asRecord(record.result) : null;
    const status = asRecord(record.field_status) ?? {};
    const fieldStatus: Record<string, string> = {};
    for (const [name, state] of Object.entries(status)) fieldStatus[name] = String(state);
    const out: TypedAnswer = { intent, params, ok: fields !== null, fields, fieldStatus, latencyMs: done.latencyMs };
    const minerId = record.miner_id ?? record.minerId;
    if (typeof minerId === 'string' || typeof minerId === 'number') out.minerId = String(minerId);
    const minerName = firstString(record, ['miner_name', 'minerName']);
    if (minerName) out.minerName = minerName;
    const cost = record.cost_usd ?? record.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) out.costUsd = cost;
    const signalHash = firstString(record, ['signal_hash', 'signalHash']);
    if (signalHash) out.signalHash = signalHash;
    if (!out.ok) out.error = `the node returned no ${intent} response fields`;
    return out;
  } catch (err) {
    return {
      intent, params, ok: false, fields: null, fieldStatus: {}, latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
