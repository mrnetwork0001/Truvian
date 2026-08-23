# Truvian — Telegraph Registration Runbook

All facts below were verified live on 2026-08-23 (not taken from marketing pages).

## Prerequisites
1. **Miner API publicly reachable over HTTPS** at the `base_url` in
   `truvian-miner.yaml` (deploy `npm run dev` behind a reverse proxy on the
   VPS; must stay live through Sep 7 — uptime is judged).
2. **A wallet on Base Sepolia (chain 84532)** with a little gas ETH
   (registration is gas-only, no bond). Faucets: Coinbase/Alchemy Base Sepolia
   faucets.
3. Replace `base_url` in `truvian-miner.yaml` with the real VPS domain first.

## Track 1 — Register the miner (portal path, recommended)
1. Open **https://integrate.telegraphprotocol.com** → "Connect API"
   (email OTP + wallet connect). **Registering here auto-enters the
   hackathon.**
2. Paste `truvian-miner.yaml`. The portal validates the schema, sandbox-tests
   `/tx` and `/gas` against the live API, pins the YAML to IPFS, and sends the
   `registerMiner` tx from the connected wallet.
3. No API key step needed (auth: none).
4. Verify activation (~1 min):
   `curl https://devnode.telegraphprotocol.com/api/miners/{registrationId}`
   → `activation_status: active`. If `rejected`, the exact validator error is
   in `rejection_reason`; fix and re-register via `updateMiner`.

### Manual fallback (cast)
```bash
DIAMOND=0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8   # live Diamond, Base Sepolia (verified: isCanonicalIntent works here)
YAML_HASH=$(sha256sum truvian-miner.yaml | awk '{print "0x"$1}')  # SHA-256, NOT keccak
# host the YAML at a stable public URL (IPFS recommended), then:
cast send $DIAMOND "registerMiner(string,bytes32,address,uint256,string[])" \
  "$YAML_URL" "$YAML_HASH" "$FEE_ADDRESS" 10000 \
  '["ONCHAIN_TX_LOOKUP","GAS_PRICE"]' \
  --rpc-url https://sepolia.base.org --private-key $MINER_PRIVATE_KEY
```
`10000` = $0.01 USDC floor price (protocol minimum, 6 decimals).
Note: `0xac683bFa8F1C892E23e8300d14c20678C6FC0CA3` (in older READMEs) is a
DEAD registry — it rejects every intent. Do not use it.

## Track 2 — Register the WASM scorer
Built artifact: `telegraph/truvian_scorer.wasm` (112,236 bytes) —
keccak256 `0x3b581da2712e2ad7f01b08919e646a44afebea944bdc7d13f65b58645dd22c16`.
1. Host it at a stable public URL serving the EXACT bytes. Plan A:
   `https://miner.truvian.xyz/truvian_scorer.wasm` (nginx static location in
   `deploy/nginx-miner.conf`; re-download and keccak-verify after upload).
   Plan B (if the repo is made public): a commit-pinned
   raw.githubusercontent.com URL — immutable by construction. The repo is
   currently PRIVATE, so raw URLs 404.
2. Portal: "Submit WASM" flow at integrate.telegraphprotocol.com, **or**
   directly: `registerWasm(bytes32 wasmHash, string wasmUrl, string intent)`
   on the Diamond — `wasmHash` = **keccak256** of the exact hosted bytes
   (the node re-downloads and re-hashes; any mismatch = rejection),
   `intent` = `ONCHAIN_TX_LOOKUP` (one intent per module).
3. It must then pass the promotion gauntlet: structural checks, then beat the
   champion (MiniLM+BM25 baseline) on the node's built-in benchmark.
   Breakdown queryable via the API on rejection.

## Live observability
- Leaderboard JSON: https://explorer.telegraphprotocol.com/api/leaderboard/miners
  (epochs are 9h; per-epoch history at `/api/leaderboard/miners/epoch/{n}`)
- Miner catalog: https://devnode.telegraphprotocol.com/api/miners
- Canonical intents + miner counts: https://devnode.telegraphprotocol.com/engine/v1/intents

## Current competition (epoch 267, verified)
- ONCHAIN_TX_LOOKUP: 6 miners — chainsight-oracle 0.884, degenlens-onchain 0.830,
  then 0.017 / 0.009 / 0 / 0. Target: rank 1.
- GAS_PRICE: 3 miners — top score 0.0073 (effectively broken). Registering makes
  4 miners (≥3 guardrail met); scoring even moderately ≈ rank 1.

## Mandatory non-code judging items
- Join Discord: https://discord.gg/telegraphprotocol (required by rules)
- X updates tagged @Telegraphprotoc (25% of Track 1 score) — drafts in
  `docs/x-updates.md`
