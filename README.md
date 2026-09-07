# 🛡️ Truvian - Exact Onchain Truth Engine

**Telegraph Protocol Season I Hackathon** · Tracks 1, 2 & 3 · by [`mrnetwork0001`](https://github.com/mrnetwork0001)

Truvian answers onchain questions **exactly** - and judges other miners' answers for exactness. Live on Telegraph's Base Sepolia testnet.

**▶ [Watch the 3-minute demo](https://x.com/encrypt_wizard/status/2096818596051575158)** · **[Try it live: truvian.xyz](https://truvian.xyz)**

## What's live right now

| Piece | Status |
|---|---|
| **Miner** (Track 1) - [`truvian-onchain-truth`](https://miner.truvian.xyz/health), reg #172 | 🟢 Active · rank 2 in `ONCHAIN_TX_LOOKUP` (0.910) and `GAS_PRICE` on debut epoch |
| **WASM scoring module** (Track 2) - reg #544, then #617 | 🏆 Held **champion** for `ONCHAIN_TX_LOOKUP` twice this season - the module validators run to score every miner in the intent - before being dethroned in an open arms race |
| **Truvian Shield** (Track 3) - [truvian.xyz](https://truvian.xyz) | 🟢 Live · execution-safety checkpoint paying live Telegraph miners per check |

## The miner

A deterministic HTTP API over live JSON-RPC (Base, Ethereum, Base Sepolia, X Layer):

- `GET /tx?chain=base&hash=0x…` - full canonical facts of a transaction: status, block, addresses, value, decoded ERC-20 transfers, and the **true total fee including the OP-stack L1 data fee** (`gasUsed × effectiveGasPrice + l1Fee`) that naive implementations drop.
- `GET /gas?chain=base` - block-anchored fee snapshot: gas price, base/priority fee, EIP-1559 percentiles, L1 base fee.

Every response leads with a number-first plain-language answer (the text validators score), followed by the complete structured payload. Every figure is independently reproducible from public RPC. Run `npm run test:miner` for the 30+ live-verification checks (fee invariants, determinism, revert/error paths).

## The scoring module (`scorer/`)

A Rust → `wasm32-unknown-unknown` judge implementing `rank_answer(question, ground_truth, miner_answer) → f32`:

- **Typed-fact scoring**: extracts tx hashes, addresses, uint256 values (compared exactly), and status words - not just text similarity.
- **Negation-aware**: "did **not** succeed in block N" with all the right numbers scores ~0.03 where embedding-similarity judges rank it *above* the correct answer.
- **Anti-gaming**: value-dump answers, near-miss numerics, corrupted hex, from/to swaps, and structured-blob stuffing are all detected and penalized.
- Promoted to champion on its third gauntlet attempt (ordering 15/15 · margin 0.565 · real-traffic agreement 0.645), after each rejection was measured and fixed empirically - the fixture suite, champion-comparison harness (`compare.sh`), and agreement harness (`agree.sh`) are all in-repo and reproducible.

Build: `cd scorer && cargo build --release --target wasm32-unknown-unknown` · Test: `./test.sh` (official wazero harness).

## Truvian Shield (`src/shield/`)

The Track 3 app: an execution-safety checkpoint for onchain agents, live at **[truvian.xyz](https://truvian.xyz)**.

Before an agent signs a transaction it POSTs the proposed action; Shield fans out to **live** Telegraph miners and returns a `SAFE` / `CAUTION` / `BLOCK` verdict with per-check evidence:

| Check | Intent | Asks |
|---|---|---|
| FEE | `GAS_PRICE` | is gas sane on this chain right now? |
| COUNTERPARTY | `ONCHAIN_TX_LOOKUP` | did the referenced transaction actually succeed? |
| VALUE | `CRYPTO_PRICE` | how many dollars are at risk? |
| LIQUIDITY | `TVL_LOOKUP` | is the named protocol still liquid? |

- **Nothing mocked or cached.** Every check is a real x402 payment in USDC to a live miner at request time; an unreachable miner is graded `error`, never filled in.
- **Verifiable.** Each answer carries a Telegraph signal hash that resolves on the node, and every report gets a permalink (`/app?r=<id>`) plus a public feed at `/api/recent`.
- **Shield is itself an x402 service.** Past the free allowance, `POST /api/check` answers `402` with a price, so agents pay per check and the app funds the miners it depends on.
- **Drop-in guard.** `src/agent/guard.ts` wraps a viem wallet so `sendTransaction` refuses on `BLOCK` - and fails closed if Shield is unreachable, because a safety check that fails open is not a safety check.

Run `npx tsx src/scripts/readiness.ts` for the 62-check end-to-end suite against live miners, or `npx tsx src/scripts/demo-guard.ts` to watch an agent refuse to sign.

## Repo map

```
src/miner/        Fastify miner: intent handlers + server        (Track 1)
scorer/           Rust -> WASM scoring module + test harnesses      (Track 2)
src/shield/       Shield API, verdict engine, x402 client+server,
                  receipts, rate limiting, dashboard                (Track 3)
src/agent/        Drop-in viem guard for autonomous agents
src/config/       Chain registry (verified RPCs, fallback transports)
src/scripts/      Live verification suites, chain probes, demo capture
telegraph/        Miner YAML, registration runbook, shipped .wasm binaries
video/            Remotion project for the demo video
deploy/           pm2 + nginx configs
docs/             Build plan + X update log
```

## Verified-facts engineering

Everything here was built against the live network, not the docs alone: RPC limits probed empirically, competitor answer formats pulled from their live APIs, the champion scorer benchmarked with its own binary, and every registration hash verified end-to-end before submission. See `telegraph/REGISTRATION.md` for the full runbook.

- Built for the [Telegraph Protocol](https://telegraphprotocol.com) Season I Hackathon · [@Telegraphprotoc](https://x.com/telegraphprotoc)
