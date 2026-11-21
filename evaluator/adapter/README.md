# SMART_CONTRACT_AUDIT evaluator adapter

An attempt at the evaluator seat for `SMART_CONTRACT_AUDIT`, a judgment
intent that no adapter had ever been registered for (checked 2026-11-20).
Its evaluation pool then held 378 eligible rows from 4 contributors, above
the node's minimum of 3, so with no incumbent an adapter needs to rank at
least 70% of 30 hidden pairs correctly to take the seat.

**Status, 2026-11-21: trained, packaged and checked on the node's engine; not
registered.** The package is [`package/SMART_CONTRACT_AUDIT.safetensors`](package/)
(keccak256 `0xca1e61ec…afdf7`), its executor answers at
`https://scorer.truvian.xyz/runnable`, and [Registering](#registering) has the
exact transactions to send.

An adapter is a small LoRA delta and reward head on Telegraph's shared
Foundation Model (ModernBERT-base). The node renders each pair as
`### Task:\n{question}\n\n### Answer:\n{answer}` and the adapter must score the
better answer higher.

## Training data: `generate_pairs.py`

Preference pairs (prompt, chosen, rejected) about Solidity, in the styles the
public descriptions of the pool's material give:

| Task | The better answer | The worse answer |
|---|---|---|
| access_quote | the exact statement that restricts a function's caller (its own require or revert, or its modifier's) | another function's guard, a check that is not about the caller, or "unprotected" for a guarded function |
| swc_identify | the SWC entry the contract contains, with the function and cause | a wrong entry, the wrong function, or both |
| dasp | the DASP Top 10 category with the SWC entry | a different category |
| scoped_count | findings of one SWC class: 1 with the function, or 0 | the wrong count or the wrong function |
| fix | the change that removes the weakness | the fix for a different weakness |

Correct by construction: each contract is assembled from parts whose
security properties are known (11 SWC entries: 101, 104, 105, 106, 107, 112,
113, 115, 116, 120, 128), so the better answer is derived from the code.

No give-aways: each SWC entry has one explanation and one fix sentence, used
for the true answer and as a decoy alike, so the worse answer differs only in
being wrong about this code. The kit's dataset gate on 2,400 pairs (seed 7):

| Check | Value | Limit |
|---|---|---|
| unique worse answers | 96.5% | at least 80% |
| largest single worse answer | 0.2% | at most 2% |
| "pick the longer answer" | 51.6% | at most 65% |
| bag-of-words probe without the prompt | 58.5% | at most 65% |
| held-out leak | 5.0% | at most 10% |

Every text fits the node's 512 tokens (median 338, max 460 with the pinned
tokenizer), so no answer is cut off.

```bash
python3 generate_pairs.py --out pairs.jsonl --n 2400 --seed 7
```

## Training and packaging (on the scorer server)

The kit is `telegraphprotocol/telegraph-wasm-baseline` (commit 1ed063e). Three
workarounds were needed on 2026-11-20 and 21:

- Hugging Face's `answerdotai/ModernBERT-base` tokenizer.json (revision
  `8949b909…`, unchanged since January 2025) is not byte-identical to the one
  the node pins (`67bc76f8…`), so an adapter trained the default way is
  refused at export. The two give identical token ids on all 88 of the kit's
  vectors; only the bytes differ. Train against a local copy of the base model
  with Telegraph's released `tokenizer.json` in place, copy that file into
  `<run>/adapter/`, and export with `--adapter <run>/adapter`. Reported as
  telegraphprotocol/bounties#223.
- `train_adapter` exits 1 with `NameError: name 'pkg' is not defined` while
  printing its next steps, after the run is saved. It is harmless (also in
  bounties#223).
- `adapterbuild lora` takes the intent's class from a catalog compiled into
  the kit, which predates `SMART_CONTRACT_AUDIT`, so the unmodified kit
  refuses the package: `SMART_CONTRACT_AUDIT is not a judgment or hybrid
  intent in the compiled-in catalog — refusing to guess a class`. The node
  itself classes the family as judgment (`GET /engine/v1/intents/SMART_CONTRACT_AUDIT`).
  `adapterbuild` was run from a scratch copy of the kit with the entry in
  [`kit-catalog.patch`](kit-catalog.patch) added. The executor does not read
  that catalog, so the executor that serves the adapter is the unmodified kit
  build.

```bash
python -m float_runtime.train_adapter --intent SMART_CONTRACT_AUDIT --data pairs.jsonl \
  --out runs/v1 --base-model /opt/models/ModernBERT-base
cp foundation/tokenizer.json runs/v1/adapter/tokenizer.json
python -m float_runtime.export_adapter --adapter runs/v1/adapter --intent SMART_CONTRACT_AUDIT \
  --class judgment --foundation foundation/foundation.json --out SMART_CONTRACT_AUDIT.safetensors
# in a copy of the kit with kit-catalog.patch applied (git apply kit-catalog.patch)
go run ./cmd/adapterbuild lora --intent SMART_CONTRACT_AUDIT --package SMART_CONTRACT_AUDIT.safetensors \
  --out . --foundation foundation/foundation.json \
  --foundation-onnx foundation/foundation_lora_fp32.onnx --engine float_runtime/engine/foundation_engine.wasm \
  --engine-hash 77643d6e1176ab8744801cef93ccb844d0136ed32b8daa865d541f37d13292de
```

Exporting again does not give these bytes back; see [Never re-export](#never-re-export).

## Results

### Training (run v1)

2,400 pairs (seed 7): the kit held out 360 for validation and trained on
2,040, at rank 8, alpha 32, 512 tokens, learning rate 1e-4, batch 1 with 16
steps of gradient accumulation. 3 epochs, 381 optimizer steps, 9 h 09 min on
the server's 6 CPU cores in fp32 (no GPU), 2026-11-20 18:51 to 2026-11-21
04:00 UTC.

| Epoch | Held-out accuracy (360 pairs) | Held-out loss |
|---|---|---|
| 1 | 0.7778 | 0.5678 |
| 2 | 0.8806 | 0.2563 |
| 3 | 0.9111 | 0.2260 |

The kit's evaluation gate passed: 0.9111 against a "pick the longer answer"
baseline of 0.5194 on the same pairs (it needs at least 0.65 and 10 points
over the baseline). Verdict `PASS`.

### A fresh sample (seed 11)

200 new pairs from the same generator with seed 11, none of whose prompts is
in the training file, scored in PyTorch with the trained adapter:
**183 of 200 (91.5%)**, against 52.75% for "pick the longer answer".

| Task | Ordered correctly |
|---|---|
| access_quote | 40 / 50 (80%) |
| swc_identify | 59 / 63 |
| scoped_count | 38 / 40 |
| fix | 30 / 31 |
| dasp | 16 / 16 |

`access_quote` is the weakest: 10 of the 17 misses. This sample measures the
adapter on our own generator's kind of question, not on the pool's.

### On the node's engine

A batch shaped like a validator's remote check (15 pairs, 30 texts: the
first three pairs of each task in the seed-11 sample, rendered and tokenised
the way the node does) was sent in one request, with the score identity, to
the kit's reference executor (`adapterexec`) running the released foundation
and engine on 127.0.0.1:

| | |
|---|---|
| Pairs in the right order | 14 of 15 (the node needs 70%); the miss is an `access_quote` pair PyTorch also gets wrong |
| Same order as PyTorch | 15 of 15; largest difference in a score 0.000055 |
| Identity echo | foundation, adapter and tokenizer hashes as sent |
| Time | about 6 minutes for 30 texts (12 s a text; the node allows 30 minutes) |
| Memory | about 2.5 GB resident at peak |

The first run used an executor built from the patched scratch copy. The
same batch through the unmodified build the server's `truvian-scorer` unit
runs, with the unit's own foundation files and package path, returned the
same bits for all 30 texts.

## The package

| | |
|---|---|
| File | `package/SMART_CONTRACT_AUDIT.safetensors` |
| Size | 6,776,916 bytes |
| sha256 | `52830f37c0d8150e22654fc941c3033cc42864e7ec71201c144c6a357bb8e0f5` |
| keccak256 (the hash to register) | `0xca1e61ec8376def41ac1208e8dc941b34b03d3e50338ed3650d6d1787b6afdf7` |
| Metadata | intent `SMART_CONTRACT_AUDIT`, class `judgment`, abi `lora-v1`, rank 8, alpha 32, targets `Wi`, `Wo`, `Wqkv`, `max_tokens` 512, 178 tensors |
| Foundation | `modernbert-base-lora16-v1`, sha256 `0a49b325…f8e6` |
| Tokenizer | `67bc76f8…c456` |

`package/SMART_CONTRACT_AUDIT.safetensors.manifest.json` is what
`adapterbuild lora` wrote, run locally from a copy of the kit patched to list
SMART_CONTRACT_AUDIT (the node itself has not yet seen the package): the
kit's Stage 1 parser accepted the package,
and it loaded on the foundation and scored the same input twice with
identical bits (`0xbf909d3f`). The examples repository's
`evaluator-adapter/inspect-package.ts` also passes it.

Check a copy before relying on it:

```bash
shasum -a 256 package/SMART_CONTRACT_AUDIT.safetensors   # 52830f37…
cast keccak < package/SMART_CONTRACT_AUDIT.safetensors   # 0xca1e61ec…
```

### Never re-export

The hash that `export_adapter` prints is not the hash of the file it
writes, and exporting the same adapter again gives a file with yet another
hash. safetensors (0.8.0 here) writes the `__metadata__` keys in a different
order on every write, so each serialisation has a different header and
hash while the tensor bytes stay the same. `export_adapter` serialises the
package twice: once in memory, whose sha256 it logs, and once to disk. On
2026-11-21 this package was re-serialised twelve times, both ways, in two
processes: twelve different sha256s, none equal to the file's, every one
with the file's tensor bytes.

So the hash to register is taken from the file (`adapterbuild lora` prints
it, or `cast keccak < file`), and the registered hash, the hosted file and
the executor's package must all be these exact bytes. On the scorer server
they are `/opt/truvian-scorer/SMART_CONTRACT_AUDIT.safetensors` and its copy
`/opt/truvian-scorer/current.safetensors`, and a backup with SHA256SUMS is
kept off the server.

## The executor

A registration names a runnable URL. A validator scores 15 public pairs
there before downloading anything, then scores the same texts itself and
rejects the registration unless every score matches bit for bit.

- URL to register: `https://scorer.truvian.xyz/runnable`. The executor
  answers a POST at any path; nginx answers `/health` itself.
- Runs on the scorer server as the systemd unit `truvian-scorer`, enabled and
  started on 2026-11-21: the kit's reference executor (`cmd/adapterexec`, the
  unmodified build of kit commit 1ed063e), the released foundation
  (`foundation_lora_fp32.onnx`, sha256 `0a49b325…`) and engine
  (`foundation_engine.wasm`, `77643d6e…`), and
  `/opt/truvian-scorer/current.safetensors`. It listens on 127.0.0.1:8080
  only, behind nginx with TLS and 1,900-second proxy timeouts. The unit
  limits it to 5 GB of memory (it uses about 2.8 GB) and restarts it if it
  stops.
- It needs no tokenizer and keeps no state: the node sends token ids, and the
  reply carries one score (f32 bits) per text and the identity it scored with.

Checked from outside the server on 2026-11-21, after the unit started:

| Check | Result |
|---|---|
| DNS and TLS | one A record, 38.9.97.25; Let's Encrypt certificate valid to 2027-02-18; no redirect |
| `GET` | 405 `POST a batch request`, from the executor |
| Empty batch with the identity | 200, the three hashes echoed |
| Pair 0 of the seed-11 sample (2 texts) | bits 1091328269 and 1083301922, the same as both local runs, in 30 s |
| The examples repository's `evaluator-adapter/check-executor.ts` (telegraph-examples ee9b96e) | passed: 3 short texts in 2.4 s, identity and `input_root` echoed, the same bits for the same text |

The checker's first text is the kit's default verification input, and the
executor gave it `0xbf909d3f`, the bits `adapterbuild` recorded in the
manifest.

See it answer (an empty batch scores nothing and returns the identity):

```bash
curl -s https://scorer.truvian.xyz/runnable -H 'Content-Type: application/json' -d '{"batch": [],
  "foundation_hash": "0a49b325304bb4cf292e683929689d0457966be264f60bfc94d0072b614bf8e6",
  "adapter_hash": "ca1e61ec8376def41ac1208e8dc941b34b03d3e50338ed3650d6d1787b6afdf7",
  "tokenizer_hash": "67bc76f8b9386efba1a761c1c8e5ad439fd0eaf1c2826e9dd1a205c7af4dc456"}'
```

`/health` returning `ok` only shows that nginx is up.

On the server: `journalctl -u truvian-scorer -f` shows each scored text with
its bits; `systemctl stop truvian-scorer` stops it (it is enabled, so it
starts again at boot); `systemctl disable --now truvian-scorer` stops it for
good. Keep it running until the registration leaves `pending`. Serving a
different package means a new registration with that package's hash.

## Registering

Not done yet. It is one transaction from the wallet that will own the
registration, after minting and approving the $5 bond in test USDC (the
Diamond's `entityBonds()`: 5,000,000 base units; returned in full on
deregistration). The Diamond address changes without notice: confirm it on
<https://anjoman.ai/docs/protocol/addresses-and-params> first.

`<COMMIT>` is the full hash of a commit on GitHub that contains the
package: the commit that adds it, if the branch is merged with a merge
commit (a squash or rebase gives it a new hash), or any later commit of
`main`. A commit-pinned raw URL cannot change after registration.

```bash
export DIAMOND=0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b   # since 2026-11-17
export RPC=https://ethereum-sepolia-rpc.publicnode.com
export USDC=0xcc194e1a843B658526D0D5C431f670028582Ae17      # test USDC, the Diamond's usdcToken()
export AUTHOR=0xcd0a2370f2dc12c1802707b7d9ab3fec891e3c02    # owns the registration (the miner wallet)
export FEE_ADDRESS=$AUTHOR                                 # where the adapter's rewards go; can be a cold wallet
export WASM_HASH=0xca1e61ec8376def41ac1208e8dc941b34b03d3e50338ed3650d6d1787b6afdf7
export WASM_URL=https://raw.githubusercontent.com/mrnetwork0001/Truvian/<COMMIT>/evaluator/adapter/package/SMART_CONTRACT_AUDIT.safetensors
export WASM_RUNNABLE_URL=https://scorer.truvian.xyz/runnable

# 1. The URL serves the registered bytes, without a redirect (the node re-hashes what it downloads).
curl -fsS "$WASM_URL" | cast keccak           # must print $WASM_HASH
# 2. The executor is up and runs this package: the empty-batch request above
#    must echo adapter_hash ca1e61ec…

# 3. The bond: third value of entityBonds() is the adapter bond in test USDC base units.
cast call $DIAMOND "entityBonds()(uint64,uint64,uint256,uint256)" --rpc-url $RPC
cast send $USDC "mint(address,uint256)" $AUTHOR 5000000 --rpc-url $RPC --private-key $AUTHOR_PRIVATE_KEY
cast send $USDC "approve(address,uint256)" $DIAMOND 5000000 --rpc-url $RPC --private-key $AUTHOR_PRIVATE_KEY

# 4. Dry run (free): prints the registration id you would get, or the revert reason.
cast call $DIAMOND "registerWasm(bytes32,string,string,address,string)(uint256)" \
  $WASM_HASH "$WASM_URL" SMART_CONTRACT_AUDIT $FEE_ADDRESS "$WASM_RUNNABLE_URL" \
  --from $AUTHOR --rpc-url $RPC

# 5. Register.
cast send $DIAMOND "registerWasm(bytes32,string,string,address,string)" \
  $WASM_HASH "$WASM_URL" SMART_CONTRACT_AUDIT $FEE_ADDRESS "$WASM_RUNNABLE_URL" \
  --rpc-url $RPC --private-key $AUTHOR_PRIVATE_KEY
```

What was checked on 2026-11-21 (block 12180874), without sending anything:

- The intent argument is the family prefix `SMART_CONTRACT_AUDIT`, which is
  in the Diamond's `getPrefixes()`. `SMART_CONTRACT_AUDIT_GENERAL` reverts
  with `IntentRegistryFacet: not a registered prefix`.
- Step 4 as the wallet stood (0.70 test USDC, no allowance) reverts with
  `ERC20: insufficient allowance`. With the token's balance and allowance
  overridden in the call to what step 3 leaves (5.70 USDC, 5.00 approved),
  it returned registration id 175 and was estimated at about 2.4 million
  gas. The id you get will be whatever is next when you send.
- The wallet held 0.0102 Sepolia ETH, and the base fee was a few wei, so
  gas is not a constraint unless fees rise sharply.

Send the three transactions one at a time (`cast send` waits for each
receipt). If one seems to vanish, read the wallet's nonce from a second RPC
before resending.

After sending, the node sees the transaction in 10 to 15 minutes, waits for
the next confirmed epoch (1 hour on the testnet), then sends the 30-text
batch to the executor (about 6 minutes), downloads the package, scores the
same texts itself, and runs the hidden round of 30 pairs. Follow it with:

```bash
curl -s https://devnode.telegraphprotocol.com/engine/validator/v1/addresses/$AUTHOR/wasm
curl -s "https://devnode.telegraphprotocol.com/api/wasm?intent=SMART_CONTRACT_AUDIT"
```

## Limits

- Nothing asks this intent anything yet. On 2026-11-21 the node listed no
  miners for `SMART_CONTRACT_AUDIT` and said it is not callable on-chain
  ("the intent has no response format"), and its child
  `SMART_CONTRACT_AUDIT_GENERAL` is scored by the node's `GENERIC` fallback.
  A canonical adapter would score the child's miners once there are any.
- The pool's hidden pairs are written by other contributors about real
  production contracts, and ours are generated. How well the adapter carries
  over is only known from the node's own check. The public descriptions of
  that material put access-control questions first, and `access_quote` is
  the adapter's weakest task.
- Contracts with a long prompt are cut at 512 tokens by the node for every
  adapter alike; this data does not train on that case.
