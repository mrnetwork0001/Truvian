/**
 * An ACP agent for one role, on the configured network (testnet by default).
 * The SDK defaults to mainnet; testnet needs its own server, Privy app and
 * chain, passed to the wallet adapter, the event stream and the job API alike.
 */
import { Agent as HttpAgent, setGlobalDispatcher } from 'undici';
import { AcpAgent, AcpApiClient, PrivyAlchemyEvmProviderAdapter, SseTransport } from '@virtuals-protocol/acp-node-v2';
import { builderCode, chain, privyAppId, serverUrl, wallet, type Role } from './config.js';

// Node 26's built-in fetch stalls every request to the ACP server while the
// SDK's event streams (chat, wallet) are open, so signing never returns. The
// undici package's own dispatcher does not; use it for every fetch here.
setGlobalDispatcher(new HttpAgent());

export async function createAgent(role: Role): Promise<AcpAgent> {
  const w = wallet(role);
  const url = serverUrl();
  const code = builderCode();
  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: w.walletAddress,
    walletId: w.walletId,
    signerPrivateKey: w.signerPrivateKey,
    chains: [chain()],
    serverUrl: url,
    privyAppId: privyAppId(),
    ...(code ? { builderCode: code } : {}),
  });
  return AcpAgent.create({ evmProvider: provider, transport: new SseTransport({ serverUrl: url }), api: new AcpApiClient({ serverUrl: url }) });
}

export const log = (role: string, ...parts: unknown[]) => console.log(new Date().toISOString(), `[${role}]`, ...parts);
