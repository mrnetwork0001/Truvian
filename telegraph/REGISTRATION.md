# Truvian - Telegraph Registration Runbook

> **Season II (Telegraph V2) supersedes most of this file.** The section
> below is current as of 2026-11-19. Everything under "Season I runbook" is
> kept for history and describes a deployment that no longer exists.

## Season II runbook (verified live 2026-11-19)

**The contract address changes without notice. Check it before every
transaction.** Telegraph has moved its Diamond twice since Season I: to
Ethereum Sepolia with V2 (our registration there dates from 24 October) and
to a new address on 17 November. No node watches a retired Diamond, so a
transaction sent to one succeeds on-chain and is never seen or scored. The
current address is on
<https://anjoman.ai/docs/protocol/addresses-and-params>; this file names it in
one place only, the `DIAMOND=` line below.

```bash
DIAMOND=0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b   # since 2026-11-17 (block 12151179)
RPC=https://ethereum-sepolia-rpc.publicnode.com
NODE=https://devnode.telegraphprotocol.com
# Is this still the Diamond the node watches, and are we on it? Both must agree.
curl -s $NODE/miner-dispatcher/miners/address/$MINER_ADDRESS/yamls | jq '.yamls[] | {registration_id, activation_status, registered_at}'
cast call $DIAMOND "getMiner(uint256)" <registration_id> --rpc-url $RPC | grep -ic "${MINER_ADDRESS#0x}"   # 1 = our record is on this Diamond
```

Retired: `0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b` (24 Oct to 17 Nov) and
the Base Sepolia Diamond from Season I.

**What moved.** Chain: Ethereum Sepolia (11155111), not Base Sepolia. Node is
unchanged. Docs, rules and the registration UI are on anjoman.ai (`/docs`,
`/dashboard/hackathon/season-2/rules`, `/dashboard/earn`, `/dashboard/eval`).

**The 17 November redeploy.** Existing miners were imported by the admin, so
we did not have to re-register: registration **5252** was read back from the
new Diamond on 2026-11-19 with our wallet and YAML URL in it, and the node
lists it as active. What did change:
- Epoch numbers restarted from 1 and every score was reset.
- Bonds are paid in test USDC (`0xcc194e1a843B658526D0D5C431f670028582Ae17`,
  anyone can `mint(address,uint256)`), not MACHINA. An `updateMiner` now
  reverts with `ERC20: insufficient allowance` until the Diamond is approved
  for the bond; our wallet held 0 test USDC on 2026-11-19.
- Balances and escrow on the old Diamond did not carry over.
- Evaluation-pool rows carried over: our two truth sources are still
  `eligible`.

**Our registration.** Wallet `0xcd0a2370f2dc12c1802707b7d9ab3fec891e3c02`,
registration id **6146**, created by `updateMiner` on 2026-11-20
(tx `0xfb4c59910686f76d80708cc4830a2b54cbc4ae722c8898306494b9cee0568382`,
bond 1.30 test USDC) from 5252, which had been imported to the new Diamond on
2026-11-17. Slug `truvian-onchain-truth`, YAML pinned at commit `e9eb002`
(sha256 `096de4cd…7a83`), intents `ONCHAIN_TX_LOOKUP_GENERAL`,
`GAS_PRICE_GENERAL`, `WALLET_BALANCE_CHECK_GENERAL` and
`TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL` (V2 lists intents, never family
prefixes). The node listed it active with all four about 15 minutes later.

**Since 2026-11-23: registration 6180**, from `updateMiner` on 6146
(tx `0x070cda5788b34ec9b8715eac1831ff012df48aad390af91abaa5211e2dea78d3`,
bond 1.50 test USDC: $1 plus $0.10 for each further intent), YAML pinned at
commit `1507b04` (sha256 `de76685d…20aa`), six intents: the four above plus
`CRYPTO_TRANSFER_VERIFY_GENERAL` (`/transfer`) and
`LIQUIDITY_DEPTH_VERIFY_GENERAL` (`/liquidity`, scored field
`liquidity_usd`). The dry run returned 6180 and the node listed it active
13 minutes after the transaction. For the next update, use 6180 as the
first argument and list all six intents.

**Since 2026-11-25: registration 6194**, from `updateMiner` on 6180
(tx `0xa49244818b8d2dbd8a495909af93bf6f5af985cfd58571f581b6298e984d01f8`,
block 12209795, Diamond `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b` checked
on anjoman.ai's addresses page the same day). Same six intents, fee address
and 10000 minimum price; the YAML is pinned at commit `3c3b94a` (sha256
`8e8e8730…5532`), which describes Solana wallets, mints and signatures
(chains `solana` and `solana-devnet`), so the node can route Solana questions
to us. The bond was already held (`quoteMinerBond(6)` = 1.50), so nothing was
topped up. The dry run returned 6194. For the next update, use 6194.

**How answers are read now.** Each intent has a response format
(`GET $NODE/engine/v1/intents/<FAMILY>` -> `response.fields`; one field is
`scored: true`). The node reads a miner's answer into those fields, exactly by
path when the YAML declares an `intent_mapping`, otherwise with a parser model.
Scored fields: `block_number` (ONCHAIN_TX_LOOKUP) and `gas_price_gwei`
(GAS_PRICE). `telegraph/truvian-miner.yaml` is in the V2 format and maps both.

**Updating the miner** (`updateMiner` ends the current registration and
creates a new id; a new registration spends its first 7 days in the grace
period):
1. Deploy the miner code first - the YAML's `intent_mapping` reads fields
   (`tx_hash`, `block_number`, `gas_price_gwei`, ...) the old build does not emit.
   Check: `curl -s 'https://miner.truvian.xyz/gas?chain=ethereum' | jq .gas_price_gwei`.
2. Host the YAML at an immutable URL (commit-pinned GitHub raw or IPFS) and
   take its SHA-256: `shasum -a 256 telegraph/truvian-miner.yaml`.
3. Mint test USDC and approve the Diamond for the bond ($1 for the first
   intent, $0.10 for each further one; read `minerBondParams()`), then dry
   run (free) and send, with `DIAMOND` and `RPC` as set above:
```bash
USDC=0xcc194e1a843B658526D0D5C431f670028582Ae17
cast send $USDC "mint(address,uint256)" $MINER_ADDRESS 5000000 --rpc-url $RPC --private-key $MINER_PRIVATE_KEY
cast send $USDC "approve(address,uint256)" $DIAMOND 5000000 --rpc-url $RPC --private-key $MINER_PRIVATE_KEY
ARGS=(6146 "$YAML_URL" "0x$YAML_SHA256" "$FEE_ADDRESS" 10000 '["ONCHAIN_TX_LOOKUP_GENERAL","GAS_PRICE_GENERAL","WALLET_BALANCE_CHECK_GENERAL","TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL"]')
cast call $DIAMOND "updateMiner(uint256,string,bytes32,address,uint256,string[])(uint256)" "${ARGS[@]}" --from $MINER_ADDRESS --rpc-url $RPC
cast send $DIAMOND "updateMiner(uint256,string,bytes32,address,uint256,string[])" "${ARGS[@]}" --rpc-url $RPC --private-key $MINER_PRIVATE_KEY
```
   Run on 2026-11-20 for 6146: the bond was 1.30 USDC for four intents, as
   `minerBondParams()` says, although the addresses page on anjoman.ai said
   no bond was set. Trust the contract read.
4. Activation follows in about 10 to 15 minutes. Read the verdict by the new
   id: `curl -s $NODE/api/miners/<newId> | jq '.miner | {activation_status, rejection_reason}'`.
   If the update is refused, the current registration keeps serving.

**Reading our standing.** `GET $NODE/leaderboard/miners/epoch/<n>` has every
intent ranked in that epoch. The `scores[]` in `/api/miners` only holds a
miner's most recent epoch, so an intent ranked in an earlier epoch looks
unscored there. Epochs are 1 hour on the testnet; not every intent is ranked
every epoch. Before the reset: epoch 2070 `ONCHAIN_TX_LOOKUP_GENERAL` rank
12 of 27 (0.282), then rank 4 of 22 (0.9182) in epoch 2091 once the pruned-RPC
fix was live; `GAS_PRICE_GENERAL` rank 2 of 28 (0.9989). Since the reset
scores are low and unsteady for every miner: in epochs 1 to 16 the leader on
transaction lookup ranged from 0.50 to 0.99 and on gas price from 0 to 0.53.
Ours: transaction lookup 0.30 (rank 5 of 13), 0 (25 of 27), 0.30 (6 of 28),
0.41 (11 of 28); gas price 0.33 or 0. The live miner answered every direct
check correctly on 2026-11-19, so the cause is not established; the requests
the node sends are in `pm2 logs truvian-miner` on the VPS.

**Evaluators.** Season I `rank_answer` WASM modules are refused. V2 takes a
comparator WASM (deterministic intents; exports `imw_score_deterministic`,
`imw_alloc`, `imw_free`) or a safetensors LoRA adapter (judgment intents),
registered on a family prefix with a $5 bond (test USDC since 17 November) and a runnable URL, plus
evaluation material uploaded to `POST $NODE/api/evalpool/submissions` signed
by the contributor wallet. Work was tracked per intent family as issues in
`telegraphprotocol/bounties` until 15 November, when those were closed and
replaced by 15 mission issues (#189 to #203). Our claims and progress
updates remain on the closed #179 and #87; to continue, claim on a mission
issue and link them. #190 (Stablecoin) lists both of our intents. As of
2026-11-19 we have not claimed there and no `/submit` has been posted for
the truth sources. See `evaluator/README.md` for the sources themselves.

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
