# 🛡️ TRUVIAN — Project Context & Developer Directives

## 📌 Core Identity & Project Goal
**Truvian** is an exact on-chain truth engine competing in the **Telegraph Protocol Season I Hackathon** (H1: $5K USD, Aug 17 – Sep 7; season total $15K across three rounds).
- **Track 1 (Miner):** Serve the `ONCHAIN_TX_LOOKUP` (primary) and `GAS_PRICE` (secondary) intents on **Base** with deterministic, exact-match-grade responses. Tier A intents are scored by WASM exact match — exactness wins, not vibes.
- **Track 2 (Script Author):** Evaluation script scoring miners for on-chain intents against ground truth parsed directly from RPC receipts and logs.
- **Track 3 (App, opens Aug 31):** *Truvian Shield* — an execution-safety agent/dashboard consuming live Telegraph miners (`CRYPTO_PRICE`, `GAS_PRICE`, `TVL_LOOKUP`, `ONCHAIN_TX_LOOKUP`) to decide whether an agent should sign a transaction.

## ✅ Verified Facts (do not trust marketing copy over these)
- **The live Telegraph deployment is on Base Sepolia (84532)**, not mainnet. Live Diamond contract: `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8` (the `0xac683…` address in older READMEs is dead). Node: `https://devnode.telegraphprotocol.com`. Registration portal (auto-enters hackathon): `https://integrate.telegraphprotocol.com`. Live leaderboard JSON: `https://explorer.telegraphprotocol.com/api/leaderboard/miners`. Full mechanics in `telegraph/REGISTRATION.md`.
- **Validators score miner responses against ground truth as TEXT** (WASM scorer gets question/ground_truth/miner_answer as strings). Miners returning bare JSON score ~0 on the live leaderboard; number-first natural-language answers score 0.83–0.88. Every intent response must lead with an `answer` field composed this way.
- **A miner = any HTTP API + YAML descriptor + one `registerMiner` tx** (gas-only, permissionless). YAML schema is `additionalProperties:false` everywhere — see `telegraph/truvian-miner.yaml`. Track 2 = a Rust→WASM scoring module (`scorer/`), registered per-intent via `registerWasm`, which must beat the incumbent champion on a node-internal benchmark.
- **Base mainnet data layer** (chain 8453). Working RPCs: `https://mainnet.base.org`, `https://base-rpc.publicnode.com` (`base.llamarpc.com` is dead). Payments settle via x402.
- **Intents are finalized** — 40 total (18 Tier A deterministic/WASM-exact-match, 22 Tier B LLM-judge). A miner MUST serve a listed intent; there is no slippage/execution-verification intent.
- **Timeline:** Tracks 1 & 2: Aug 17–31. Track 3: Aug 31–Sep 7. Winners: announced from Sep 19.
- **Prizes (H1):** Miner $2,000 / $1,000 / $600 / $400 · Scripts $1,000 · Apps $2,000. Total $5,000. H2 (Oct): $10K. H3 (Dec): mainnet.
- **Scoring (Track 1):** 75% Normalized Performance within your intent (your avg canonical score ÷ best miner's avg in that intent) + 25% X engagement, posts tagged **@Telegraphprotoc** (NOT @TelegraphProto).
- **Eligibility guardrail:** an intent needs ≥3 active miners and ≥100 real Track 3 requests for cash-prize eligibility.
- **Track 3 must use real Telegraph miners** — mocked/simulated data is grounds for disqualification. Miners must stay live through Track 3.
- **Base receipts are OP-stack:** total tx cost = `gasUsed × effectiveGasPrice + l1Fee`. Receipts include `l1Fee`, `l1GasPrice`, `l1GasUsed`, `l1BaseFeeScalar`. Ignoring L1 fee = wrong answers.
- **X Layer legacy (kept for reference):** chain 196, only `rpc.xlayer.tech` responds, `eth_getLogs` hard-capped at 100 blocks, canonical Uniswap V3 NOT deployed, Multicall3 is. See `src/scripts/probe-chain.ts`.
- **Telegraph subnets observed in the wild:** ItsAI (32, AI-text detection), Bitmind (34, AI-image), DeSearch (101, news), Groq (102, LLM), per `telegraphprotocol/telegraph-usecases`.

## ⚠️ Open Unknowns (resolve before building on top)
- Exact Telegraph miner registration flow and request/response envelope — recon in progress; DO NOT invent endpoints. The intent handlers in `src/miner/` are envelope-agnostic; a thin Telegraph adapter wraps them once the contract is known.
- Canonical ground-truth format for Tier A scoring (field set, address casing, hex vs decimal) — until known, handlers emit both raw-faithful and normalized forms.

## 🛠️ Tech Stack & Architecture
- **Backend / Miner:** Node.js / TypeScript (ESM), `viem`, Fastify.
- **Frontend / Dashboard (Track 3):** Next.js (App Router), Tailwind CSS, Lucide icons, Framer Motion, Recharts.
- **Blockchain Target:** **Base (8453) primary**; Ethereum & X Layer secondary in the chain registry.

## ⚡ Execution Rules for Claude Code
1. Never guess API endpoints or data schemas: Inspect actual RPC responses or code definitions before writing consuming logic.
2. No Superficial Symptom Patches: Fix root causes; never swallow errors or mock empty fallbacks unless explicitly instructed.
3. Always Run Verification: Validate code changes with build or test scripts before confirming completion.
4. Preserve Documentation: Read `TRUVIAN_PROJECT_SPEC.md` for full functional specifications.
5. Determinism is the product: intent handlers must return byte-identical output for identical finalized-chain state. No floats, no timestamps-of-now in scored fields, bigints as decimal strings.
