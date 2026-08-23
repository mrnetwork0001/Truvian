# 🛡️ Truvian — Exact On-Chain Truth Engine

> **Telegraph Protocol Season I Hackathon — corrected master blueprint (2026-08-23)**
> *Track 1 (Miner) + Track 2 (Script Author) now · Track 3 (Application) from Aug 31*
> **Author:** `mrnetwork`

---

## 📌 Executive Summary
Telegraph ranks miners per **intent** against ground truth and routes real demand to the best ones. Truvian competes where engineering rigor is the whole game: **Tier A deterministic intents scored by WASM exact match**. Our miner serves `ONCHAIN_TX_LOOKUP` and `GAS_PRICE` on Base with answers that are *provably exactly right* — including the OP-stack L1 fee component most implementations forget. The same verification machinery becomes our Track 2 evaluation script, and in Track 3 it powers **Truvian Shield**, the execution-safety agent from the original vision — rebuilt on top of real Telegraph miners as the rules require.

**This spec supersedes the original blueprint.** The original assumed an invented `verify-execution` intent, a $15K single-round pool, simultaneous tracks, and X Layer as the target chain. All four were wrong. The intent list is finalized (40 intents), H1 pays $5K (season $15K), tracks are sequential, and Telegraph is built on **Base**.

---

## 🏗️ Architecture & Track Alignment

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     TRUVIAN × TELEGRAPH (H1, corrected)                  │
└──────────────────────────────────────────────────────────────────────────┘

 TRACK 1 · Aug 17–31                          TRACK 2 · Aug 17–31
┌───────────────────────────────┐            ┌───────────────────────────────┐
│ Truvian Miner (Base, viem)    │  scored by │ Truvian Canonical Evaluator   │
│  · ONCHAIN_TX_LOOKUP (Tier A) │ ◄───────── │  · ground truth from raw RPC  │
│  · GAS_PRICE       (Tier A)   │            │    receipts & logs            │
│  envelope-agnostic handlers   │            │  · exact-match, gaming-       │
│  + thin Telegraph adapter     │            │    resistant                  │
└──────────────┬────────────────┘            └───────────────────────────────┘
               │ routed demand (probabilistic, rank-weighted)
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ TRACK 3 · Aug 31–Sep 7 — TRUVIAN SHIELD                                  │
│ Execution-safety agent + dashboard. Before an agent signs, Shield pulls  │
│ live Telegraph miner signals (CRYPTO_PRICE, GAS_PRICE, TVL_LOOKUP,       │
│ ONCHAIN_TX_LOOKUP) and issues a go/no-go with evidence. Real miners      │
│ only — mocked data is disqualifying. Drives request volume back to our   │
│ own Track 1 miner.                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Component Specifications

### 1. Track 1 — Truvian Miner (Supply Layer)
Two Tier A intents, chosen because both are scored by exact match and share one Base RPC data layer:

**`ONCHAIN_TX_LOOKUP`** — input: `{ chain, txHash }`. Output (normalized, deterministic):
- `status`, `blockNumber`, `blockHash`, `from`, `to`, `contractAddress`, `nonce`-free receipt facts
- `valueWei`, `gasUsed`, `effectiveGasPrice`, `l1Fee`, `totalFeeWei = gasUsed·effectiveGasPrice + l1Fee`
- decoded ERC-20 `Transfer` events: `{ token, from, to, amount }`
- All big numbers as decimal strings; addresses EIP-55 checksummed; stable key order.

**`GAS_PRICE`** — input: `{ chain }`. Output anchored to a specific block:
- `blockNumber`, `baseFeePerGas`, `gasPrice` (eth_gasPrice), `maxPriorityFeePerGas`
- fee-history percentiles (p25/p50/p75 over 5 blocks), plus OP-stack `l1GasPrice` on Base.

**Design rule:** handlers are pure `(input) → payload` functions with no knowledge of Telegraph's envelope. A thin adapter maps Telegraph's request/response contract onto them once recon confirms it. This is deliberate: the envelope is currently **unknown** and will not be guessed.

### 2. Track 2 — Truvian Canonical Evaluator (Quality Layer)
Scores any miner's `ONCHAIN_TX_LOOKUP`/`GAS_PRICE` answer against ground truth re-derived live from raw `eth_getTransactionReceipt` / `eth_feeHistory`:
- **Exact-match fields** (status, hashes, addresses, wei amounts): binary per-field score.
- **Gaming resistance:** ground truth is computed from the chain at evaluation time by the script itself — a miner cannot influence it; malformed/extra fields penalized; reverted-tx handling explicitly tested.
- Accuracy = weighted exact-field agreement; failed/unparseable responses score 0.

### 3. Track 3 — Truvian Shield (Demand Layer, from Aug 31)
The original Truvian concept, legalized: pre-signature safety verdicts built from **live Telegraph miner responses** — price sanity (CRYPTO_PRICE), fee spike detection (GAS_PRICE), venue liquidity (TVL_LOOKUP), and post-trade verification (ONCHAIN_TX_LOOKUP). Next.js dashboard with live verdict feed. Every Shield check is real routed demand — which feeds the "applications built on your miner / total requests served" judging criteria for our own Track 1 entry.

---

## 🏆 Scoring Strategy (from the published rules)
- **75%** Normalized Performance *within the intent* — best miner in the intent gets full marks, so the target is #1 in `ONCHAIN_TX_LOOKUP`, not global volume.
- **25%** X engagement — regular tagged updates to **@Telegraphprotoc**. Ship-and-post cadence: every meaningful milestone posts same day.
- **Guardrail:** intent needs ≥3 miners and ≥100 real Track 3 requests → Truvian Shield exists partly to guarantee our intents cross the demand bar.

## ⏱️ Remaining-Days Plan (Aug 23 → Sep 7)
- **Now:** Base data core + both intent handlers + local verification (envelope-agnostic). ✅ in progress
- **On recon:** register miner, wire the Telegraph adapter, go live on the leaderboard; submit Track 2 script; first X post.
- **Aug 24–30:** harden (fallback RPCs, reorg safety, latency), monitor ranking, daily X updates.
- **Aug 31–Sep 7:** build & ship Truvian Shield on live miners; drive real request volume; demo video; final submission.
