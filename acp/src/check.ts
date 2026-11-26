/** Read-only connection check for one ACP role: no signing, no transaction. `npx tsx src/check.ts [TRUVIAN|BUYER|DEMO_PROVIDER]` */
import { createAgent } from './agent.js';
import { network, wallet, type Role } from './config.js';

const role = (process.argv[2] ?? 'TRUVIAN') as Role;
const agent = await createAgent(role);
const address = await agent.getAddress();
const me = await agent.getMe();
const offerings = (me as any).jobOfferings ?? (me as any).offerings ?? [];
console.log(JSON.stringify({
  role, network: network(),
  addressMatchesEnv: address.toLowerCase() === wallet(role).walletAddress.toLowerCase(),
  name: (me as any).name, id: (me as any).id,
  offerings: offerings.map((o: any) => ({ name: o.name, price: o.price ?? o.priceUsd ?? o.priceV2 })),
  fields: Object.keys(me as any),
}, null, 1));
process.exit(0);
