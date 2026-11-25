/**
 * Solana chain reads for Shield's Solana desks (settlement assurance and the
 * Solana holdings proof). Direct JSON-RPC, never Telegraph: these are the
 * reads a bought answer is checked against.
 *
 * Mainnet reads go to two providers and must agree (a mint's authorities and
 * extensions exactly; a balance exactly, read at finalized commitment). Devnet
 * has one public endpoint that answers (2026-11-25: publicnode's devnet hosts
 * do not resolve, Helius needs a key), so devnet reads name one source.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export type SolanaNetwork = 'solana' | 'solana-devnet';

export const SOLANA_RPCS: Record<SolanaNetwork, string[]> = {
  solana: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  'solana-devnet': ['https://api.devnet.solana.com'],
};

export const SOLANA_LABEL: Record<SolanaNetwork, string> = { solana: 'Solana', 'solana-devnet': 'Solana devnet' };

/** Mints the desks name by symbol (Circle's devnet USDC is the one its faucet gives). */
export const KNOWN_MINTS: Record<SolanaNetwork, Record<string, string>> = {
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  },
  'solana-devnet': {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    // Shield's own devnet test tokens (src/scripts/solana-devnet-fixtures.ts, 2026-11-25)
    TUSD: 'DThEeRe6uhj2eT8SLrjiLexUiuxrggysA4zCuHE2sUFb',
    RUSD: 'B6yxPoHwxdThmbJ9C58TXF2TK3JYzsC2R6ggFdUvAz1v',
  },
};

export class SolanaInputError extends Error {}
export class SolanaReadError extends Error {}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseSolanaNetwork(v: unknown): SolanaNetwork {
  const s = String(v ?? 'solana-devnet').trim().toLowerCase();
  if (s === 'solana' || s === 'solana-mainnet' || s === 'mainnet-beta') return 'solana';
  if (s === 'solana-devnet' || s === 'devnet') return 'solana-devnet';
  throw new SolanaInputError(`network must be "solana" or "solana-devnet", not "${s}"`);
}

export function parseSolanaAddress(v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (!BASE58.test(s)) throw new SolanaInputError(`${what} must be a base58 Solana address`);
  try {
    return new PublicKey(s).toBase58();
  } catch {
    throw new SolanaInputError(`${what} is not a valid Solana address`);
  }
}

/** A mint by address, or by a symbol this file knows on that network. */
export function parseMint(network: SolanaNetwork, v: unknown): string {
  const s = String(v ?? '').trim();
  const known = KNOWN_MINTS[network][s.toUpperCase()];
  return known ?? parseSolanaAddress(s, 'token mint');
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<{ result: T; slot: number | null }> {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `http ${res.status}`;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new SolanaReadError(`${method} at ${new URL(url).host}: ${body.error.message ?? 'error'}`);
      const r = body.result as { context?: { slot?: number }; value?: unknown } | unknown;
      const ctx = typeof r === 'object' && r !== null && 'context' in r ? (r as { context?: { slot?: number } }).context : undefined;
      return { result: (ctx ? (r as { value: unknown }).value : r) as T, slot: ctx?.slot ?? null };
    } catch (err) {
      if (err instanceof SolanaReadError) throw err;
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new SolanaReadError(`${method} at ${new URL(url).host} failed: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export interface MintExtension {
  extension: string;
  state: Record<string, unknown>;
}

export interface MintRead {
  network: SolanaNetwork;
  mint: string;
  /** False when the account is missing or is not a token mint */
  isMint: boolean;
  program: 'spl-token' | 'spl-token-2022' | null;
  decimals: number | null;
  /** Raw supply, exact integer text */
  supplyRaw: string | null;
  /** Supply in whole tokens, exact decimal text */
  supply: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extensions as the chain reports them */
  extensions: MintExtension[];
  slot: number | null;
  sources: string[];
}

interface ParsedMintAccount {
  owner: string;
  data: { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } } | [string, string];
}

export function wholeUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

function mintFrom(network: SolanaNetwork, mint: string, acct: ParsedMintAccount | null, slot: number | null, source: string): MintRead {
  const empty: MintRead = { network, mint, isMint: false, program: null, decimals: null, supplyRaw: null, supply: null, mintAuthority: null, freezeAuthority: null, extensions: [], slot, sources: [source] };
  if (!acct || Array.isArray(acct.data)) return empty;
  const program = acct.owner === TOKEN_2022_PROGRAM_ID.toBase58() ? 'spl-token-2022' : acct.owner === TOKEN_PROGRAM_ID.toBase58() ? 'spl-token' : null;
  const parsed = acct.data.parsed;
  if (!program || parsed?.type !== 'mint' || !parsed.info) return empty;
  const info = parsed.info;
  const decimals = Number(info.decimals);
  const supplyRaw = String(info.supply ?? '');
  return {
    network, mint, isMint: true, program, decimals,
    supplyRaw,
    supply: /^\d+$/.test(supplyRaw) ? wholeUnits(BigInt(supplyRaw), decimals) : null,
    mintAuthority: typeof info.mintAuthority === 'string' ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null,
    extensions: Array.isArray(info.extensions) ? (info.extensions as MintExtension[]).map((e) => ({ extension: String(e.extension), state: (e.state ?? {}) as Record<string, unknown> })) : [],
    slot, sources: [source],
  };
}

/** The mint's configuration, which must read the same from every source. */
function mintConfig(m: MintRead): string {
  const stable = m.extensions.map((e) => {
    // A transfer-fee config's withheld amount moves with every transfer: not configuration
    const { withheldAmount: _w, ...rest } = e.state;
    return { extension: e.extension, state: rest };
  });
  return JSON.stringify([m.isMint, m.program, m.decimals, m.mintAuthority, m.freezeAuthority, stable]);
}

export async function readMint(network: SolanaNetwork, mint: string): Promise<MintRead> {
  const urls = SOLANA_RPCS[network];
  const reads = await Promise.all(urls.map(async (url) => {
    const { result, slot } = await rpc<ParsedMintAccount | null>(url, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    return mintFrom(network, mint, result, slot, `${new URL(url).host} getAccountInfo (finalized)`);
  }));
  const first = reads[0]!;
  for (const r of reads.slice(1)) {
    if (mintConfig(r) !== mintConfig(first)) throw new SolanaReadError(`the RPC providers disagree about mint ${mint}: ${first.sources[0]} and ${r.sources[0]} return different configurations`);
  }
  // Supply moves with every mint and burn; report the highest slot's read, naming both sources
  const latest = reads.reduce((a, b) => ((b.slot ?? 0) > (a.slot ?? 0) ? b : a));
  return { ...latest, sources: reads.map((r) => r.sources[0]!) };
}

// ---------------------------------------------------------------------------
// Restrictions: what an issuer can still do to a holder's tokens
// ---------------------------------------------------------------------------

export type RestrictionLevel = 'block' | 'review' | 'info';

export interface Restriction {
  key: string;
  level: RestrictionLevel;
  title: string;
  detail: string;
}

/**
 * What the mint lets its issuer or a third party do to the recipient's tokens,
 * from the mint itself. Pure. An institution receiving the asset must know
 * each of these before it accepts a settlement in it.
 */
export function mintRestrictions(m: MintRead, amountRaw: bigint | null = null): Restriction[] {
  const out: Restriction[] = [];
  const short = (a: unknown) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a));
  if (m.freezeAuthority) out.push({ key: 'freeze_authority', level: 'info', title: 'Issuer can freeze holders', detail: `Freeze authority ${m.freezeAuthority} can freeze any account holding this token, the recipient's included. Regulated stablecoins keep one; it is disclosed, not a fault.` });
  if (m.mintAuthority) out.push({ key: 'mint_authority', level: 'info', title: 'Supply can grow', detail: `Mint authority ${m.mintAuthority} can mint more tokens.` });
  for (const e of m.extensions) {
    const s = e.state;
    switch (e.extension) {
      case 'permanentDelegate':
        if (s.delegate) out.push({ key: 'permanent_delegate', level: 'review', title: 'Issuer can take tokens back', detail: `Permanent delegate ${s.delegate} can transfer or burn tokens out of ANY account of this mint without the holder's signature, so a settlement received in it can be reversed by ${short(s.delegate)}. A person must accept that before release.` });
        break;
      case 'transferHook':
        if (s.programId) out.push({ key: 'transfer_hook', level: 'review', title: 'Every transfer runs outside code', detail: `Transfer hook program ${s.programId} runs on every transfer and can make one fail or behave differently; its code is not part of the token program.` });
        break;
      case 'transferFeeConfig': {
        const fee = (s.newerTransferFee ?? {}) as { transferFeeBasisPoints?: number; maximumFee?: number | string };
        const bps = Number(fee.transferFeeBasisPoints ?? 0);
        if (bps > 0) {
          const max = BigInt(String(fee.maximumFee ?? '0'));
          let detail = `A ${bps} bps fee is withheld on every transfer (maximum ${m.decimals !== null ? wholeUnits(max, m.decimals) : max} tokens), so the recipient receives less than is sent.`;
          if (amountRaw !== null && m.decimals !== null) {
            let feeRaw = (amountRaw * BigInt(bps) + 9999n) / 10000n;
            if (feeRaw > max) feeRaw = max;
            detail += ` On this settlement: ${wholeUnits(feeRaw, m.decimals)} withheld.`;
          }
          out.push({ key: 'transfer_fee', level: 'review', title: `Transfer fee ${bps} bps`, detail });
        } else if (s.transferFeeConfigAuthority) {
          out.push({ key: 'transfer_fee_authority', level: 'info', title: 'Issuer can switch on a transfer fee', detail: `The fee is 0 today, but ${s.transferFeeConfigAuthority} can set one.` });
        }
        break;
      }
      case 'nonTransferable':
        out.push({ key: 'non_transferable', level: 'block', title: 'Token cannot be transferred', detail: 'The mint is non-transferable: no settlement can be made in it.' });
        break;
      case 'defaultAccountState':
        if (String(s.accountState).toLowerCase() === 'frozen') out.push({ key: 'default_frozen', level: 'review', title: 'New accounts start frozen', detail: 'A new token account for this mint is frozen until the issuer thaws it, so the recipient may not be able to use what it receives.' });
        break;
      case 'pausableConfig':
        if (s.paused === true) out.push({ key: 'paused', level: 'block', title: 'Token is paused', detail: `The pause authority ${s.authority ?? ''} has paused all transfers.` });
        else out.push({ key: 'pausable', level: 'info', title: 'Issuer can pause transfers', detail: `Pause authority ${s.authority ?? '-'} can stop all transfers.` });
        break;
      case 'confidentialTransferMint':
        out.push({ key: 'confidential_transfer', level: 'info', title: 'Confidential transfers enabled', detail: `Amounts can move in encrypted form${s.auditorElgamalPubkey ? ', with an auditor key' : ', with no auditor key set'}; a confidential balance is not visible in a plain balance read.` });
        break;
      case 'mintCloseAuthority':
        if (s.closeAuthority) out.push({ key: 'mint_close_authority', level: 'info', title: 'Mint can be closed', detail: `${s.closeAuthority} can close the mint once supply is zero.` });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface BalanceRead {
  owner: string;
  mint: string;
  /** Sum over all the owner's accounts of this mint, exact integer text */
  raw: string;
  whole: string;
  accounts: Array<{ address: string; raw: string; frozen: boolean }>;
  slot: number | null;
  sources: string[];
}

interface ParsedTokenAccount {
  pubkey: string;
  account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string }; state?: string } } } };
}

async function balanceFrom(url: string, owner: string, mint: string, decimals: number): Promise<BalanceRead> {
  const { result, slot } = await rpc<ParsedTokenAccount[]>(url, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  const accounts = (result ?? []).map((a) => ({
    address: a.pubkey,
    raw: String(a.account.data.parsed?.info?.tokenAmount?.amount ?? '0'),
    frozen: a.account.data.parsed?.info?.state === 'frozen',
  })).sort((x, y) => x.address.localeCompare(y.address));
  const raw = accounts.reduce((s, a) => s + BigInt(a.raw), 0n);
  return { owner, mint, raw: raw.toString(), whole: wholeUnits(raw, decimals), accounts, slot, sources: [`${new URL(url).host} getTokenAccountsByOwner (finalized)`] };
}

/**
 * The owner's balance of a mint. The first provider lists the owner's
 * accounts of the mint (getTokenAccountsByOwner, an indexed call the second
 * provider does not serve); every other provider re-reads those same
 * accounts by address (getMultipleAccounts) and must find the same total.
 * One retry for a balance that moved between reads.
 */
export async function readBalance(network: SolanaNetwork, owner: string, mint: string, decimals: number): Promise<BalanceRead> {
  const [primary, ...others] = SOLANA_RPCS[network];
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await balanceFrom(primary!, owner, mint, decimals);
    if (others.length === 0 || listed.accounts.length === 0) return listed;
    const checks = await Promise.all(others.map(async (url) => {
      type Acct = { data: { parsed?: { info?: { tokenAmount?: { amount?: string }; owner?: string; mint?: string } } } } | null;
      const result: Acct[] = [];
      let slot: number | null = null;
      // publicnode serves at most 10 accounts per call
      for (let i = 0; i < listed.accounts.length; i += 10) {
        const part = await rpc<Acct[]>(url, 'getMultipleAccounts', [listed.accounts.slice(i, i + 10).map((a) => a.address), { encoding: 'jsonParsed', commitment: 'finalized' }]);
        result.push(...(part.result ?? []));
        slot = part.slot;
      }
      const total = result.reduce((s, a) => {
        const info = a?.data?.parsed?.info;
        return info && info.owner === owner && info.mint === mint ? s + BigInt(info.tokenAmount?.amount ?? '0') : s;
      }, 0n);
      return { raw: total.toString(), slot, source: `${new URL(url).host} getMultipleAccounts (finalized)` };
    }));
    if (checks.every((c) => c.raw === listed.raw)) return { ...listed, sources: [...listed.sources, ...checks.map((c) => c.source)] };
    if (attempt === 1) throw new SolanaReadError(`the RPC providers disagree about ${owner}'s balance of ${mint}: ${listed.sources[0]} ${listed.raw} at slot ${listed.slot} vs ${checks.map((c) => `${c.source} ${c.raw} at slot ${c.slot}`).join(', ')}`);
  }
  throw new SolanaReadError('unreachable');
}

/** Whether an address is an ordinary wallet (an ed25519 key) or a program-derived address. */
export function isWalletAddress(address: string): boolean {
  return PublicKey.isOnCurve(new PublicKey(address).toBytes());
}

// ---------------------------------------------------------------------------
// Settlement: send and verify
// ---------------------------------------------------------------------------

export function devnetKeypair(): Keypair | null {
  const k = process.env.SOLANA_DEVNET_KEY?.trim();
  if (!k) return null;
  try {
    return Keypair.fromSecretKey(Buffer.from(k, 'base64'));
  } catch {
    return null;
  }
}

/** Send `amountRaw` of `mint` from the devnet settlement wallet to `recipient`, creating its token account if needed. Waits for finalized. */
export async function sendDevnetSettlement(mint: MintRead, recipient: string, amountRaw: bigint): Promise<string> {
  if (mint.network !== 'solana-devnet') throw new SolanaInputError('Shield settles on Solana devnet only');
  const payer = devnetKeypair();
  if (!payer) throw new SolanaReadError('no devnet settlement key is configured');
  if (mint.decimals === null || !mint.program) throw new SolanaReadError('not a token mint');
  const programId = mint.program === 'spl-token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintKey = new PublicKey(mint.mint);
  const to = new PublicKey(recipient);
  const fromAta = getAssociatedTokenAddressSync(mintKey, payer.publicKey, false, programId);
  const toAta = getAssociatedTokenAddressSync(mintKey, to, true, programId);
  const conn = new Connection(SOLANA_RPCS['solana-devnet'][0]!, 'confirmed');
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, to, mintKey, programId),
    createTransferCheckedInstruction(fromAta, mintKey, toAta, payer.publicKey, amountRaw, mint.decimals, [], programId),
  );
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'finalized' });
}

export interface SettlementCheck {
  signature: string;
  network: SolanaNetwork;
  found: boolean;
  finalized: boolean;
  succeeded: boolean;
  slot: number | null;
  blockTime: string | null;
  feeLamports: number | null;
  /** What the recipient's accounts of the mint gained, exact integer text */
  receivedRaw: string | null;
  received: string | null;
  /** True when the recipient gained exactly the amount authorised */
  amountMatches: boolean;
  source: string;
  error?: string;
}

/** Read a settlement back from the chain at finalized and check it paid the recipient exactly `amountRaw` of the mint. */
export async function verifySettlement(network: SolanaNetwork, signature: string, mint: string, recipient: string, amountRaw: bigint, decimals: number): Promise<SettlementCheck> {
  const url = SOLANA_RPCS[network][0]!;
  const base: SettlementCheck = { signature, network, found: false, finalized: false, succeeded: false, slot: null, blockTime: null, feeLamports: null, receivedRaw: null, received: null, amountMatches: false, source: `${new URL(url).host} getTransaction (finalized)` };
  let tx: ParsedTransactionWithMeta | null;
  try {
    ({ result: tx } = await rpc<ParsedTransactionWithMeta | null>(url, 'getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]));
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  if (!tx || !tx.meta) return base;
  const sum = (list: typeof tx.meta.preTokenBalances) => (list ?? [])
    .filter((b) => b.mint === mint && b.owner === recipient)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const gained = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  return {
    ...base,
    found: true,
    finalized: true,
    succeeded: tx.meta.err === null,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    feeLamports: tx.meta.fee,
    receivedRaw: gained.toString(),
    received: wholeUnits(gained, decimals),
    amountMatches: tx.meta.err === null && gained === amountRaw,
  };
}

export function explorerTx(network: SolanaNetwork, signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${network === 'solana-devnet' ? '?cluster=devnet' : ''}`;
}
