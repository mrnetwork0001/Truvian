/**
 * Truvian Shield end-to-end readiness check.
 *
 *   npx tsx src/scripts/readiness.ts
 *
 * Boots the real server in-process against LIVE Telegraph miners and exercises
 * every path a judge or an agent will touch: the pages and their assets, the
 * free tier, streaming progress, both demo presets, receipts and their
 * permalinks, signal resolution on the node, the rate limiter, a real x402
 * payment with settlement, and the agent guard.
 *
 * This spends real USDC (a few cents) because that is the point: nothing here
 * is mocked. Set READINESS_SKIP_PAID=1 to skip the paying step.
 */
import 'dotenv/config';
import { guard, ShieldBlockedError } from '../agent/guard.js';
import { accountFromKey, signPaymentHeader, type PayableRequirements } from '../shield/x402pay.js';
import type { CheckReport } from '../shield/types.js';

// Tight free tier so exhaustion (and therefore the paid path) is reachable.
process.env.SHIELD_FREE_CHECKS_PER_IP = process.env.SHIELD_FREE_CHECKS_PER_IP ?? '4';
process.env.SHIELD_BURST_PER_MIN = process.env.SHIELD_BURST_PER_MIN ?? '4';
process.env.SHIELD_STATS_FILE = process.env.SHIELD_STATS_FILE ?? '/tmp/truvian-readiness-stats.json';
process.env.SHIELD_RECEIPTS_FILE = process.env.SHIELD_RECEIPTS_FILE ?? '/tmp/truvian-readiness-receipts.json';

const SAFE_TX = '0x772e04669ec9ad56635d998be5638c5eae6f2897cb28192bdb8e1bdedad3c769';
const SAFE_TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const REVERTED_TX = '0xef26d7918abb2ba7cbe6a121507a3f2a4f54bb9c31f3e568643501e2394c9863';
const REVERTED_TO = '0x83d55acdc72027ed339d267eebaf9a41e47490d5';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ''));
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
  return ok;
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const { buildShieldServer } = await import('../shield/server.js');
  const app = buildShieldServer();
  app.log.level = 'warn';
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Shield running at ${base} (live Telegraph miners, real x402 payments)\n`);

  const receiptIds: string[] = [];
  let signalHash = '';

  try {
    // ---------------------------------------------------------------- pages
    section('Pages and assets');
    const landing = await fetch(`${base}/`);
    const landingHtml = await landing.text();
    check('GET / serves the landing page', landing.status === 200 && landingHtml.includes('<title>'));
    check('landing has the hero question', landingHtml.includes('Should your agent'));
    check('landing has the Why Truvian band', landingHtml.includes('Why Truvian'));
    check('landing has the recent-checks feed', landingHtml.includes('id="recent"'));
    check('landing links to the app', landingHtml.includes('href="/app"'));
    check('landing pulls no external scripts', !/src="https?:/.test(landingHtml));

    const appPage = await fetch(`${base}/app`);
    const appHtml = await appPage.text();
    check('GET /app serves the tool', appPage.status === 200 && appHtml.includes('check-form'));
    check('app has the demo presets', appHtml.includes('data-preset="safe"') && appHtml.includes('data-preset="block"'));
    check('app has the wallet button', appHtml.includes('id="wallet-btn"'));
    check('app loads wallet.js before app.js', appHtml.indexOf('wallet.js') < appHtml.indexOf('app.js'));

    for (const asset of ['/landing.css', '/landing.js', '/style.css', '/app.js', '/wallet.js', '/brand/truvian-header.png', '/favicon.ico', '/og-image.png']) {
      const res = await fetch(`${base}${asset}`);
      check(`asset ${asset}`, res.status === 200, `${res.status} ${res.headers.get('content-type') ?? ''}`);
    }
    check('unknown path 404s', (await fetch(`${base}/does-not-exist`)).status === 404);

    // ---------------------------------------------------------------- health
    section('Health and stats');
    const health = (await (await fetch(`${base}/healthz`)).json()) as { ok?: boolean };
    check('GET /healthz', health.ok === true);

    const stats = (await (await fetch(`${base}/api/stats`)).json()) as Record<string, unknown>;
    const budget = stats.budget as Record<string, unknown>;
    const pricing = stats.pricing as Record<string, unknown> | null;
    check('stats reports a payer wallet', typeof stats.payer === 'string', String(stats.payer));
    check('stats reads the real USDC balance', typeof budget.balanceUsdc === 'number', `$${budget.balanceUsdc}`);
    check('stats says how many checks are funded', typeof budget.checksFunded === 'number', `${budget.checksFunded} checks`);
    check('stats publishes the price', pricing !== null && typeof pricing.priceUsd === 'number', `$${pricing?.priceUsd}`);
    check('stats tracks miner spend', typeof stats.paidUsd === 'number');
    check('stats tracks revenue', typeof stats.earnedUsd === 'number');

    // ---------------------------------------------------------------- checks
    section('Free checks against live miners');
    const safeRes = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', to: SAFE_TO, valueEth: 0.05, txHash: SAFE_TX }),
    });
    const safe = (await safeRes.json()) as CheckReport;
    check('SAFE preset returns 200', safeRes.status === 200);
    check('SAFE preset verdict is SAFE', safe.verdict === 'SAFE', `score ${safe.score}`);
    check('SAFE preset ran three checks', safe.checks.length === 3);
    check('every check names its miner', safe.checks.every((c) => typeof c.minerName === 'string' && c.minerName.length > 0));
    check('every check was paid over x402', safe.checks.every((c) => c.transport === 'x402'));
    check('checks carry signal hashes', safe.checks.some((c) => typeof c.signalHash === 'string'));
    const receiptHeader = safeRes.headers.get('x-shield-receipt');
    check('response carries a receipt id', typeof receiptHeader === 'string' && receiptHeader.length === 10, String(receiptHeader));
    if (receiptHeader) receiptIds.push(receiptHeader);
    signalHash = safe.checks.find((c) => c.signalHash)?.signalHash ?? '';

    const blockRes = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', to: REVERTED_TO, valueEth: 60, txHash: REVERTED_TX }),
    });
    const blocked = (await blockRes.json()) as CheckReport;
    check('BLOCK preset verdict is BLOCK', blocked.verdict === 'BLOCK', `score ${blocked.score}`);
    check('BLOCK preset fails the counterparty check', blocked.checks.some((c) => c.name === 'COUNTERPARTY' && c.status === 'fail'));
    check('BLOCK preset fails the value check', blocked.checks.some((c) => c.name === 'VALUE' && c.status === 'fail'));
    check('BLOCK preset explains itself', blocked.reasons.length >= 2);
    const blockReceipt = blockRes.headers.get('x-shield-receipt');
    if (blockReceipt) receiptIds.push(blockReceipt);

    // ------------------------------------------------------------- streaming
    section('Streaming progress');
    const streamRes = await fetch(`${base}/api/check?stream=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ chain: 'base', to: SAFE_TO, valueEth: 0.05 }),
    });
    check('stream responds as NDJSON', (streamRes.headers.get('content-type') ?? '').includes('x-ndjson'));
    const events: Array<Record<string, unknown>> = [];
    const text = await streamRes.text();
    for (const line of text.trim().split('\n')) {
      if (line.trim()) events.push(JSON.parse(line) as Record<string, unknown>);
    }
    check('stream opens with a plan', events[0]?.type === 'start');
    const signalEvents = events.filter((e) => e.type === 'signal');
    check('stream announces each miner answer', signalEvents.length >= 2, `${signalEvents.length} signals`);
    check('signal events name the miner and latency', signalEvents.every((e) => typeof e.latencyMs === 'number'));
    const reportEvent = events.find((e) => e.type === 'report');
    check('stream ends with a report and a permalink', !!reportEvent && typeof reportEvent.id === 'string', String(reportEvent?.url));
    check('stream sends a done event', events[events.length - 1]?.type === 'done');
    if (typeof reportEvent?.id === 'string') receiptIds.push(reportEvent.id);

    // -------------------------------------------------------------- receipts
    section('Receipts, feed and node verification');
    const recent = (await (await fetch(`${base}/api/recent?limit=8`)).json()) as { checks: Array<Record<string, unknown>>; total: number };
    check('recent feed lists the checks just run', recent.checks.length >= 3, `${recent.total} stored`);
    check('feed rows carry verdict and signals', recent.checks.every((c) => typeof c.verdict === 'string' && Array.isArray(c.signals)));

    const first = receiptIds[0];
    if (first) {
      const stored = (await (await fetch(`${base}/api/report/${first}`)).json()) as { id?: string; report?: CheckReport };
      check('permalink returns the stored report', stored.id === first && stored.report?.verdict === 'SAFE');
    }
    check('unknown permalink 404s', (await fetch(`${base}/api/report/0000000000`)).status === 404);

    if (signalHash) {
      const signal = (await (await fetch(`${base}/api/signal/${signalHash}`)).json()) as Record<string, unknown>;
      check('signal hash resolves on the Telegraph node', signal.found === true, String(signal.minerSlug ?? signal.minerId));
      check('node names when it was recorded', typeof signal.recordedAt === 'string', String(signal.recordedAt));
    } else {
      check('signal hash resolves on the Telegraph node', false, 'no signal hash was returned');
    }

    section('Single-transaction verification');
    const verifyRes = await fetch(`${base}/api/verify/${REVERTED_TX}?chain=base`);
    const verify = (await verifyRes.json()) as CheckReport;
    check('GET /api/verify grades a reverted tx', verifyRes.status === 200 && verify.checks.length === 1);
    check('reverted tx is not SAFE', verify.verdict !== 'SAFE', `${verify.verdict} (score ${verify.score})`);
    check('bad hash is rejected', (await fetch(`${base}/api/verify/0xnope`)).status === 400);

    // -------------------------------------------------------- limits + 402
    section('Rate limit and the paid path');
    const bad = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: '0x123' }),
    });
    check('invalid input is rejected with 400', bad.status === 400);

    const exhausted = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', to: SAFE_TO, valueEth: 0.01 }),
    });
    const challenge = (await exhausted.json()) as { error?: string; accepts?: PayableRequirements[]; freeTier?: Record<string, unknown> };
    check('exhausted free tier answers 402, not a flat refusal', exhausted.status === 402, String(challenge.error).slice(0, 60));
    const requirements = challenge.accepts?.[0];
    check('402 quotes a price', !!requirements && Number(requirements.maxAmountRequired) > 0, requirements ? `$${Number(requirements.maxAmountRequired) / 1e6}` : '');
    check('402 names the asset and payee', !!requirements?.asset && !!requirements?.payTo);

    if (process.env.READINESS_SKIP_PAID === '1') {
      console.log('  SKIP  paid check (READINESS_SKIP_PAID=1)');
    } else if (requirements && process.env.TELEGRAPH_PAYER_KEY) {
      const header = await signPaymentHeader(accountFromKey(process.env.TELEGRAPH_PAYER_KEY), requirements);
      const paidRes = await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-PAYMENT': header },
        body: JSON.stringify({ chain: 'base', to: SAFE_TO, valueEth: 0.05 }),
      });
      const paid = (await paidRes.json()) as CheckReport;
      check('paying past the free tier returns a report', paidRes.status === 200 && paid.verdict !== undefined, String(paid.verdict));
      const settledHeader = paidRes.headers.get('x-payment-response');
      check('payment settles onchain', typeof settledHeader === 'string');
      if (settledHeader) {
        const settlement = JSON.parse(Buffer.from(settledHeader, 'base64').toString('utf8')) as Record<string, unknown>;
        check('settlement succeeded with a tx hash', settlement.success === true && typeof settlement.transaction === 'string', String(settlement.transaction));
      }
      const after = (await (await fetch(`${base}/api/stats`)).json()) as Record<string, unknown>;
      check('revenue is recorded', (after.earnedUsd as number) > 0, `$${after.earnedUsd} earned, $${after.paidUsd} paid to miners`);
      check('paid checks are counted', (after.paidChecks as number) >= 1);
    } else {
      check('paid check', false, 'no payer key available');
    }

    // ----------------------------------------------------------- agent guard
    section('Agent guard');
    const wallet = {
      chain: { id: 8453 },
      sendTransaction: async (_args: { to?: string | null; value?: bigint }) => '0xsigned' as `0x${string}`,
    };
    const guardOptions = {
      shieldUrl: base,
      txHash: REVERTED_TX,
      ...(process.env.TELEGRAPH_PAYER_KEY ? { payerKey: process.env.TELEGRAPH_PAYER_KEY } : {}),
    };
    const guarded = guard(wallet, guardOptions);
    let refused = false;
    let guardReport: CheckReport | undefined;
    try {
      await guarded.sendTransaction({ to: REVERTED_TO, value: 60000000000000000000n });
    } catch (err) {
      refused = err instanceof ShieldBlockedError;
      if (err instanceof ShieldBlockedError) guardReport = err.report;
    }
    check('guard refuses to sign a BLOCK transaction', refused, guardReport ? `${guardReport.verdict} score ${guardReport.score}` : '');

    // --------------------------------------------------------------- summary
    section('Summary');
    const finalStats = (await (await fetch(`${base}/api/stats`)).json()) as Record<string, unknown>;
    const finalBudget = finalStats.budget as Record<string, unknown>;
    console.log(`  checks run          ${finalStats.checksRun}`);
    console.log(`  Telegraph requests  ${finalStats.telegraphRequests}`);
    console.log(`  paid to miners      $${finalStats.paidUsd}`);
    console.log(`  earned from callers $${finalStats.earnedUsd} (${finalStats.paidChecks} paid checks)`);
    console.log(`  wallet balance      $${finalBudget.balanceUsdc} (funds ${finalBudget.checksFunded} more checks)`);
    console.log(`  receipts stored     ${receiptIds.length} this run`);
    if (receiptIds[0]) console.log(`  shareable example   /app?r=${receiptIds[0]}`);
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
