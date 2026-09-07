# 🛡️ Truvian - Exact Onchain Truth Engine

**Telegraph Protocol Season I Hackathon** · Tracks 1, 2 & 3 · by [`mrnetwork0001`](https://github.com/mrnetwork0001)

Truvian answers onchain questions **exactly**, **judges** other miners' answers for exactness, and **pays** for both. One codebase across all three tracks: the supply, the grading, and the demand.

**▶ [Watch the 3-minute demo](https://x.com/encrypt_wizard/status/2096818596051575158)** · **[Try it live at truvian.xyz](https://truvian.xyz)**

---

## What's live right now

| Piece | Status |
|---|---|
| **Miner** - Track 1 · [`truvian-onchain-truth`](https://miner.truvian.xyz/health) · reg #172 | 🟢 **Active** - rank 2 in `ONCHAIN_TX_LOOKUP` (0.910) and `GAS_PRICE` on its debut epoch |
| **WASM scoring module** - Track 2 · reg #544, then #617 | 🏆 **Held champion twice** for `ONCHAIN_TX_LOOKUP` - the module validators run to score every miner in the intent - before being dethroned in an open arms race |
| **Truvian Shield** - Track 3 · [truvian.xyz](https://truvian.xyz) | 🟢 **Live** - execution-safety checkpoint that pays live Telegraph miners per check |

## Try it in 30 seconds

Open **[truvian.xyz/app](https://truvian.xyz/app)** and press one of the two example buttons. No wallet, no transaction hash, no signup - five free checks per visitor per day.

- **A normal transfer → SAFE.** Three checks pass, score 100.
- **A reverted counterparty → BLOCK.** Score 30, on a Base transaction that genuinely reverted.

Watch each check arrive one at a time, named, timed and priced. Then press **Verify on node** on any result: the Telegraph node confirms the answer was recorded, by which miner, and when.

Prefer a terminal?

```bash
curl -sX POST https://truvian.xyz/api/check \
  -H 'content-type: application/json' \
  -d '{"chain":"base","to":"0x83d55acdc72027ed339d267eebaf9a41e47490d5","valueEth":60,
       "txHash":"0xef26d7918abb2ba7cbe6a121507a3f2a4f54bb9c31f3e568643501e2394c9863"}'
# → {"verdict":"BLOCK","score":30,"reasons":[...],"checks":[...]}
```

---

## Track 1 - the miner

A deterministic HTTP API over live JSON-RPC (Base, Ethereum, Base Sepolia, X Layer):

- **`GET /tx?chain=base&hash=0x…`** - the full canonical facts of a transaction: status, block, addresses, value, decoded ERC-20 transfers, and the **true total fee including the OP-stack L1 data fee** (`gasUsed × effectiveGasPrice + l1Fee`) that naive implementations silently drop.
- **`GET /gas?chain=base`** - a block-anchored fee snapshot: gas price, base and priority fee, EIP-1559 percentiles, L1 base fee.

Every response leads with a number-first plain-language answer - the text validators actually score - followed by the complete structured payload. Every figure is independently reproducible from public RPC, and identical finalized-chain state always produces byte-identical output: no floats, no clock reads in scored fields, bigints as decimal strings.

Two decisions did the heavy lifting. **Answers are prose, not JSON**, because validators score the answer as text and bare JSON scores near zero. And **the chain is auto-detected** rather than defaulting hard to Base - an early version returned a 404 with no answer text for anything off Base and scored exactly 0; it now searches candidate chains and always returns scoreable prose, even on error.

```bash
npm run test:miner     # 33 live-verification checks: fee invariants, determinism, revert paths
```

## Track 2 - the scoring module (`scorer/`)

A Rust → `wasm32-unknown-unknown` judge implementing `rank_answer(question, ground_truth, miner_answer) → f32`. It grades on **facts, not vocabulary**:

- **Typed-fact recall** - extracts transaction hashes, addresses, uint256 values (compared exactly, not fuzzily) and status words.
- **Negation-aware** - *"did **not** succeed in block N"* with every number correct scores ~0.03. Embedding-similarity judges rank that answer *above* the correct one.
- **Anti-gaming** - value-dump answers, near-miss numerics, corrupted hex, from/to swaps and structured-blob stuffing are each detected and penalised.

Promoted to champion on its third gauntlet attempt (ordering 15/15 · margin 0.565 · real-traffic agreement 0.645). Every rejection was measured and fixed empirically rather than guessed at: the fixture suite, the champion-comparison harness (`compare.sh`) and the agreement harness (`agree.sh`) are all in-repo and reproducible, and all 19 shipped binaries are kept in `telegraph/` so any result can be re-run.

```bash
cd scorer && cargo build --release --target wasm32-unknown-unknown
./test.sh              # official wazero harness
```

## Track 3 - Truvian Shield (`src/shield/`)

An execution-safety checkpoint for onchain agents, live at **[truvian.xyz](https://truvian.xyz)**.

Before an agent signs, it POSTs the proposed transaction. Shield fans out to **live** Telegraph miners and returns a `SAFE` / `CAUTION` / `BLOCK` verdict with per-check evidence:

| Check | Intent | Asks |
|---|---|---|
| **FEE** | `GAS_PRICE` | is gas sane on this chain right now? |
| **COUNTERPARTY** | `ONCHAIN_TX_LOOKUP` | did the referenced transaction actually succeed? |
| **VALUE** | `CRYPTO_PRICE` | how many dollars are at risk? |
| **LIQUIDITY** | `TVL_LOOKUP` | is the named protocol still liquid? |

Scoring is deterministic and published: start at 100; each warning −15, failure −35, error −10. 80+ is `SAFE`, 50-79 `CAUTION`, below 50 `BLOCK`. Any single failure caps the verdict at `CAUTION`; two failures force `BLOCK`.

**Nothing is mocked or cached.** Every check is a real x402 payment in USDC to a live miner at request time. An unreachable miner is graded `error` - never quietly filled in.

**Everything is verifiable.** Each answer carries a Telegraph signal hash that resolves on the node, every report gets a permalink (`/app?r=<id>`), and recent checks are published at `/api/recent`. The claim "no mocked data" is one click from being checked.

**Shield is itself an x402 service.** Past the free allowance, `POST /api/check` answers `402` with a price instead of a refusal - so agents pay per check, and the app funds the miners it depends on. It charges $0.05 against a miner cost of up to $0.04.

**It fails closed.** [`src/agent/guard.ts`](src/agent/guard.ts) wraps a viem wallet so `sendTransaction` refuses on `BLOCK`, and refuses too when Shield is unreachable - because a safety check that fails open is not a safety check.

```bash
npm run test:shield    # 103 assertions: verdict engine, rate limiter, guard thresholds
npm run readiness      # 58-check end-to-end suite against live miners and real payments
npm run demo:guard     # watch an agent sign one transaction and refuse another
```

### API

| Endpoint | Purpose |
|---|---|
| `POST /api/check` | `{chain?, to?, valueEth?, txHash?, protocol?}` → verdict, score, reasons, checks. Add `?stream=1` for NDJSON progress |
| `GET /api/verify/:txHash` | single-transaction verification report |
| `GET /api/report/:id` | a stored report by permalink id |
| `GET /api/recent` | public feed of recent checks |
| `GET /api/signal/:hash` | resolve a Telegraph signal hash on the node |
| `GET /api/stats` | live counters, budget, price |

---

## How the three tracks fit together

```
                  ┌─────────────────────────────────────────┐
                  │           TELEGRAPH PROTOCOL            │
                  └─────────────────────────────────────────┘
                       ▲                            ▲
    Track 1: SUPPLY    │                            │   Track 2: QUALITY
  ┌────────────────────┴─────┐      ┌───────────────┴────────────┐
  │ truvian-onchain-truth    │      │ Truvian WASM scorer        │
  │ reg #172 · Base          │      │ reg #544 / #617            │
  │ ONCHAIN_TX_LOOKUP · GAS  │      │ grades every miner's answer│
  └────────────────────▲─────┘      └────────────────────────────┘
                       │ paid queries · $0.01 each over x402
  ┌────────────────────┴────────────────────────────────────────────┐
  │ Track 3: DEMAND - Truvian Shield (truvian.xyz)                  │
  │ four checks → SAFE / CAUTION / BLOCK → receipts + signal hashes  │
  └─────────────────────────────────────────────────────────────────┘
```

Most entries consume the network. Truvian supplies it, grades it, and is its paying customer.

## Verify our claims

Nothing here asks for trust:

- **The miner is live** - <https://miner.truvian.xyz/health>
- **The app is live** - <https://truvian.xyz> · counters at [`/api/stats`](https://truvian.xyz/api/stats)
- **Answers are recorded on the node** - run a check, then `GET /api/signal/<hash>`, or resolve it yourself at `devnode.telegraphprotocol.com/engine/v1/signal/<hash>`
- **Payments settle onchain** - every paid check returns an `X-PAYMENT-RESPONSE` header carrying a Base Sepolia transaction hash
- **The scorer's results reproduce** - `scorer/test.sh` runs the official wazero harness against the shipped binaries

## Repo map

```
src/miner/        Fastify miner: intent handlers + server            (Track 1)
scorer/           Rust → WASM scoring module + test harnesses        (Track 2)
src/shield/       Shield API, verdict engine, x402 client + server,
                  receipts, rate limiting, dashboard                 (Track 3)
src/agent/        Drop-in viem guard for autonomous agents
src/config/       Chain registry (verified RPCs, fallback transports)
src/scripts/      Live verification suites, chain probes, demo capture
telegraph/        Miner YAML, registration runbook, shipped .wasm binaries
video/            Remotion project for the demo video
deploy/           pm2 + nginx configs
docs/             Build plan + X update log
```

## Engineering notes

Everything was built against the live network rather than the docs alone: RPC limits probed empirically, competitor answer formats pulled from their live APIs, the champion scorer benchmarked with its own binary, and every registration hash verified end-to-end before submission. Where the documentation and the network disagreed, the network won - the live deployment is on Base Sepolia, not the mainnet address older READMEs advertise. See [`telegraph/REGISTRATION.md`](telegraph/REGISTRATION.md) for the full runbook and [`telegraph/TRACK3.md`](telegraph/TRACK3.md) for the Track 3 deployment.

**Known limits, stated plainly.** Verdicts are advisory: Shield surfaces evidence and refuses, but never holds keys and never signs. The thresholds are heuristics, published so you can disagree with them. The free tier is capped (5 checks per IP per day; 300 checks and $5 globally) because every check spends real USDC. And a verdict is only as good as the miners answering it - which is exactly why every answer ships with a hash you can check.

---

Built for the [Telegraph Protocol](https://telegraphprotocol.com) Season I Hackathon · [@Telegraphprotoc](https://x.com/telegraphprotoc)
