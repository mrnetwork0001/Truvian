# 🛡️ Truvian — Exact On-Chain Truth Engine

**Telegraph Protocol Season I Hackathon** · Tracks 1, 2 & 3 · by [`mrnetwork0001`](https://github.com/mrnetwork0001)

Truvian answers on-chain questions **exactly** — and judges other miners' answers for exactness. Live on Telegraph's Base Sepolia testnet.

## What's live right now

| Piece | Status |
|---|---|
| **Miner** (Track 1) — [`truvian-onchain-truth`](https://miner.truvian.xyz/health), reg #172 | 🟢 Active · rank 2 in `ONCHAIN_TX_LOOKUP` (0.910) and `GAS_PRICE` on debut epoch |
| **WASM scoring module** (Track 2) — reg #544 | 🏆 **Live champion** for `ONCHAIN_TX_LOOKUP` — the module validators run to score every miner in the intent |
| **Truvian Shield** (Track 3, opens Aug 31) | 🔜 Execution-safety agent consuming live Telegraph miners |

## The miner

A deterministic HTTP API over live JSON-RPC (Base, Ethereum, Base Sepolia, X Layer):

- `GET /tx?chain=base&hash=0x…` — full canonical facts of a transaction: status, block, addresses, value, decoded ERC-20 transfers, and the **true total fee including the OP-stack L1 data fee** (`gasUsed × effectiveGasPrice + l1Fee`) that naive implementations drop.
- `GET /gas?chain=base` — block-anchored fee snapshot: gas price, base/priority fee, EIP-1559 percentiles, L1 base fee.

Every response leads with a number-first plain-language answer (the text validators score), followed by the complete structured payload. Every figure is independently reproducible from public RPC. Run `npm run test:miner` for the 30+ live-verification checks (fee invariants, determinism, revert/error paths).

## The scoring module (`scorer/`)

A Rust → `wasm32-unknown-unknown` judge implementing `rank_answer(question, ground_truth, miner_answer) → f32`:

- **Typed-fact scoring**: extracts tx hashes, addresses, uint256 values (compared exactly), and status words — not just text similarity.
- **Negation-aware**: "did **not** succeed in block N" with all the right numbers scores ~0.03 where embedding-similarity judges rank it *above* the correct answer.
- **Anti-gaming**: value-dump answers, near-miss numerics, corrupted hex, from/to swaps, and structured-blob stuffing are all detected and penalized.
- Promoted to champion on its third gauntlet attempt (ordering 15/15 · margin 0.565 · real-traffic agreement 0.645), after each rejection was measured and fixed empirically — the fixture suite, champion-comparison harness (`compare.sh`), and agreement harness (`agree.sh`) are all in-repo and reproducible.

Build: `cd scorer && cargo build --release --target wasm32-unknown-unknown` · Test: `./test.sh` (official wazero harness).

## Repo map

```
src/miner/        Fastify miner: intent handlers + server
src/config/       Chain registry (verified RPCs, fallback transports)
src/scripts/      Live verification suites & chain probes
scorer/           Track 2 WASM scoring module + test/comparison harnesses
telegraph/        Miner YAML, registration runbook, shipped .wasm binaries
deploy/           pm2 + nginx configs
docs/             X update log
```

## Verified-facts engineering

Everything here was built against the live network, not the docs alone: RPC limits probed empirically, competitor answer formats pulled from their live APIs, the champion scorer benchmarked with its own binary, and every registration hash verified end-to-end before submission. See `telegraph/REGISTRATION.md` for the full runbook.

— Built for the [Telegraph Protocol](https://telegraphprotocol.com) Season I Hackathon · [@Telegraphprotoc](https://x.com/telegraphprotoc)
