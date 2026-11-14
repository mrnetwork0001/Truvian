# Truvian - Telegraph Registration Runbook

> **Season II (Telegraph V2) supersedes most of this file.** The section
> below is current as of 2026-11-12. Everything under "Season I runbook" is
> kept for history and describes a deployment that no longer exists.

## Season II runbook (verified live 2026-11-12)

**What moved.** Chain: Ethereum Sepolia (11155111), not Base Sepolia.
Diamond: `0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b`. RPC:
`https://ethereum-sepolia-rpc.publicnode.com`. Node is unchanged
(`https://devnode.telegraphprotocol.com`). Docs, rules and the registration UI
are on anjoman.ai (`/docs`, `/dashboard/hackathon/season-2/rules`,
`/dashboard/earn`, `/dashboard/eval`).

**Our registration.** Wallet `0xcd0a2370f2dc12c1802707b7d9ab3fec891e3c02`,
registration id **172** (carried over 2026-10-24), slug
`truvian-onchain-truth`, intents `ONCHAIN_TX_LOOKUP_GENERAL` and
`GAS_PRICE_GENERAL` (V2 lists intents, never family prefixes). List what the
wallet holds:
`curl -s $NODE/miner-dispatcher/miners/address/<wallet>/yamls`.

**How answers are read now.** Each intent has a response format
(`GET $NODE/engine/v1/intents/<FAMILY>` -> `response.fields`; one field is
`scored: true`). The node reads a miner's answer into those fields, exactly by
path when the YAML declares an `intent_mapping`, otherwise with a parser model.
Scored fields: `block_number` (ONCHAIN_TX_LOOKUP) and `gas_price_gwei`
(GAS_PRICE). `telegraph/truvian-miner.yaml` is in the V2 format and maps both.

**Updating the miner** (`updateMiner` ends registration 172 and creates a new
id; a new registration spends its first 7 days in the grace period):
1. Deploy the miner code first - the YAML's `intent_mapping` reads fields
   (`tx_hash`, `block_number`, `gas_price_gwei`, ...) the old build does not emit.
   Check: `curl -s 'https://miner.truvian.xyz/gas?chain=ethereum' | jq .gas_price_gwei`.
2. Host the YAML at an immutable URL (commit-pinned GitHub raw or IPFS) and
   take its SHA-256: `shasum -a 256 telegraph/truvian-miner.yaml`.
3. Dry run (free), then send:
```bash
DIAMOND=0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b
RPC=https://ethereum-sepolia-rpc.publicnode.com
ARGS=(172 "$YAML_URL" "0x$YAML_SHA256" "$FEE_ADDRESS" 10000 '["ONCHAIN_TX_LOOKUP_GENERAL","GAS_PRICE_GENERAL"]')
cast call $DIAMOND "updateMiner(uint256,string,bytes32,address,uint256,string[])(uint256)" "${ARGS[@]}" --from $MINER_ADDRESS --rpc-url $RPC
cast send $DIAMOND "updateMiner(uint256,string,bytes32,address,uint256,string[])" "${ARGS[@]}" --rpc-url $RPC --private-key $MINER_PRIVATE_KEY
```
   The dry run from our wallet returned a new id on 2026-11-12 with 0 MACHINA
   held and 0 allowance, so the update takes no further bond.
4. Activation follows in about 10 to 15 minutes. Read the verdict by the new
   id: `curl -s $NODE/api/miners/<newId> | jq '.miner | {activation_status, rejection_reason}'`.
   If the update is refused, registration 172 keeps serving.

**Reading our standing.** `GET $NODE/leaderboard/miners/epoch/<n>` has every
intent ranked in that epoch. The `scores[]` in `/api/miners` only holds a
miner's most recent epoch, so an intent ranked in an earlier epoch looks
unscored there. Epochs are 1 hour on the testnet; not every intent is ranked
every epoch. Epoch 2070: `ONCHAIN_TX_LOOKUP_GENERAL` rank 12 of 27 (0.282,
leader 0.9415). Epoch 2072: `GAS_PRICE_GENERAL` rank 2 of 28 (0.9984).

**Evaluators.** Season I `rank_answer` WASM modules are refused. V2 takes a
comparator WASM (deterministic intents; exports `imw_score_deterministic`,
`imw_alloc`, `imw_free`) or a safetensors LoRA adapter (judgment intents),
registered on a family prefix with a $5 MACHINA bond and a runnable URL, plus
evaluation material uploaded to `POST $NODE/api/evalpool/submissions` signed
by the contributor wallet. Work is tracked per intent family as issues in
`telegraphprotocol/bounties`.

---

# Season I runbook (historical)

All facts below were verified live on 2026-08-23 (not taken from marketing pages).

## Prerequisites
1. **Miner API publicly reachable over HTTPS** at the `base_url` in
   `truvian-miner.yaml` (deploy `npm run dev` behind a reverse proxy on the
   VPS; must stay live through Sep 7 - uptime is judged).
2. **A wallet on Base Sepolia (chain 84532)** with a little gas ETH
   (registration is gas-only, no bond). Faucets: Coinbase/Alchemy Base Sepolia
   faucets.
3. Replace `base_url` in `truvian-miner.yaml` with the real VPS domain first.

## Track 1 - Register the miner (portal path, recommended)
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
DEAD registry - it rejects every intent. Do not use it.

## ⚠️ Hosting rule for WASM binaries (learned the hard way)
The VPS uploads at ~130 KB/s. That is fine for the miner's small JSON
responses (`/tx` and `/gas` answer in ~0.7s) but NOT for large scorer
binaries: v8 (23 MB, MiniLM weights) took >4 minutes to fetch and the
node's evaluation stalled in `pending` indefinitely (registration 947).

**Host any scorer binary over ~1 MB on commit-pinned GitHub raw instead** -
the repo is public, the URL is immutable, and it serves at ~3.6 MB/s
(verified byte-identical by keccak):

    https://raw.githubusercontent.com/mrnetwork0001/Truvian/<COMMIT_SHA>/telegraph/<binary>.wasm

Get the SHA with `git rev-parse HEAD` after pushing. This is also how the
competing champion hosts its 24 MB binary.

## Track 2 - Register the WASM scorer
Built artifact: `telegraph/truvian_scorer.wasm` (112,236 bytes) -
keccak256 `0x3b581da2712e2ad7f01b08919e646a44afebea944bdc7d13f65b58645dd22c16`.
1. Host it at a stable public URL serving the EXACT bytes. Plan A:
   `https://miner.truvian.xyz/truvian_scorer.wasm` (nginx static location in
   `deploy/nginx-miner.conf`; re-download and keccak-verify after upload).
   Plan B (if the repo is made public): a commit-pinned
   raw.githubusercontent.com URL - immutable by construction. The repo is
   currently PRIVATE, so raw URLs 404.
2. Portal: "Submit WASM" flow at integrate.telegraphprotocol.com, **or**
   directly: `registerWasm(bytes32 wasmHash, string wasmUrl, string intent)`
   on the Diamond - `wasmHash` = **keccak256** of the exact hosted bytes
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
- ONCHAIN_TX_LOOKUP: 6 miners - chainsight-oracle 0.884, degenlens-onchain 0.830,
  then 0.017 / 0.009 / 0 / 0. Target: rank 1.
- GAS_PRICE: 3 miners - top score 0.0073 (effectively broken). Registering makes
  4 miners (≥3 guardrail met); scoring even moderately ≈ rank 1.

## Mandatory non-code judging items
- Join Discord: https://discord.gg/telegraphprotocol (required by rules)
- X updates tagged @Telegraphprotoc (25% of Track 1 score) - drafts in
  `docs/x-updates.md`
