/**
 * Well-known ERC-20 tokens by chain, for questions that name a token by
 * symbol instead of address ("the USDC balance of 0x… on Base").
 *
 * Every entry was checked on-chain on 2026-11-20 (symbol() and decimals()
 * against each address); the AAVE to ARB and cbETH entries were added and
 * checked the same way on 2026-11-23, after the node asked for AAVE, PEPE,
 * STORJ, UNI, cbETH and OP by symbol alone. On Arbitrum and Polygon the canonical USDT contract
 * now reports its symbol as USD₮0 / USDT0; it is still listed as USDT, the
 * name callers use. A token given by address needs no entry here: its
 * decimals and symbol are read from the contract.
 *
 * This table is the only place a word given alone ("USDC on Base") is looked
 * up, since such a word may be a name as well as a symbol. A symbol missing
 * here is looked up in CoinGecko's token list for the chain only when the
 * question gives it in parentheses after a name, as in "Bancor (BNT)"
 * (src/miner/tokenList.ts).
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
    AAVE: { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 },
    UNI: { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    LINK: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    LDO: { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18 },
    PEPE: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
    SHIB: { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    STORJ: { address: '0xB64ef51C888972c908CFacf59B47C1AfBC0Ab8aC', decimals: 8 },
    STETH: { address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 },
    CBETH: { address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', decimals: 18 },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    CBETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    OP: { address: '0x4200000000000000000000000000000000000042', decimals: 18 },
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

/**
 * What the table's tokens are called, by symbol, for checking a name given
 * beside the symbol ("Tether (USDT) on Arbitrum"; src/miner/tokenNames.ts).
 * Each list holds the name() of the symbol's contracts in the table, as read
 * on 2026-11-21 ("USD₮0" on Arbitrum, "USDT0" on Polygon; Polygon's
 * "(PoS) Wrapped BTC" agrees with "Wrapped BTC"), and the name CoinGecko
 * gives the token. test:miner checks every contract's name() against it.
 */
export const KNOWN_TOKEN_NAMES: Record<string, readonly string[]> = {
  USDC: ['USD Coin', 'USDC'],
  USDT: ['Tether USD', 'Tether', 'USDT0', 'USD₮0'],
  DAI: ['Dai Stablecoin', 'Dai'],
  WETH: ['Wrapped Ether', 'WETH'],
  WBTC: ['Wrapped BTC', 'Wrapped Bitcoin'],
  AAVE: ['Aave Token', 'Aave'],
  UNI: ['Uniswap'],
  LINK: ['ChainLink Token', 'Chainlink'],
  LDO: ['Lido DAO Token', 'Lido DAO'],
  PEPE: ['Pepe'],
  SHIB: ['SHIBA INU', 'Shiba Inu'],
  STORJ: ['StorjToken', 'Storj'],
  STETH: ['Liquid staked Ether 2.0', 'Lido Staked Ether'],
  CBETH: ['Coinbase Wrapped Staked ETH'],
  ARB: ['Arbitrum'],
  OP: ['Optimism'],
};
