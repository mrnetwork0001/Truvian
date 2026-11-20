# 🛡️ TRUVIAN - Project Context & Developer Directives

## 📌 Core Identity & Project Goal
**Truvian** is an exact onchain truth engine competing in the **Telegraph Protocol Season I Hackathon** (H1: $5K USD, Aug 17 – Sep 7; season total $15K across three rounds).
- **Track 1 (Miner):** Serve the `ONCHAIN_TX_LOOKUP` (primary) and `GAS_PRICE` (secondary) intents on **Base** with deterministic, exact-match-grade responses. Tier A intents are scored by WASM exact match - exactness wins, not vibes.
- **Track 2 (Script Author):** Evaluation script scoring miners for onchain intents against ground truth parsed directly from RPC receipts and logs.
- **Track 3 (App, opens Aug 31):** *Truvian Shield* - an execution-safety agent/dashboard consuming live Telegraph miners (`CRYPTO_PRICE`, `GAS_PRICE`, `TVL_LOOKUP`, `ONCHAIN_TX_LOOKUP`) to decide whether an agent should sign a transaction.

## ✅ Verified Facts (do not trust marketing copy over these)
- **SEASON II / TELEGRAPH V2 (verified 2026-11-12) supersedes the Season I facts below wherever they conflict.** Season II runs 1 Nov - 1 Dec 2026 (final deadline 23:59 UTC), $10K: rules at `https://anjoman.ai/dashboard/hackathon/season-2/rules`, docs at `https://anjoman.ai/docs`. The live deployment is **Ethereum Sepolia (11155111)**. **The Diamond address changes without notice** (it moved with V2 in October and again on 17 Nov): since 2026-11-17 it is `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`, and `0x3624EB…eb99b` and the Base Sepolia Diamond below are retired. Check <https://anjoman.ai/docs/protocol/addresses-and-params> before any transaction; a transaction to a retired Diamond succeeds and is never scored. Our miner was imported to the new Diamond (registration 5252), then updated on 2026-11-20 to registration **6146** serving four intents (adds WALLET_BALANCE_CHECK_GENERAL and TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL; 1.30 test USDC bond); bonds are now test USDC, and epochs and scores restarted on 17 Nov. Intents are grouped into families and miners list intents such as `ONCHAIN_TX_LOOKUP_GENERAL`, never the family prefix. **Answers are no longer scored as text:** each intent has a response format (`GET /engine/v1/intents/<FAMILY>`) with one `scored` field (`block_number`, `gas_price_gwei`), read by path through the YAML's `intent_mapping`. Season I `rank_answer` WASM scorers are refused; evaluators are comparator WASMs, LoRA adapters and evaluation material. We entered the **Miner and Evaluator** tracks. Bounty work moved on 15 Nov from per-intent issues to 15 mission issues (#189-#203) in `telegraphprotocol/bounties`. Current runbook: top of `telegraph/REGISTRATION.md`.
- **The live Telegraph deployment is on Base Sepolia (84532)**, not mainnet. Live Diamond contract: `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8` (the `0xac683…` address in older READMEs is dead). Node: `https://devnode.telegraphprotocol.com`. Registration portal (auto-enters hackathon): `https://integrate.telegraphprotocol.com`. Live leaderboard JSON: `https://explorer.telegraphprotocol.com/api/leaderboard/miners`. Full mechanics in `telegraph/REGISTRATION.md`.
- **Validators score miner responses against ground truth as TEXT** (WASM scorer gets question/ground_truth/miner_answer as strings). Miners returning bare JSON score ~0 on the live leaderboard; number-first natural-language answers score 0.83–0.88. Every intent response must lead with an `answer` field composed this way.
- **A miner = any HTTP API + YAML descriptor + one `registerMiner` tx** (gas-only, permissionless). YAML schema is `additionalProperties:false` everywhere - see `telegraph/truvian-miner.yaml`. Track 2 = a Rust→WASM scoring module (`scorer/`), registered per-intent via `registerWasm`, which must beat the incumbent champion on a node-internal benchmark.
- **Base mainnet data layer** (chain 8453). Working RPCs: `https://mainnet.base.org`, `https://base-rpc.publicnode.com` (`base.llamarpc.com` is dead). Payments settle via x402.
- **Intents are finalized** - 40 total (18 Tier A deterministic/WASM-exact-match, 22 Tier B LLM-judge). A miner MUST serve a listed intent; there is no slippage/execution-verification intent.
- **Timeline:** Tracks 1 & 2: Aug 17–31. Track 3: Aug 31–Sep 7. Winners announced 2026-09-30.
- **RESULT (Season I):** Truvian placed **3rd in the Miner track - $600**. Announcement: <https://x.com/Telegraphprotoc/status/2104484144684098021>. H2 opens in October.
- **Prizes (H1):** Miner $2,000 / $1,000 / $600 / $400 · Scripts $1,000 · Apps $2,000. Total $5,000. H2 (Oct): $10K. H3 (Dec): mainnet.
- **Scoring (Track 1):** 75% Normalized Performance within your intent (your avg canonical score ÷ best miner's avg in that intent) + 25% X engagement, posts tagged **@Telegraphprotoc** (NOT @TelegraphProto).
- **Eligibility guardrail:** an intent needs ≥3 active miners and ≥100 real Track 3 requests for cash-prize eligibility.
- **Track 3 must use real Telegraph miners** - mocked/simulated data is grounds for disqualification. Miners must stay live through Track 3.
- **Base receipts are OP-stack:** total tx cost = `gasUsed × effectiveGasPrice + l1Fee`. Receipts include `l1Fee`, `l1GasPrice`, `l1GasUsed`, `l1BaseFeeScalar`. Ignoring L1 fee = wrong answers.
- **X Layer legacy (kept for reference):** chain 196, only `rpc.xlayer.tech` responds, `eth_getLogs` hard-capped at 100 blocks, canonical Uniswap V3 NOT deployed, Multicall3 is. See `src/scripts/probe-chain.ts`.
- **Telegraph subnets observed in the wild:** ItsAI (32, AI-text detection), Bitmind (34, AI-image), DeSearch (101, news), Groq (102, LLM), per `telegraphprotocol/telegraph-usecases`.

## ⚠️ Open Unknowns (resolve before building on top)
- Exact Telegraph miner registration flow and request/response envelope - recon in progress; DO NOT invent endpoints. The intent handlers in `src/miner/` are envelope-agnostic; a thin Telegraph adapter wraps them once the contract is known.
- Canonical ground-truth format for Tier A scoring (field set, address casing, hex vs decimal) - until known, handlers emit both raw-faithful and normalized forms.

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
