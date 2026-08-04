import { createPublicClient, http, erc20Abi, getAddress, type Address } from 'viem';

const client = createPublicClient({ transport: http('https://rpc.xlayer.tech') });

const CANDIDATE_TOKENS: Record<string, string> = {
  'SPEC_tokenIn': '0x779ded0c9e1022225f8e0630b35a9b54be713736',
  'SPEC_tokenOut': '0xE0B7A2bCF575CFBA10528C4E7C10BD3CE2D7769A',
  'WOKB?': '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  'USDC?': '0x74b7F16337b8972027F6196A17a631aC6dE26d22',
  'USDT?': '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
  'WETH?': '0x5A77f1443D16ee5761d310e38b62f77f726bC71c',
  'WBTC?': '0xEA034fb02eB1808C2cc3adbC15f447B93CbE08e1',
  'DAI?':  '0xC5015b9d9161Dca7e18e32f6f25C4aD850731Fd4',
};

const CANDIDATE_CONTRACTS: Record<string, string> = {
  'UniV3Factory(canonical)': '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  'UniV3QuoterV2(canonical)': '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  'UniV3SwapRouter02(canonical)': '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  'Multicall3': '0xcA11bde05977b3631167028862bE2a173976CA11',
  'PotatoSwapFactory?': '0x1482f4bE5C97Dd52D7DA6a0Ba30C09a6f1EA3d54',
};

async function main() {
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  console.log(`chainId=${chainId} latestBlock=${block.number} baseFee=${block.baseFeePerGas} gasLimit=${block.gasLimit}`);
  console.log('\n=== TOKENS ===');
  for (const [label, addr] of Object.entries(CANDIDATE_TOKENS)) {
    let a: Address;
    try { a = getAddress(addr); } catch { console.log(`${label.padEnd(26)} INVALID CHECKSUM ${addr}`); continue; }
    const code = await client.getBytecode({ address: a });
    if (!code || code === '0x') { console.log(`${label.padEnd(26)} ${a}  NO CODE (EOA/empty)`); continue; }
    try {
      const [sym, dec, name, supply] = await Promise.all([
        client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
        client.readContract({ address: a, abi: erc20Abi, functionName: 'name' }),
        client.readContract({ address: a, abi: erc20Abi, functionName: 'totalSupply' }),
      ]);
      console.log(`${label.padEnd(26)} ${a}  sym=${sym} dec=${dec} name="${name}" supply=${supply} codeLen=${(code.length - 2) / 2}B`);
    } catch (e: any) {
      console.log(`${label.padEnd(26)} ${a}  HAS CODE but not ERC20-readable (${e.shortMessage ?? e.message?.slice(0, 80)}) codeLen=${(code.length - 2) / 2}B`);
    }
  }
  console.log('\n=== INFRA CONTRACTS ===');
  for (const [label, addr] of Object.entries(CANDIDATE_CONTRACTS)) {
    try {
      const a = getAddress(addr);
      const code = await client.getBytecode({ address: a });
      console.log(`${label.padEnd(30)} ${a}  ${code && code !== '0x' ? `DEPLOYED codeLen=${(code.length - 2) / 2}B` : 'NOT DEPLOYED'}`);
    } catch (e: any) { console.log(`${label.padEnd(30)} ${addr} ERR ${e.message?.slice(0, 60)}`); }
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
