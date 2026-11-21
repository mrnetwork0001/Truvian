/**
 * Whether a name a question gives for a token agrees with the token's names.
 *
 * The node writes a token as "<name> (<symbol>) on <chain>". The symbol finds
 * the token, in the verified table or a public list; the name must not
 * contradict it. "Uniswap (BNT) on Ethereum" names Uniswap with Bancor's
 * symbol, and is refused rather than answered for BNT.
 *
 * The node's names are not one source's: "Kelp DAO Restaked ETH" is
 * CoinGecko's name for rsETH, whose contract calls itself "rsETH", while
 * "Bancor" is neither CoinGecko's "Bancor Network" nor the contract's
 * "Bancor Network Token". So agreement allows extra words and refuses
 * different ones. Names are compared as words: lower case, accents and
 * punctuation dropped, ₮ read as T. Two names agree when
 *   3. their words are the same ("Kelp DAO Restaked ETH" and
 *      "kelp-dao restaked eth"), or
 *   2. the words of one are a run of whole words within the other ("Bancor"
 *      in "Bancor Network", "Bridged USDC" in "Arbitrum Bridged USDC
 *      (Arbitrum)"), or
 *   1. their first significant words are the same, skipping "the", "wrapped"
 *      and "bridged" ("Lido Staked ETH" and "Lido Staked Ether"; not
 *      "Wrapped Bitcoin" and "Wrapped Ether").
 * Nothing else agrees: "Uniswap" and "Bancor Network" share no word, and
 * "Uni" is not "Uniswap", since words are compared whole.
 */

/** A name's words: lower case, accents and punctuation dropped, ₮ read as T. */
export function nameWords(name: string): string[] {
  return name.normalize('NFKC').replace(/₮/g, 'T').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Words that open many unrelated names, and so say nothing as a first word. */
const OPENING_WORDS = new Set(['the', 'wrapped', 'bridged']);

function firstSignificant(words: string[]): string | null {
  return words.find((w) => !OPENING_WORDS.has(w)) ?? null;
}

/** Whether `inner` occurs within `outer` as consecutive whole words. */
function runWithin(inner: string[], outer: string[]): boolean {
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

/** How a given name agrees with the closest of a token's names: 3 the same words, 2 one a run within the other, 1 the same first significant word, 0 not at all. */
export type Agreement = 0 | 1 | 2 | 3;

export function nameAgreement(given: string, names: readonly string[]): Agreement {
  const g = nameWords(given);
  if (g.length === 0) return 0;
  let best: Agreement = 0;
  for (const name of names) {
    const n = nameWords(name);
    if (n.length === 0) continue;
    if (g.length === n.length && runWithin(g, n)) return 3;
    if (runWithin(g, n) || runWithin(n, g)) best = 2;
    else if (best === 0 && firstSignificant(g) !== null && firstSignificant(g) === firstSignificant(n)) best = 1;
  }
  return best;
}

export function namesAgree(given: string, names: readonly string[]): boolean {
  return nameAgreement(given, names) > 0;
}
