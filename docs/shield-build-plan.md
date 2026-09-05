# Truvian Shield — stand-out build plan (Track 3)

Approved 2026-09-05. Deadline 2026-09-07 23:59 UTC. Build in this order; item 1 gates the public DNS launch.

## Tier 1 — must do

1. **Rate limiting and a spend cap.** Every check costs up to $0.04 USDC from the payer wallet. Once truvian.xyz is public, one script can drain it and take the site down. Per-IP limits, a daily global cap, and a "funded for N more checks" indicator in the stats strip.
2. **Wallet connect + pay-per-check (Shield as an x402 service).** Injected-wallet connect (MetaMask, Coinbase Wallet, Rabby) on Base Sepolia. `POST /api/check` answers 402 with Shield's price (5¢ per check, miner cost up to 4¢); the wallet signs a gasless EIP-3009 USDC authorization; Shield verifies via the facilitator, runs the miner queries, settles to the Truvian wallet and returns the report with the payment receipt. Agents pay the same way programmatically. A small free tier (per-IP daily allowance + demo presets) stays Truvian-paid so judges see a verdict without testnet USDC. Stats strip shows "earned $X from N paid checks · paid $Y to miners".
3. **One-click demo presets.** "Try SAFE" (a normal transfer) and "Try BLOCK" (a real reverted Base transaction). Judges will not type a 64-char hash.
4. **Live per-check progress.** Stream each check as it lands ("FEE · pass · 0.8s · Truvian 8453 …") so the report visibly assembles itself from four separate paid miner answers, instead of a 10-second spinner.
5. **Shareable receipts + public "recent checks" feed.** Every report gets a permalink; the landing page lists the latest ones with their signal hashes, so "no mocked data" is verifiable on the Telegraph node in one hop.

## Tier 2 — strong differentiators

6. **In-app signal verification.** A "Verify on node" button resolves the hash through our server and shows "recorded by miner truvian-onchain-truth at <time>" inline.
7. **"Paid to miners" counter.** Real USDC spent, summed from actual x402 settlements.
8. **Drop-in guard for agents.** A working example that wraps a viem wallet client so `sendTransaction` refuses on BLOCK, plus the curl recipe.
9. **"Why Truvian" band on the landing.** Miner + scorer + Shield, one team, full stack.

## Tier 3 — submission assets (user)

10. 60–90 s screen recording: paste a hash, watch four checks arrive, open a receipt, resolve the hash on the node.
11. README "Submission" section and the X thread, both linking a live receipt permalink.

## Out of scope

New intents or chains, a Next.js rewrite, anything not backed by a live miner call.
