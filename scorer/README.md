# Truvian Scorer — ONCHAIN_TX_LOOKUP WASM Scoring Module

Telegraph Protocol Season I, Track 2 (Script Author). A domain-aware scoring
module for the `ONCHAIN_TX_LOOKUP` intent: instead of generic semantic
similarity, it extracts typed on-chain facts (tx hashes, addresses, wei values,
block numbers, tx status) from the ground truth and scores miner answers by
weighted factual recall, with anti-gaming penalties.

## Contract

- Target: `wasm32-unknown-unknown`, single self-contained `.wasm`, **zero
  imports** (no WASI), ≤ 32 MB.
- Exports (C ABI):
  - `alloc(size: i32) -> i32`
  - `dealloc(ptr: i32, size: i32)`
  - `rank_answer(q_ptr, q_len, gt_ptr, gt_len, ma_ptr, ma_len) -> f32` in
    `[0,1]`; the (ptr,len) pairs are UTF-8 strings: question, ground_truth,
    miner_answer.
- Guarantees: empty/whitespace answer → exactly `0.0`; trimmed verbatim match
  (and therefore Stage-2 self-match) → exactly `1.0`; deterministic (Vec-based
  sorted structures only, no hash maps / randomness / time); never traps on
  large (tens of KB) or non-English/emoji input.

## Scoring model

1. Lex both ground truth and answer into typed facts:
   - `0x`-hex strings, compared case-insensitively — 66 chars = tx hash
     (weight 6), 42 chars = address (weight 4), other hex (weight 2);
   - integers, normalized (commas stripped, leading zeros stripped; exact
     string comparison so full-precision uint256 wei values work) — ≥10 digits
     weight 3, else weight 1.5;
   - decimal-point numbers, compared with 1e-6 relative tolerance (weight 1.5);
   - tx-status keywords normalized into synonym groups
     (success/succeeded/successful vs failed/reverted/unsuccessful), weight 2.
2. Score = `0.78 × weighted-recall(gt facts found in answer)` +
   `0.22 × Dice word-overlap similarity`, minus:
   - a precision penalty for answers stuffed with contradicting hex values /
     big integers absent from the ground truth (smooth, capped at 0.5, with a
     small free allowance so normal supporting detail is not penalized);
   - a status-contradiction penalty (0.15 if the answer asserts the opposite
     status, 0.05 if it hedges by asserting both).
3. If the ground truth has no extractable typed facts, fall back to pure text
   similarity. Non-verbatim scores are capped at 0.995 so only the exact
   answer reaches 1.0.

## Build

```bash
rustup target add wasm32-unknown-unknown   # once
cargo build --release --target wasm32-unknown-unknown
```

Artifact: `target/wasm32-unknown-unknown/release/truvian_scorer.wasm`
(~110 KB, zero imports).

## Test

Reference materials live in `vendor/` (gitignored):

```bash
git clone https://github.com/telegraphprotocol/telegraph-examples vendor/telegraph-examples
git clone https://github.com/telegraphprotocol/telegraph-wasm-baseline vendor/telegraph-wasm-baseline   # optional, champion
```

Then run the acceptance suite (drives the **official go-tester** — the same
wazero harness validators use; needs Go):

```bash
./test.sh
```

It asserts: self-match 1.0, empty/whitespace → exactly 0, unrelated near 0,
reworded-correct ≥ 0.6, wrong status/number strictly lower, value-dump gaming
below clean answers, and no traps on 50KB / emoji / Chinese input.

Single ad-hoc run:

```bash
cd vendor/telegraph-examples/wasm-scoring-module/go-tester
go run . ../../../../target/wasm32-unknown-unknown/release/truvian_scorer.wasm \
  "<question>" "<ground truth>" "<miner answer>"
```

## Submission (register on-chain)

1. Host the **exact built bytes** of `truvian_scorer.wasm` at a stable public
   URL (any host; bytes must never change after registration).
2. Compute the keccak256 of those exact hosted bytes (from the repo root,
   using viem):

   ```bash
   node -e "import('viem').then(async v=>console.log(v.keccak256(require('fs').readFileSync(process.argv[1]))))" \
     scorer/target/wasm32-unknown-unknown/release/truvian_scorer.wasm
   ```

   Current build: `0x3b581da2712e2ad7f01b08919e646a44afebea944bdc7d13f65b58645dd22c16`
   (112,236 bytes).
3. Call `registerWasm(bytes32 wasmHash, string wasmUrl, string intent)` on the
   Telegraph Diamond at `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8`
   (**Base Sepolia**), with:
   - `wasmHash` — the keccak256 from step 2 (of the exact hosted bytes);
   - `wasmUrl` — the URL from step 1;
   - `intent` — `"ONCHAIN_TX_LOOKUP"`.

   The node downloads the bytes from `wasmUrl` and verifies
   `keccak256(bytes) == wasmHash` before accepting the module — if you
   rebuild, re-hash and re-register.
