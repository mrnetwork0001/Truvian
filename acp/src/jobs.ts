/** Read-only: list the jobs an ACP role knows about. `npx tsx src/jobs.ts [BUYER|TRUVIAN|DEMO_PROVIDER]` */
import { createAgent } from './agent.js';
import type { Role } from './config.js';
const role = (process.argv[2] ?? 'BUYER') as Role;
const a = await createAgent(role);
await a.start();
await new Promise((r) => setTimeout(r, 5000));
for (const s of a.sessions) console.log(JSON.stringify({ jobId: s.jobId, chainId: s.chainId, status: s.status, roles: s.roles }));
console.log(`${a.sessions.length} session(s)`);
await a.stop();
process.exit(0);
