// Reads every figure the film quotes back from its source, into data/onchain.json:
//   - the settlement memo rk43l_0A and the resolution UnLKfa5v from the live API (truvian.xyz)
//   - the resolution's Solana devnet anchor (getTransaction: memo text, slot, block time)
//   - the tUSD mint on Solana devnet (getAccountInfo, jsonParsed)
//   - the miner's registration 6194 on Ethereum Sepolia (receipt + block time)
//   - the live stats strip (/api/stats)
// Read-only. No keys.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = "https://truvian.xyz";
const SOL = "https://api.devnet.solana.com";
const ETH = "https://ethereum-sepolia-rpc.publicnode.com";
const MINER_TX = "0xa49244818b8d2dbd8a495909af93bf6f5af985cfd58571f581b6298e984d01f8";

const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};

const settle = await get(`${SITE}/api/memo/rk43l_0A`);
const resolve = await get(`${SITE}/api/resolution/UnLKfa5v`);
const stats = await get(`${SITE}/api/stats`);

const s = settle.memo;
const sanctions = s.purchases.find((p) => p.key === "sanctions");
const registry = s.purchases.find((p) => p.key === "registry");
const balance = s.purchases.find((p) => p.key === "balance");

const anchorSig = resolve.anchor.signature;
const anchorTx = await rpc(SOL, "getTransaction", [anchorSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
const memoIx = anchorTx.transaction.message.instructions.find((i) => i.program === "spl-memo");
const mint = await rpc(SOL, "getAccountInfo", [s.settlement.mint.mint, { encoding: "jsonParsed", commitment: "finalized" }]);

const rc = await rpc(ETH, "eth_getTransactionReceipt", [MINER_TX]);
const blk = await rpc(ETH, "eth_getBlockByNumber", [rc.blockNumber, false]);

const r = resolve.memo;
const out = {
  readAt: new Date().toISOString(),
  settlement: {
    id: settle.id, url: `${SITE}/preflight?m=${settle.id}`, createdAt: s.createdAt, decision: s.decision, rule: s.decisionRule,
    network: s.settlement.network, counterparty: s.input.issuer, mint: s.settlement.mint.mint, mintProgram: s.settlement.mint.program,
    mintSlot: s.settlement.mint.slot, amountWhole: Number(s.settlement.amountRaw) / 10 ** s.settlement.mint.decimals,
    payer: s.input.wallet, payerBalanceChain: s.settlement.payerBalance.whole, recipient: s.action.description.match(/to (\w+)/)[1],
    action: s.action.description,
    sanctions: { miner: sanctions.minerName, minerId: sanctions.minerId, lists: sanctions.fields.lists, matches: sanctions.fields.matches, costUsd: sanctions.costUsd, signal: sanctions.signalHash },
    registry: { miner: registry.minerName, minerId: registry.minerId, active: registry.fields.active, jurisdiction: registry.fields.jurisdiction, costUsd: registry.costUsd, signal: registry.signalHash },
    balance: { miner: balance.minerName, minerId: balance.minerId, answered: balance.fields.balance, symbol: balance.fields.token_symbol, costUsd: balance.costUsd, signal: balance.signalHash },
    findings: s.findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title })),
    costUsd: s.cost.telegraphUsd, paidRequests: s.cost.paidRequests, sha256: settle.sha256, signer: settle.signer,
  },
  resolution: {
    id: resolve.id, url: `${SITE}/resolve?r=${resolve.id}`, createdAt: r.createdAt, decision: r.decision, outcome: r.outcome, rule: r.decisionRule,
    source: r.market.source, marketId: r.market.id, question: r.market.question,
    answers: r.answers.map((a) => ({ miner: a.minerName, minerId: a.minerId, rank: a.rank, outcome: a.outcome, route: a.route })),
    costUsd: r.cost.telegraphUsd, sha256: resolve.sha256,
    anchor: {
      cluster: "devnet", signature: anchorSig, slot: anchorTx.slot, blockTime: new Date(anchorTx.blockTime * 1000).toISOString(),
      memoText: memoIx?.parsed, matchesDigest: memoIx?.parsed === `Truvian Resolve sha256:${resolve.sha256}`,
      explorer: `https://explorer.solana.com/tx/${anchorSig}?cluster=devnet`,
    },
  },
  mint: { address: s.settlement.mint.mint, owner: mint.value.owner, decimals: mint.value.data.parsed.info.decimals, supply: mint.value.data.parsed.info.supply },
  miner: {
    registration: 6194, tx: MINER_TX, status: rc.status, block: parseInt(rc.blockNumber, 16), time: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(),
    from: rc.from, to: rc.to, explorer: `https://sepolia.etherscan.io/tx/${MINER_TX}`,
  },
  stats: { deskDecisions: stats.preflightsRun, telegraphRequests: stats.telegraphRequests, paidToTelegraphUsd: stats.telegraphLedger?.spentUsd, readAt: stats.telegraphLedger?.readAt },
};
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data/onchain.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
