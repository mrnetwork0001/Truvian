# X Thread Draft — Track 3 announcement (Truvian Shield)

4 posts, each ≤ 280 chars, **@Telegraphprotoc** tagged in the first and last
(the judges' table counts tweets mentioning @Telegraphprotoc from the handle
entered at submissions.telegraphprotocol.com — use the same handle).
Post after Shield is live at truvian.xyz.

---

**1/** *(attach: the Shield dashboard showing a completed check with its verdict card)*

> Track 3 for @Telegraphprotoc: Truvian Shield is live at truvian.xyz — an execution-safety checkpoint for AI agents. Before an agent signs a transaction, Shield asks live Telegraph miners what's true on-chain and returns a go/no-go verdict with evidence. 🧵

**2/** *(attach: a CheckReport JSON or the per-check breakdown in the UI)*

> One POST /api/check runs 4 live-miner checks: GAS_PRICE (is gas sane?), ONCHAIN_TX_LOOKUP (does that tx say what the agent thinks?), CRYPTO_PRICE + TVL_LOOKUP (asset & protocol sanity). Each returns pass/warn/fail with evidence; the verdict: SAFE, CAUTION or BLOCK, 0–100.

**3/** *(attach: a signal hash resolving at /engine/v1/signal/{hash})*

> No mocks — every answer comes from a real Telegraph miner, paid per query over x402 (USDC on Base Sepolia), and carries a signal hash anyone can verify against the Telegraph engine. The dashboard shows the receipts, not just the verdict.

**4/**

> Shield is the thesis we mined and judged all season, applied: agents need exact, verifiable on-chain truth at decision time. Try it: truvian.xyz — code + the whole Season I arc: github.com/mrnetwork0001/Truvian @Telegraphprotoc
