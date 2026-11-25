/**
 * Solana for WALLET_BALANCE_CHECK, TOKEN_TOTAL_SUPPLY_VERIFY and
 * CRYPTO_TRANSFER_VERIFY (routes /balance, /total-supply, /transfer).
 *
 * On 2026-11-25 no Telegraph miner answered a Solana wallet balance: the
 * top two returned a null balance, two refused the chain, and the node found
 * no compatible miner for a third. This module answers those questions on
 * Solana mainnet-beta and devnet with the same field names as the EVM
 * answers, read over public JSON-RPC at `finalized` commitment.
 *
 * Endpoints (tested live 2026-11-25):
 *  - mainnet: api.mainnet-beta.solana.com (Solana Labs, full history and
 *    indexed queries) and solana-rpc.publicnode.com (no indexed queries such
 *    as getTokenAccountsByOwner, and no old transactions).
 *  - devnet: api.devnet.solana.com only; publicnode's devnet endpoint did not
 *    answer and dRPC's needs a paid plan.
 *
 * Cross-checks: a figure is read from both mainnet endpoints. When both
 * answer at the same slot their figures must be equal, or nothing is
 * answered. Accounts move between slots, so when the endpoints answer at
 * different slots the first endpoint's figure is given at its slot, and the
 * source says what the second read where. A transaction is final and must
 * read the same wherever it is found. Nothing is estimated: a read that does
 * not answer is an upstream error, never a figure.
 */
import { IntentError } from '../types/index.js';

export type SolanaCluster = 'solana' | 'solana-devnet';

interface Endpoint { name: string; url: string; indexed: boolean }

const ENDPOINTS: Record<SolanaCluster, Endpoint[]> = {
  solana: [
    { name: 'api.mainnet-beta.solana.com', url: 'https://api.mainnet-beta.solana.com', indexed: true },
    { name: 'solana-rpc.publicnode.com', url: 'https://solana-rpc.publicnode.com', indexed: false },
  ],
  'solana-devnet': [
    { name: 'api.devnet.solana.com', url: 'https://api.devnet.solana.com', indexed: true },
  ],
};

const LABEL: Record<SolanaCluster, string> = { solana: 'Solana mainnet-beta', 'solana-devnet': 'Solana devnet' };

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Mints by symbol, each checked on-chain on 2026-11-25 (owner program and
 * decimals). USDC and USDT are Circle's and Tether's mainnet mints; PYUSD is
 * Paxos's Token-2022 mint; devnet USDC is the mint Circle's faucet sends.
 */
export const SOLANA_TOKENS: Record<SolanaCluster, Record<string, string>> = {
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  },
  'solana-devnet': {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes; null for text that is not base58. */
export function base58Decode(text: string): Uint8Array | null {
  let n = 0n;
  for (const ch of text) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of text) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/** A Solana account address: base58 of exactly 32 bytes. */
export function isSolanaAddress(text: string): boolean {
  const t = text.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) && base58Decode(t)?.length === 32;
}

/** A transaction signature: base58 of exactly 64 bytes. */
export function isSolanaSignature(text: string): boolean {
  const t = text.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(t) && base58Decode(t)?.length === 64;
}

/** The cluster a chain name means, or null when it names no Solana cluster. */
export function solanaCluster(raw: unknown): SolanaCluster | null {
  if (raw === undefined || raw === null) return null;
  const t = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (/^(solana-)?devnet$|^sol-devnet$|^solana-dev$/.test(t)) return 'solana-devnet';
  if (/^(solana|sol|solana-mainnet|solana-mainnet-beta|mainnet-beta|solana-mainnet-?beta)$/.test(t)) return 'solana';
  return null;
}

/** A Solana cluster named in free text ("… on Solana", "Solana devnet"), or null. */
export function solanaClusterInText(text: string): SolanaCluster | null {
  const q = text.toLowerCase();
  if (!/\bsolana\b/.test(q)) return null;
  return /\bdevnet\b/.test(q) ? 'solana-devnet' : 'solana';
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

class RpcError extends Error {}

async function rpc<T>(ep: Endpoint, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new RpcError(`${ep.name} ${method}: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? 'fetch failed'}`);
  }
  if (!res.ok) throw new RpcError(`${ep.name} ${method}: http ${res.status}`);
  const body = await res.json().catch(() => null) as { result?: T; error?: { message?: string } } | null;
  if (!body) throw new RpcError(`${ep.name} ${method}: unreadable reply`);
  if (body.error) throw new RpcError(`${ep.name} ${method}: ${body.error.message ?? 'rpc error'}`);
  return body.result as T;
}

interface Ctx<T> { context: { slot: number }; value: T }

/** One read from every endpoint that can serve it, settled. */
async function readAll<T>(cluster: SolanaCluster, read: (ep: Endpoint) => Promise<Ctx<T>>, indexedOnly = false) {
  const eps = ENDPOINTS[cluster].filter((e) => !indexedOnly || e.indexed);
  const settled = await Promise.allSettled(eps.map(read));
  return eps.map((ep, i) => ({ ep, r: settled[i]! }));
}

interface Agreed<V> { value: V; slot: number; source: string }

/**
 * Hold the endpoints' figures to each other. The first endpoint that answered
 * gives the figure; a second one at the same slot must agree exactly, or
 * nothing is answered. At another slot the account may have moved, so its
 * figure is reported in the source, not compared.
 */
function agree<V>(cluster: SolanaCluster, what: string, reads: Array<{ ep: Endpoint; r: PromiseSettledResult<Ctx<V>> }>, key: (v: V) => string): Agreed<V> {
  const ok = reads.filter((x): x is { ep: Endpoint; r: PromiseFulfilledResult<Ctx<V>> } => x.r.status === 'fulfilled');
  if (ok.length === 0) {
    const why = reads.map((x) => (x.r as PromiseRejectedResult).reason?.message ?? 'no answer').join('; ');
    throw new IntentError('UPSTREAM_RPC_ERROR', `no ${LABEL[cluster]} endpoint answered ${what}: ${why}`);
  }
  const [first, ...rest] = ok;
  const v = first!.r.value;
  const notes: string[] = [`${first!.ep.name} at slot ${v.context.slot}`];
  for (const o of rest) {
    const w = o.r.value;
    if (w.context.slot === v.context.slot) {
      if (key(w.value) !== key(v.value)) {
        throw new IntentError('UPSTREAM_RPC_ERROR', `${LABEL[cluster]} endpoints disagree on ${what} at slot ${v.context.slot}: ${first!.ep.name} read ${key(v.value)}, ${o.ep.name} read ${key(w.value)}; no figure is given`);
      }
      notes.push(`${o.ep.name} agreed at the same slot`);
    } else if (key(w.value) === key(v.value)) {
      notes.push(`${o.ep.name} read the same at slot ${w.context.slot}`);
    } else {
      notes.push(`${o.ep.name} read ${key(w.value)} at slot ${w.context.slot}, a different slot, so the two were not compared`);
    }
  }
  const failed = reads.filter((x) => x.r.status === 'rejected').map((x) => `${x.ep.name} did not answer`);
  return { value: v.value, slot: v.context.slot, source: [...notes, ...failed].join('; ') };
}

/** The block time of a slot as ISO text; null when the cluster has none for it. */
async function slotTime(cluster: SolanaCluster, slot: number): Promise<string | null> {
  for (const ep of ENDPOINTS[cluster]) {
    try {
      const t = await rpc<number | null>(ep, 'getBlockTime', [slot]);
      if (typeof t === 'number') return new Date(t * 1000).toISOString();
    } catch { /* next endpoint */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mints
// ---------------------------------------------------------------------------

interface Mint { address: string; decimals: number; program: 'Token' | 'Token-2022'; symbol: string | null; supplyRaw: bigint }

type ParsedMint = { owner: string; data: { parsed?: { type?: string; info?: { decimals?: number; supply?: string; extensions?: Array<{ extension: string; state?: any }> } } } } | null;

/**
 * Exact decimal text of raw base units, no floats.
 */
export function unitsText(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** The mint a token reference names on the cluster: a mint address, or a symbol in SOLANA_TOKENS. */
export function mintAddressOf(cluster: SolanaCluster, ref: string): string {
  const t = ref.trim();
  const paren = [...t.matchAll(/\(([^()\s]+)\)/g)].at(-1)?.[1];
  const addr = t.split(/[\s()]+/).find(isSolanaAddress);
  if (addr) return addr;
  const sym = (paren ?? t).toUpperCase();
  const known = SOLANA_TOKENS[cluster][sym];
  if (known) return known;
  const table = Object.keys(SOLANA_TOKENS[cluster]).join(', ');
  throw new IntentError('INVALID_INPUT', `"${t}" is not a Solana mint address, nor a symbol in the verified table for ${LABEL[cluster]} (${table}); give the token's mint address`);
}

/** Read a mint, held to the endpoints' agreement on supply and decimals. */
async function readMint(cluster: SolanaCluster, address: string): Promise<{ mint: Mint; slot: number; source: string }> {
  const reads = await readAll<ParsedMint>(cluster, (ep) => rpc(ep, 'getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'finalized' }]));
  const got = agree(cluster, `mint ${address}`, reads, (v) => (v ? `${v.owner}/${v.data?.parsed?.info?.decimals}/${v.data?.parsed?.info?.supply}` : 'no account'));
  const acct = got.value;
  if (!acct) throw new IntentError('INVALID_INPUT', `${address} has no account on ${LABEL[cluster]} at slot ${got.slot}, so it is no token mint there`);
  const program = acct.owner === TOKEN_PROGRAM ? 'Token' : acct.owner === TOKEN_2022_PROGRAM ? 'Token-2022' : null;
  const info = acct.data?.parsed?.info;
  if (!program || acct.data?.parsed?.type !== 'mint' || typeof info?.decimals !== 'number' || typeof info.supply !== 'string') {
    throw new IntentError('INVALID_INPUT', `${address} on ${LABEL[cluster]} is not an SPL token mint (owner ${acct.owner})`);
  }
  const meta = info.extensions?.find((e) => e.extension === 'tokenMetadata')?.state;
  const known = Object.entries(SOLANA_TOKENS[cluster]).find(([, a]) => a === address)?.[0] ?? null;
  const symbol = (typeof meta?.symbol === 'string' && meta.symbol.trim()) || known;
  return { mint: { address, decimals: info.decimals, program, symbol, supplyRaw: BigInt(info.supply) }, slot: got.slot, source: got.source };
}

// ---------------------------------------------------------------------------
// WALLET_BALANCE_CHECK
// ---------------------------------------------------------------------------

export interface SolanaBalanceInput { cluster: SolanaCluster; address: string; token: string }

export function validateSolanaBalanceInput(raw: Record<string, unknown>, cluster: SolanaCluster): SolanaBalanceInput {
  const query = typeof raw.query === 'string' ? raw.query : '';
  const address = String(raw.address ?? raw.wallet ?? query.split(/\s+/).find(isSolanaAddress) ?? '').trim();
  if (!address) throw new IntentError('INVALID_INPUT', 'address is required (a base58 Solana wallet address)');
  if (!isSolanaAddress(address)) throw new IntentError('INVALID_INPUT', `${address} is not a Solana address: give the base58 text of a 32-byte public key`);
  return { cluster, address, token: String(raw.token ?? raw.asset ?? '').trim() };
}

const isNativeSol = (t: string) => t === '' || /^(sol|native|wsol-native)$/i.test(t.trim());

type TokenAccounts = Array<{ pubkey: string; account: { owner: string; data: { parsed: { info: { mint: string; owner: string; tokenAmount: { amount: string; decimals: number } } } } } }>;

export async function handleSolanaBalance(input: SolanaBalanceInput) {
  const { cluster, address } = input;
  const label = LABEL[cluster];
  if (isNativeSol(input.token)) {
    const got = agree(cluster, `the SOL balance of ${address}`,
      await readAll<number>(cluster, (ep) => rpc(ep, 'getBalance', [address, { commitment: 'finalized' }])), (v) => String(v));
    const raw = BigInt(got.value);
    const exact = unitsText(raw, 9);
    const asOf = await slotTime(cluster, got.slot);
    const answer = `${address} holds ${exact} SOL on ${label} at slot ${got.slot} (finalized).`;
    return {
      answer, signal: answer,
      source: `${label} JSON-RPC getBalance, finalized: ${got.source}`,
      confidence: 0.99, address, chain: cluster, balance: Number(exact), token_symbol: 'SOL', as_of: asOf,
      balance_raw: raw.toString(), balance_exact: exact, decimals: 9, token_address: null,
      chainId: null, cluster, blockNumber: String(got.slot), slot: String(got.slot),
    };
  }
  const mintAddr = mintAddressOf(cluster, input.token);
  const { mint } = await readMint(cluster, mintAddr);
  // The owner's accounts for the mint, whichever program holds them, from the endpoint that serves indexed queries
  const listed = await readAll<TokenAccounts>(cluster, (ep) => rpc(ep, 'getTokenAccountsByOwner', [address, { mint: mintAddr }, { encoding: 'jsonParsed', commitment: 'finalized' }]), true);
  const found = agree(cluster, `the ${mint.symbol ?? mintAddr} accounts of ${address}`, listed, (v) => v.map((a) => `${a.pubkey}:${a.account.data.parsed.info.tokenAmount.amount}`).sort().join(','));
  const accounts = found.value.filter((a) => a.account.data.parsed.info.mint === mintAddr && a.account.data.parsed.info.owner === address);
  let raw = accounts.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  let source = `${label} JSON-RPC getTokenAccountsByOwner (mint filter, Token and Token-2022), finalized: ${found.source}`;
  // Cross-check the accounts' balances on the endpoints that do not serve indexed queries
  const others = ENDPOINTS[cluster].filter((e) => !e.indexed);
  if (accounts.length > 0 && others.length > 0) {
    const keys = accounts.map((a) => a.pubkey);
    type Accts = Ctx<Array<{ data: { parsed: { info: { tokenAmount: { amount: string } } } } } | null>>;
    // In chunks of 5 keys: publicnode refused (http 403) one request for 14 accounts on 2026-11-25 and served 5.
    const readChunks = async (ep: Endpoint): Promise<Accts> => {
      const parts: Accts[] = [];
      for (let i = 0; i < keys.length; i += 5) parts.push(await rpc<Accts>(ep, 'getMultipleAccounts', [keys.slice(i, i + 5), { encoding: 'jsonParsed', commitment: 'finalized' }]));
      const slots = new Set(parts.map((p) => p.context.slot));
      return { context: { slot: slots.size === 1 ? parts[0]!.context.slot : -1 }, value: parts.flatMap((p) => p.value) };
    };
    const checks = await Promise.allSettled(others.map(readChunks));
    checks.forEach((c, i) => {
      const ep = others[i]!;
      if (c.status === 'rejected') { source += `; ${ep.name} did not answer the account check (${c.reason?.message ?? 'no answer'})`; return; }
      const sum = c.value.value.reduce((s, a) => s + BigInt(a?.data?.parsed?.info?.tokenAmount?.amount ?? '0'), 0n);
      if (c.value.context.slot === found.slot && sum !== raw) {
        throw new IntentError('UPSTREAM_RPC_ERROR', `${label} endpoints disagree on the ${mint.symbol ?? mintAddr} balance of ${address} at slot ${found.slot}: ${raw} vs ${sum} base units; no figure is given`);
      }
      const at = c.value.context.slot < 0 ? 'across several slots' : `at slot ${c.value.context.slot}`;
      source += sum === raw ? `; ${ep.name} read the same ${accounts.length} account balance${accounts.length === 1 ? '' : 's'} ${at}` : `; ${ep.name} read ${sum} base units ${at}, not the same slot, so the two were not compared`;
    });
  }
  const exact = unitsText(raw, mint.decimals);
  const sym = mint.symbol ?? mintAddr;
  const asOf = await slotTime(cluster, found.slot);
  const answer = `${address} holds ${exact} ${sym} on ${label} at slot ${found.slot} (finalized), the sum of ${accounts.length} token account${accounts.length === 1 ? '' : 's'} for the ${mint.program} mint ${mintAddr}.`;
  return {
    answer, signal: answer, source, confidence: 0.99, address, chain: cluster,
    balance: Number(exact), token_symbol: sym, as_of: asOf,
    balance_raw: raw.toString(), balance_exact: exact, decimals: mint.decimals, token_address: mintAddr,
    token_program: mint.program, token_accounts: accounts.map((a) => a.pubkey),
    chainId: null, cluster, blockNumber: String(found.slot), slot: String(found.slot),
  };
}

// ---------------------------------------------------------------------------
// TOKEN_TOTAL_SUPPLY_VERIFY
// ---------------------------------------------------------------------------

export interface SolanaSupplyInput { cluster: SolanaCluster; token: string; ref: string }

export function validateSolanaSupplyInput(raw: Record<string, unknown>, cluster: SolanaCluster): SolanaSupplyInput {
  const token = String(raw.token ?? raw.query ?? '').replace(/\s+/g, ' ').trim();
  if (!token) throw new IntentError('INVALID_INPUT', 'token is required (a Solana mint address or symbol, and its chain)');
  const asked = token.match(/^what is the current total supply of (.+?),? in whole tokens\??$/i)?.[1] ?? token;
  const ref = asked.replace(/\s+on\s+solana(\s+(mainnet(-beta)?|devnet))?\s*$/i, '').trim();
  return { cluster, token, ref };
}

export async function handleSolanaSupply(input: SolanaSupplyInput) {
  const { cluster } = input;
  const label = LABEL[cluster];
  if (isNativeSol(input.ref)) throw new IntentError('INVALID_INPUT', `SOL is ${label}'s native coin, not an SPL mint; give an SPL token`);
  const mintAddr = mintAddressOf(cluster, input.ref);
  // The supply is the mint account's own field, read from every endpoint and held to agreement
  // (publicnode refuses getTokenSupply as an indexed request; getAccountInfo it serves).
  const { mint, slot, source } = await readMint(cluster, mintAddr);
  const got = { slot, source, value: { amount: mint.supplyRaw.toString(), decimals: mint.decimals } };
  const raw = mint.supplyRaw;
  const exact = unitsText(raw, mint.decimals);
  const sym = mint.symbol ?? mintAddr;
  const asOf = await slotTime(cluster, got.slot);
  const answer = `The total supply of ${sym} (${mintAddr}) on ${label} is ${exact} tokens at slot ${got.slot}, finalized (${raw} base units, ${got.value.decimals} decimals, ${mint.program} program).`;
  return {
    answer, signal: answer,
    source: `${label} JSON-RPC getAccountInfo of the mint (jsonParsed supply), finalized: ${got.source}`,
    confidence: 0.99, total_supply: Number(exact), token: sym, token_address: mintAddr, chain: cluster,
    total_supply_raw: raw.toString(), total_supply_exact: exact, decimals: got.value.decimals, token_program: mint.program,
    chainId: null, cluster, blockNumber: String(got.slot), slot: String(got.slot), as_of: asOf,
  };
}

// ---------------------------------------------------------------------------
// CRYPTO_TRANSFER_VERIFY
// ---------------------------------------------------------------------------

export interface SolanaTransferInput { cluster: SolanaCluster | null; signature: string }

/** A signature in tx_hash / signature / hash, else anywhere in the request's text. */
export function solanaSignatureIn(raw: Record<string, unknown>): string | null {
  const direct = raw.signature ?? raw.tx_hash ?? raw.txHash ?? raw.hash;
  if (typeof direct === 'string' && isSolanaSignature(direct)) return direct.trim();
  for (const v of Object.values(raw)) {
    if (typeof v !== 'string') continue;
    const hit = v.split(/[\s,;:()"'`]+/).find(isSolanaSignature);
    if (hit) return hit;
  }
  return null;
}

interface TokenBal { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string; decimals: number } }
interface SolTx {
  slot: number; blockTime: number | null; version?: unknown;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } };
}

export interface SolanaTokenMove { mint: string; symbol: string | null; owner: string; account: string; change_raw: string; change: string; decimals: number }

/** Net token change per token account, from the balances before and after (zero changes left out). */
export function tokenMoves(cluster: SolanaCluster, tx: SolTx): SolanaTokenMove[] {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const idx = new Set([...pre, ...post].map((b) => b.accountIndex));
  const moves: SolanaTokenMove[] = [];
  for (const i of [...idx].sort((a, b) => a - b)) {
    const a = pre.find((b) => b.accountIndex === i);
    const b = post.find((x) => x.accountIndex === i);
    const ref = b ?? a!;
    const change = BigInt(b?.uiTokenAmount.amount ?? '0') - BigInt(a?.uiTokenAmount.amount ?? '0');
    if (change === 0n) continue;
    const decimals = ref.uiTokenAmount.decimals;
    const symbol = Object.entries(SOLANA_TOKENS[cluster]).find(([, m]) => m === ref.mint)?.[0] ?? null;
    moves.push({ mint: ref.mint, symbol, owner: ref.owner ?? keys[i] ?? '', account: keys[i] ?? '', change_raw: change.toString(), change: unitsText(change, decimals), decimals });
  }
  return moves;
}

export async function handleSolanaTransfer(input: SolanaTransferInput) {
  const clusters: SolanaCluster[] = input.cluster ? [input.cluster] : ['solana', 'solana-devnet'];
  const sig = input.signature;
  for (const cluster of clusters) {
    const label = LABEL[cluster];
    const reads = await Promise.allSettled(ENDPOINTS[cluster].map((ep) => rpc<SolTx | null>(ep, 'getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])));
    const found = reads.flatMap((r, i) => (r.status === 'fulfilled' && r.value ? [{ ep: ENDPOINTS[cluster][i]!, tx: r.value }] : []));
    if (found.length === 0) {
      if (reads.every((r) => r.status === 'rejected')) {
        throw new IntentError('UPSTREAM_RPC_ERROR', `no ${label} endpoint answered getTransaction: ${reads.map((r) => (r as PromiseRejectedResult).reason?.message).join('; ')}`);
      }
      continue;
    }
    const [first, ...rest] = found;
    const tx = first!.tx;
    const fp = (t: SolTx) => `${t.slot}/${JSON.stringify(t.meta?.err ?? null)}/${t.meta?.fee}/${JSON.stringify(t.meta?.postTokenBalances ?? [])}`;
    for (const o of rest) {
      if (fp(o.tx) !== fp(tx)) throw new IntentError('UPSTREAM_RPC_ERROR', `${label} endpoints disagree on transaction ${sig}: ${first!.ep.name} and ${o.ep.name} return different slots, results or balances; no answer is given`);
    }
    const ok = tx.meta !== null && (tx.meta.err === null || tx.meta.err === undefined);
    const fee = BigInt(tx.meta?.fee ?? 0);
    const keys = tx.transaction.message.accountKeys;
    const feePayer = keys[0]?.pubkey ?? null;
    const moves = ok ? tokenMoves(cluster, tx) : [];
    // SOL moved, net of the fee the payer paid
    const solMoves = keys.map((k, i) => {
      const pre = BigInt(tx.meta?.preBalances[i] ?? 0);
      const post = BigInt(tx.meta?.postBalances[i] ?? 0);
      const change = post - pre + (i === 0 ? fee : 0n);
      return { account: k.pubkey, change_raw: change.toString(), change: unitsText(change, 9) };
    }).filter((m) => ok && m.change_raw !== '0');
    let tip: number | null = null;
    try { tip = await rpc<number>(ENDPOINTS[cluster][0]!, 'getSlot', [{ commitment: 'finalized' }]); } catch { tip = null; }
    const when = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
    const parts: string[] = [];
    parts.push(`Transaction ${sig} on ${label} ${ok ? 'succeeded' : `failed (${JSON.stringify(tx.meta?.err)}), so nothing it tried to move was transferred`}: it is finalized in slot ${tx.slot}${when ? ` (${when})` : ''}${tip !== null ? `, ${tip - tx.slot} slots before the finalized tip` : ''}.`);
    parts.push(`Fee paid: ${unitsText(fee, 9)} SOL by ${feePayer}.`);
    if (ok && moves.length > 0) {
      const bySent = moves.filter((m) => m.change_raw.startsWith('-'));
      const byGot = moves.filter((m) => !m.change_raw.startsWith('-'));
      const listed = byGot.slice(0, 5).map((g) => {
        const src = bySent.find((s) => s.mint === g.mint);
        return `${g.change} ${g.symbol ?? 'tokens'} of mint ${g.mint}${src ? ` from ${src.owner}` : ''} to ${g.owner}`;
      });
      parts.push(listed.length ? `Token transfers: ${listed.join('; ')}${byGot.length > 5 ? `, and ${byGot.length - 5} more` : ''}.` : `Token balances fell: ${bySent.map((s) => `${s.change} of mint ${s.mint} from ${s.owner}`).join('; ')}.`);
    } else if (ok) {
      parts.push('It moved no SPL tokens.');
    }
    const firstMove = moves.find((m) => !m.change_raw.startsWith('-'));
    const firstSrc = firstMove ? moves.find((m) => m.mint === firstMove.mint && m.change_raw.startsWith('-')) : undefined;
    return {
      answer: parts.join(' '),
      tx_hash: sig, signature: sig, status: ok ? 'confirmed' : 'reverted', settled: ok, chain: cluster,
      block_number: String(tx.slot), slot: String(tx.slot), block_time: when,
      confirmations: tip === null ? null : tip - tx.slot + 1, commitment: 'finalized',
      from: firstSrc?.owner ?? feePayer, to: firstMove?.owner ?? null,
      native_symbol: 'SOL', fee_total_native: unitsText(fee, 9), fee_lamports: fee.toString(),
      token_transfers: moves.filter((m) => !m.change_raw.startsWith('-')).slice(0, 5).map((m) => ({
        token: m.mint, symbol: m.symbol, from: moves.find((s) => s.mint === m.mint && s.change_raw.startsWith('-'))?.owner ?? null,
        to: m.owner, amount_raw: m.change_raw, amount: m.change,
      })),
      token_balance_changes: moves, sol_balance_changes: solMoves,
      token_transfer_count: moves.filter((m) => !m.change_raw.startsWith('-')).length,
      confidence: 0.99, checked_at: new Date().toISOString(),
      provenance: { cluster, method: 'getTransaction (jsonParsed, finalized)', endpoints: found.map((f) => f.ep.name), agreed: found.length > 1 },
    };
  }
  return {
    answer: `Transaction ${sig} is not finalized on ${clusters.map((c) => LABEL[c]).join(' or ')}: no endpoint returned it at finalized commitment. So this transfer cannot be verified as settled.`,
    tx_hash: sig, signature: sig, status: 'not_found', settled: false, chain: input.cluster ?? 'solana',
    confidence: 0.9, checked_at: new Date().toISOString(),
    provenance: { clusters, method: 'getTransaction (finalized)', endpoints: clusters.flatMap((c) => ENDPOINTS[c].map((e) => e.name)) },
  };
}

// ---------------------------------------------------------------------------
// Routing: does a request ask about Solana?
// ---------------------------------------------------------------------------

/** The cluster a balance request names: its chain, else a base58 address with no chain given. */
export function solanaBalanceCluster(body: Record<string, unknown>): SolanaCluster | null {
  const chainRaw = body.chain ?? body.network;
  if (chainRaw !== undefined && String(chainRaw).trim() !== '') return solanaCluster(chainRaw);
  const query = typeof body.query === 'string' ? body.query : '';
  const fromText = query ? solanaClusterInText(query) : null;
  if (fromText) return fromText;
  const address = String(body.address ?? body.wallet ?? '').trim();
  return address && isSolanaAddress(address) ? 'solana' : null;
}

/** The cluster a supply request names: its chain, else "on Solana" in the token text, else a base58 mint. */
export function solanaSupplyCluster(body: Record<string, unknown>): SolanaCluster | null {
  const chainRaw = body.chain ?? body.network;
  if (chainRaw !== undefined && String(chainRaw).trim() !== '') return solanaCluster(chainRaw);
  const token = String(body.token ?? body.query ?? '');
  const on = token.match(/\son\s+(.+?)\s*\??$/i)?.[1];
  if (on && solanaClusterInText(on)) return solanaClusterInText(on);
  return token.split(/[\s()]+/).some(isSolanaAddress) && !/0x[0-9a-f]{40}/i.test(token) ? 'solana' : null;
}

/** A transfer request about Solana: a Solana chain, or a base58 signature (the cluster is then searched). */
export function solanaTransferRequest(body: Record<string, unknown>): SolanaTransferInput | null {
  const chainRaw = body.chain ?? body.network;
  const named = chainRaw !== undefined && String(chainRaw).trim() !== '' ? solanaCluster(chainRaw) : null;
  if (chainRaw !== undefined && String(chainRaw).trim() !== '' && !named) return null;
  const signature = solanaSignatureIn(body);
  if (!signature) {
    if (named) throw new IntentError('INVALID_INPUT', 'no Solana transaction signature given: send signature (base58, 64 bytes), or a question containing one');
    return null;
  }
  const texts = Object.values(body).filter((v): v is string => typeof v === 'string').join(' ');
  return { cluster: named ?? solanaClusterInText(texts), signature };
}
