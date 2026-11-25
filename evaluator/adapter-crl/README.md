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

**Status, 2026-11-24 06:45 UTC: v1 registered as id 227** (tx
`0xbc9ca0592f72fb292ebf2883f53aff21d4592f48793a53513024cc0687c5bf21`,
package URL pinned to commit `0e4dc56`, runnable URL
`https://scorer.truvian.xyz/crl/runnable`). Progress:
`GET https://devnode.telegraphprotocol.com/api/wasm/227`.

**v1 rejected at the public check, 2026-11-24 07:21 UTC:** it ordered 10 of
the 15 public pairs and needed 11. The public batch (decoded from the
executor's request log; it is the open check, not the hidden benchmark)
showed why: the node's pairs are not company-registry extracts but lookups
against the GLEIF LEI register. A name, usually an LEI, a short question
about status, jurisdiction, city, address, registration number or legal
form, and a one-sentence or JSON answer. The faults are mostly visible in the
answer itself: a city with another country's code (`MUMBAI (GB)`), a
jurisdiction that does not fit the legal form (`CEBA S.R.L.` under `GB`), an
address in another country, ACTIVE flipped to INACTIVE, a requested field
left out, or the LEI of a similarly named entity from the search results.
Version 1 had seen none of that shape.

**Version 2 (training since 2026-11-24 08:00 UTC):** a new generator,
[`generate_pairs_v2.py`](generate_pairs_v2.py), builds that shape from its
own synthetic records (16 jurisdictions, made-up names and addresses, LEIs
with valid ISO 17442 check digits). None of the node's pairs are in the
training data; the 15 public pairs are kept as a replay check only.

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

## Version 2 training data

```
python3 generate_pairs_v2.py --n 1800 --seed 7 --out v2raw.jsonl
python3 ../adapter-coa/fit512.py tokenizer.json v2raw.jsonl pairs.jsonl 1500
python3 generate_pairs_v2.py --n 360 --seed 97 --out v2rawtest.jsonl
python3 ../adapter-coa/fit512.py tokenizer.json v2rawtest.jsonl test0.jsonl 360
python3 ../adapter-llm-eval/dedupe_test.py pairs.jsonl test0.jsonl test.jsonl 240
```

Faults in the 1,800 raw pairs: flip_status 403, dropped_field 340, city 275,
jurisdiction 191, other_entity 147, country_code 127, bad_lei 123,
impossible_date 80, address 64, contradiction 50. With no evidence in the
question, 86% of records are ACTIVE, so a flipped status is judged by the
prior that a looked-up entity is usually live.

Kit dataset gate on the 1,500 training pairs: PASS (surface probe 63.3%,
limit 65%; length shortcut 51.7%; unique rejected answers 100%; held-out
leak 0%).

## Version 2 result: not registered

Trained 2026-11-24 08:00-11:01 UTC (early stopping; 1,275 training pairs):
**79.17% on 240 held-out pairs** (length baseline 51.25%), verdict PASS.
Package sha256 `0232f0ece1be80ac6975fe178f5213ff7dd826732363866707391e5413f36af5`
(kept on the scorer VPS, not committed). Replayed through the executor on
the node's 15 public pairs it ordered **8**, below v1's 10, so it was not
registered.

Held-out accuracy by fault kind shows why: it learned the faults the node
rarely uses (dropped_field 38/39, contradiction 5/5, flip_status 45/52) and
not the geography faults it uses most: city 16/31 (52%), country_code
11/15, jurisdiction 21/27, other_entity 11/20. Six cities per country let
it memorise a list instead of learning which city belongs where.

## Version 3 (queued after COA v2)

[`generate_pairs_v3.py`](generate_pairs_v3.py): version 2 with about 25
real cities per country and the geography faults weighted to about 60% of
pairs (2,000 raw: city 504, jurisdiction 388, flip_status 374, country_code
249, dropped_field 132, other_entity 127, address 91, bad_lei 63,
impossible_date 43, contradiction 29). 1,700 training pairs after the
512-token fit, 240 held-out. Kit dataset gate: PASS (surface probe 57.5%,
length shortcut 53.6%).

```
python3 generate_pairs_v3.py --n 2000 --seed 11 --out v3raw.jsonl
python3 generate_pairs_v3.py --n 360 --seed 97 --out v3rawtest.jsonl
```

## Version 3 result: registered

Trained 2026-11-24 16:40-20:13 UTC (3 epochs, 1,445 training pairs;
validation accuracy 79.6% at the last epoch): **70.83% on 240 held-out
pairs** (length baseline 55.83%), verdict PASS; record in
[`package-v3/train-result.json`](package-v3/train-result.json). Lower than
v2 on our own pairs, since the held-out set is now mostly the harder
geography faults, but replayed through the executor on the node's 15 public
pairs it ordered **12** (v1 10, v2 8), the first version over the 11-pair
floor. Several margins are thin.

Package: [`package-v3/CORPORATE_REGISTRY_LOOKUP.safetensors`](package-v3/),
6,776,916 bytes, keccak256
`0x42998a9d609b9ce06449089db8643e9b6dfdc70d9870e0819a26332af0c0b73e`, sha256
`6f2933a7235c14a836fd7b8373dfd7b785d3b17a9e4adf1591d76ade10f6a2f5`, class
`judgment`; `adapterbuild lora` Stage 1 passed (kit scratch copy with the
catalog patch). The executor at `https://scorer.truvian.xyz/crl/runnable`
serves it (v1 and v2 kept on the scorer VPS). With no champion, it needs at
least 70% on the hidden sample.
