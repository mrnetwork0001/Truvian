/**
 * Well-known ERC-20 tokens by chain, for questions that name a token by
 * symbol instead of address ("the USDC balance of 0x… on Base").
 *
 * Every entry was checked on-chain on 2026-11-20 (symbol() and decimals()
 * against each address). On Arbitrum and Polygon the canonical USDT contract
 * now reports its symbol as USD₮0 / USDT0; it is still listed as USDT, the
 * name callers use. A token given by address needs no entry here: its
 * decimals and symbol are read from the contract. A symbol missing here is
 * looked up in CoinGecko's token list for the chain (src/miner/tokenList.ts).
 */
import type { SupportedChain } from './chains.js';

export interface KnownToken {
  address: `0x${string}`;
  decimals: number;
}

export const KNOWN_TOKENS: Partial<Record<SupportedChain, Record<string, KnownToken>>> = {
  ethereum: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  },
  polygon: {
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    WBTC: { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
    DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
  },
  bsc: {
    USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  },
};

/** Symbols that mean "the chain's native coin" rather than an ERC-20. */
export const NATIVE_SYMBOLS = new Set(['ETH', 'POL', 'MATIC', 'BNB', 'AVAX', 'XDAI', 'OKB', 'NATIVE']);
