/**
 * Holdings proof on Solana (Solana use case 2, holder's side): what a fund,
 * custodian or index says a Solana custody wallet holds, checked without the
 * issuer. Feeds the holdings desk (holdings.ts) the same HoldingRead it gets
 * from an EVM chain, read from Solana instead (solana.ts): each mint's
 * decimals and supply, and the wallet's balance summed over its accounts of
 * that mint, with every read cross-checked across two RPC providers on
 * mainnet. It also states what each mint's issuer can still do to the
 * holding (freeze, claw back through a permanent delegate, tax, pause): a
 * holding the issuer can take back is not fully the fund's.
 */
import type { HoldingRead } from './preflight.js';
import { KNOWN_MINTS, mintRestrictions, readBalance, readMint, SOLANA_LABEL, type Restriction, type SolanaNetwork } from './solana.js';
import type { TokenFacts } from './tokenFacts.js';

export const isSolanaNetwork = (c: unknown): c is SolanaNetwork => c === 'solana' || c === 'solana-devnet';

function symbolOf(network: SolanaNetwork, mint: string): string | null {
  for (const [sym, addr] of Object.entries(KNOWN_MINTS[network])) if (addr === mint) return sym === 'TUSD' ? 'tUSD' : sym === 'RUSD' ? 'rUSD' : sym;
  return null;
}

export type SolanaHoldingRead = HoldingRead & { restrictions: Restriction[] };

export async function readSolanaHoldings(network: SolanaNetwork, wallet: string, holdings: Array<{ token: string; claimed: string }>): Promise<SolanaHoldingRead[]> {
  return Promise.all(holdings.map(async (h) => {
    const mint = await readMint(network, h.token);
    const bal = mint.isMint && mint.decimals !== null ? await readBalance(network, wallet, h.token, mint.decimals) : null;
    const slot = String(bal?.slot ?? mint.slot ?? '');
    // The EVM-shaped facts the holdings rules read: "block" is the slot, the "contract" is the mint.
    const facts = {
      chain: network, chainId: 0, chainLabel: SOLANA_LABEL[network],
      address: h.token, block: slot, blockTime: '', isContract: mint.isMint, codeBytes: 0, delegatedTo: null,
      name: null, symbol: symbolOf(network, h.token), decimals: mint.decimals,
      totalSupplyRaw: mint.supplyRaw, totalSupply: mint.supply, proxy: null, owner: null,
    } as unknown as TokenFacts;
    return {
      token: h.token as `0x${string}`, claimed: h.claimed, pool: null, facts,
      balanceRaw: bal?.raw ?? null, balance: bal?.whole ?? null,
      restrictions: mint.isMint ? mintRestrictions(mint) : [],
    };
  }));
}
