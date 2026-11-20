# SMART_CONTRACT_AUDIT evaluator adapter

An attempt at the evaluator seat for `SMART_CONTRACT_AUDIT`, a judgment
intent that no adapter had ever been registered for (checked 2026-11-20).
Its evaluation pool then held 378 eligible rows from 4 contributors, above
the node's minimum of 3, so with no incumbent an adapter needs to rank at
least 70% of 30 hidden pairs correctly to take the seat.

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

The kit is `telegraphprotocol/telegraph-wasm-baseline` (commit 1ed063e). Two
workarounds were needed on 2026-11-20:

- Hugging Face's current `answerdotai/ModernBERT-base` tokenizer.json no
  longer has the hash the node pins (`67bc76f8…`), so an adapter trained the
  default way is refused at export. Train against a local copy of the base
  model with Telegraph's released `tokenizer.json` in place (the kit's 88
  tokenizer vectors pass), copy that file into `<run>/adapter/`, and export
  with `--adapter <run>/adapter`.
- `train_adapter` exits 1 with `NameError: name 'pkg' is not defined` while
  printing its next steps, after the run is saved. It is harmless.

```bash
python -m float_runtime.train_adapter --intent SMART_CONTRACT_AUDIT --data pairs.jsonl \
  --out runs/v1 --base-model /opt/models/ModernBERT-base
cp foundation/tokenizer.json runs/v1/adapter/tokenizer.json
python -m float_runtime.export_adapter --adapter runs/v1/adapter --intent SMART_CONTRACT_AUDIT \
  --class judgment --foundation foundation/foundation.json --out SMART_CONTRACT_AUDIT.safetensors
go run ./cmd/adapterbuild lora --intent SMART_CONTRACT_AUDIT --package SMART_CONTRACT_AUDIT.safetensors \
  --out . --foundation foundation/foundation.json
```

On the server's 6 CPU cores a pair takes about 4.6 seconds per epoch at these
lengths, so the full run is several hours; a GPU does it in minutes.

## Limits

- The pool's hidden pairs are written by other contributors about real
  production contracts, and ours are generated. How well the adapter carries
  over is only known from the node's own check.
- Contracts with a long prompt are cut at 512 tokens by the node for every
  adapter alike; this data does not train on that case.
