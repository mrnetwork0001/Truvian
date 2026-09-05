# Truvian Shield — stand-out build plan (Track 3)

Approved 2026-09-05. Deadline 2026-09-07 23:59 UTC. Build in this order; item 1 gates the public DNS launch.

## Tier 1 — must do

1. **Rate limiting and a spend cap.** Every check costs up to $0.04 USDC from the payer wallet. Once truvian.xyz is public, one script can drain it and take the site down. Per-IP limits, a daily global cap, and a "funded for N more checks" indicator in the stats strip.
2. **One-click demo presets.** "Try SAFE" (a normal transfer) and "Try BLOCK" (a real reverted Base transaction). Judges will not type a 64-char hash.
3. **Live per-check progress.** Stream each check as it lands ("FEE · pass · 0.8s · Truvian 8453 …") so the report visibly assembles itself from four separate paid miner answers, instead of a 10-second spinner.
4. **Shareable receipts + public "recent checks" feed.** Every report gets a permalink; the landing page lists the latest ones with their signal hashes, so "no mocked data" is verifiable on the Telegraph node in one hop.

## Tier 2 — strong differentiators

5. **In-app signal verification.** A "Verify on node" button resolves the hash through our server and shows "recorded by miner truvian-onchain-truth at <time>" inline.
6. **"Paid to miners" counter.** Real USDC spent, summed from actual x402 settlements.
7. **Drop-in guard for agents.** A working example that wraps a viem wallet client so `sendTransaction` refuses on BLOCK, plus the curl recipe.
8. **"Why Truvian" band on the landing.** Miner + scorer + Shield, one team, full stack.

## Tier 3 — submission assets (user)

9. 60–90 s screen recording: paste a hash, watch four checks arrive, open a receipt, resolve the hash on the node.
10. README "Submission" section and the X thread, both linking a live receipt permalink.

## Out of scope

New intents or chains, a Next.js rewrite, wallet connect, anything not backed by a live miner call.
