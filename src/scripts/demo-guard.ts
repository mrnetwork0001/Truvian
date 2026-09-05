/**
 * Demo: an agent that cannot sign into a reverted counterparty.
 *
 *   npx tsx src/scripts/demo-guard.ts [shieldUrl]
 *
 * Wraps a viem wallet client with the Truvian Shield guard and attempts two
 * transactions against LIVE Telegraph miners:
 *
 *   1. a small transfer to a counterparty whose referenced tx succeeded  -> signs
 *   2. a large transfer to a counterparty whose referenced tx REVERTED   -> refused
 *
 * Nothing is broadcast: the wallet client has no funded account and the guard
 * throws before viem is ever asked to sign. The point is the refusal.
 */
import 'dotenv/config';
import { guard, ShieldBlockedError, type GuardOptions } from '../agent/guard.js';
import type { CheckReport } from '../shield/types.js';

const SHIELD = process.argv[2] ?? process.env.SHIELD_URL ?? 'http://127.0.0.1:8788';

/** Minimal stand-in for a viem wallet client: the guard only proxies it. */
const wallet = {
  chain: { id: 8453 },
  async sendTransaction(request: { to?: string | null; value?: bigint }): Promise<`0x${string}`> {
    console.log(`    (wallet would now sign and broadcast to ${request.to})`);
    return '0xsigned';
  },
};

const options: GuardOptions = {
  shieldUrl: SHIELD,
  refuseAt: 'BLOCK',
  onReport: (report: CheckReport) => {
    console.log(`    Shield: ${report.verdict} (score ${report.score})`);
    for (const check of report.checks) console.log(`      ${check.status.padEnd(5)} ${check.name} - ${check.summary.slice(0, 90)}`);
  },
};
if (process.env.TELEGRAPH_PAYER_KEY) options.payerKey = process.env.TELEGRAPH_PAYER_KEY;

async function attempt(label: string, evidence: string, request: { to: string; value: bigint }) {
  console.log(`\n${label}`);
  // A real agent knows a prior transaction for each counterparty it deals
  // with; passing it turns on the COUNTERPARTY check.
  const guarded = guard(wallet, { ...options, txHash: evidence });
  try {
    const hash = await guarded.sendTransaction(request);
    console.log(`    SIGNED -> ${hash}`);
  } catch (err) {
    if (err instanceof ShieldBlockedError) {
      console.log(`    REFUSED - ${err.message}`);
      return;
    }
    console.log(`    ERROR - ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log(`guarding a viem wallet with Shield at ${SHIELD}`);
  // 0.05 ETH to a counterparty whose referenced Base transaction succeeded.
  await attempt(
    '1. small transfer, healthy counterparty',
    '0x772e04669ec9ad56635d998be5638c5eae6f2897cb28192bdb8e1bdedad3c769',
    { to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', value: 50000000000000000n },
  );
  // 60 ETH to a counterparty whose referenced Base transaction REVERTED.
  await attempt(
    '2. large transfer, reverted counterparty',
    '0xef26d7918abb2ba7cbe6a121507a3f2a4f54bb9c31f3e568643501e2394c9863',
    { to: '0x83d55acdc72027ed339d267eebaf9a41e47490d5', value: 60000000000000000000n },
  );
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
