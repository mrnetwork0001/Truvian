# CORPORATE_REGISTRY_LOOKUP evaluator adapter

Our fifth evaluator adapter. The intent takes a company name (or registry
identifier) and a jurisdiction and answers the registered legal name, the
registry identifier, whether the company is active, the jurisdiction, the
registered address and the incorporation date; the node scores `active`
(`GET /engine/v1/intents/CORPORATE_REGISTRY_LOOKUP`, class `judgment`). It is
one of the families Mission 13 (Asset Management, route 2) builds on. Our
miner does not serve this intent, so the adapter scores other teams' miners,
never ours.

**Where the intent stood (checked 2026-11-24 06:00 UTC):** no champion and no
seed. Two adapters were registered on 17 Nov and both were rejected before
any pair was scored: their executors refused the node's batch request
(`expected integer ground_truth_value…`, `not an integer`). The evaluation
pool holds 41 eligible rows from one submitter. With no incumbent, an
adapter needs 11 of 15 public pairs and at least 70% on the hidden sample.

## Training data: `generate_pairs.py`

A pair is (question, better answer, worse answer). Each case is built from a
synthetic registry record the script holds, with the identifier format each
registry really uses: Companies House numbers, HRB entries at a German local
court, Brønnøysund organisation numbers, Delaware file numbers, ACRA UENs,
ASIC ACNs, KvK numbers and CRO numbers. The question gives a registry
extract (55%), search results with a similarly named company (20%), or only
the company and jurisdiction (25%).

The worse answer is a copy of the better one with one fault:

| Needs the evidence in the question | Can be judged from the answer alone |
|---|---|
| flip_status: active and status reversed against the extract | contradiction: `active` says one thing, the status wording the other |
| wrong_number: identifier digits changed, same format | bad_format: an identifier in another registry's format |
| wrong_entity: the similarly named company, or a changed name | wrong_jurisdiction: another jurisdiction's record |
| wrong_date: incorporation date changed | impossible_date: incorporated after the lookup, or dissolved before incorporation |
| wrong_address: registered address changed | |

Both answers are rendered with the same random choices (JSON, labelled
lines or prose, field order, wording), so they differ only in the fault.

```
python3 generate_pairs.py --n 1400 --seed 7 --out raw.jsonl
python3 ../adapter-coa/fit512.py tokenizer.json raw.jsonl pairs.jsonl 1200
python3 generate_pairs.py --n 300 --seed 97 --out rawtest.jsonl
python3 ../adapter-coa/fit512.py tokenizer.json rawtest.jsonl test0.jsonl 300
python3 ../adapter-llm-eval/dedupe_test.py pairs.jsonl test0.jsonl test.jsonl 240
```

Kit dataset gate on the 1,200 training pairs: PASS.

| Check | Value | Limit |
|---|---|---|
| surface probe | 54.6% | at most 65% |
| length shortcut | 55.5% | at most 65% |
| unique rejected answers | 100% | at least 80% |
| held-out leak | 0% | at most 10% |

## Training and package (version 1)

Kit `train_adapter.py`, ModernBERT-base, LoRA rank 8, alpha 32, 3 epochs, max
length 512, on 1,020 pairs (2 h 33 min on the scorer VPS's CPU; validation
accuracy by epoch 76.7%, 80.6%, 81.7%); full record in
[`package-v1/train-result.json`](package-v1/train-result.json).
**Pairwise accuracy on 240 held-out pairs from another seed: 80.83%** (length
baseline 57.29%), verdict PASS. This is on our own generated pairs; the
node's public and hidden pairs are written by others.

Package: [`package-v1/CORPORATE_REGISTRY_LOOKUP.safetensors`](package-v1/),
6,776,916 bytes, keccak256
`0x5930229fe10d949c6dfc67df3a4c65a33d2b9c353247f72f538887e562ac957e`, sha256
`49b417e1bf57e01a5b96fc5c91f705d6a43e26f53ca2a17884168c97538fab1c`, class
`judgment`. `adapterbuild lora` passed Stage 1, loaded it on the foundation
and scored its input twice with identical bits (`0x401e7eda`). The kit's
compiled catalog does not list this intent, so the scratch copy used for the
build carries a one-line local patch adding it as judgment, the class the
node gives it.

## The executor

`https://scorer.truvian.xyz/crl/runnable`: the kit's `adapterexec` serving
this package as `truvian-scorer-crl` (127.0.0.1:8085), started on demand by
the adapter gate ([`../../deploy/scorer/adapter-gate.py`](../../deploy/scorer/adapter-gate.py))
and stopped after 15 idle minutes. Requests are logged to
`/var/log/nginx/scorer-crl-body.log`. Checked through the public URL with the
last 60 held-out pairs, tokenised as the node does: 48 of 60 ordered (80%),
751 s; an earlier run on the last 10 alone ordered 6.
