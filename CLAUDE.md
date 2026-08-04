# 🛡️ TRUVIAN — Project Context & Developer Directives

## 📌 Core Identity & Project Goal
**Truvian** is a Verifiable Execution & Slippage Protection Engine for autonomous AI agents, competing in the Telegraph Protocol Season I Hackathon ($15k USD).
- **Track 1 (Miner):** Wraps DEX liquidity depth, mempool simulation, and routing safety to output cryptographic execution guarantees before an agent signs.
- **Track 2 (Script Author):** Evaluates Miner predictions against exact on-chain mined block logs (`Transfer` events & output logs).
- **Track 3 (App/Agent):** Autonomous procurement/trading agent dashboard that routes all executions through Truvian to generate high-frequency verifiable signal demand.

## 🛠️ Tech Stack & Architecture
- **Backend / Miner:** Node.js / TypeScript, `viem` / `ethers.js`, Fastify / Express.
- **Frontend / Dashboard:** Next.js (App Router), Tailwind CSS, Lucide icons, Framer Motion, Recharts.
- **Blockchain Target:** X Layer (Chain 196) / Base / Ethereum.
- **Telegraph Protocol SDK:** Telegraph Miner & Evaluation Script wrappers.

## ⚡ Execution Rules for Claude Code
1. Never guess API endpoints or data schemas: Inspect actual RPC responses or code definitions before writing consuming logic.
2. No Superficial Symptom Patches: Fix root causes; never swallow errors or mock empty fallbacks unless explicitly instructed.
3. Always Run Verification: Validate code changes with build or test scripts before confirming completion.
4. Preserve Documentation: Read `TRUVIAN_PROJECT_SPEC.md` for full functional specifications.
