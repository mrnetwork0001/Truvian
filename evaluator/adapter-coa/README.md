# CONTRACT_OBLIGATION_AUDIT evaluator adapter

Our fourth evaluator adapter. The intent takes a contract and answers a
compliance verdict (Compliant, Partially compliant, Non-compliant, Unclear),
the obligations it sets (who owes what by when), the clause wording cited and
a short summary (`GET /engine/v1/intents/CONTRACT_OBLIGATION_AUDIT`, class
`judgment`). Our miner does not serve this intent, so the adapter scores other
teams' miners, never ours.

**Where the intent stood (checked 2026-11-23 22:05 UTC):** the seed package
(900110) is superseded, an earlier adapter (92) lost at 65.52%, and another
team's adapter, registration 210, became the first canonical champion at
18:17 UTC with 82.76% on 29 hidden pairs. A new adapter has to beat it by 2
points.

**Status, 2026-11-23 22:10 UTC: v1 registered as id 219** (tx
`0xf6ad7d312e910f92134f0fa40173e47c0833c478f94978409580ec787c1e088b`,
package URL pinned to commit `4f8674f`, runnable URL
`https://scorer.truvian.xyz/coa/runnable`). Next: the node's public-pair
check (11 of 15) and the hidden round against 210. Progress:
`GET https://devnode.telegraphprotocol.com/api/wasm/219`.

**v1 lost on the margin, 2026-11-24 02:14 UTC.** It passed the public-pair
check, then ordered **86.21%** of the node's 29-pair hidden sample, the same
win rate as the champion (210) on the same sample. A challenger has to beat
the incumbent by 2 points, so a tie is a loss (node:
`lost the competition … did not beat the incumbent (registration 210) at
86.21% by the replacement margin 2.00 points`). The node scores the hidden
sample inside its own runtime on the downloaded package, so it never passes
through our executor; the only node request in our log is the 15-pair public
check. We do not train or tune on node pairs either way. A v2 has to gain on
our own held-out pairs (v1: 77.08%) and then on a fresh hidden sample.

**What the public check showed (decoded from the executor log):** 13 of the
15 public pairs are clause extraction, not full audits. The prompt quotes a
contract excerpt and asks for one provision (Document Name, Parties,
Agreement Date, Governing Law, Exclusivity, Cap On Liability…); the answer
is `{"clause": …, "value": …, "found": true}`. The worse answer carries a
value from another contract, the wrong clause label, or a sentence from
another provision. Version 2 trains on that shape.

## Training data: `generate_pairs.py`

A pair is (contract, better audit, worse audit). The better audit is right by
construction: each contract is assembled from clauses whose obligor, action,
deadline and amount the script holds (services, supply, lease and loan
contracts), and most prompts add a performance record (invoices, payments,
deliveries, notices) on one timeline per case, so each obligation is met or
breached by date arithmetic.

| Verdict | When |
|---|---|
| Compliant | every obligation the record covers was met |
| Partially compliant | some met, some breached |
| Non-compliant | every covered obligation breached |
| Unclear | no performance record |

The worse audit is a copy of the better one with one fault: wrong_verdict,
misread_record, wrong_obligor, wrong_deadline, wrong_amount, misquote,
missed_obligation or invented_obligation. Both are rendered with the same
random choices (JSON, labelled lines or prose), so they differ only in the
fault. `fit512.py` keeps the pairs whose both texts fit the 512-token limit.

```
python3 generate_pairs.py --n 1400 --seed 7 --out raw.jsonl
python3 fit512.py tokenizer.json raw.jsonl pairs.jsonl 1200
python3 generate_pairs.py --n 300 --seed 97 --out rawtest.jsonl
python3 fit512.py tokenizer.json rawtest.jsonl test.jsonl 240
```

Kit dataset gate on the 1,200 training pairs: PASS.

| Check | Value | Limit |
|---|---|---|
| surface probe | 52.2% | at most 65% |
| length shortcut | 54.2% | at most 65% |
| unique rejected answers | 100% | at least 80% |
| eval negatives leaked into training | 0 | 0 |

## Training and package (version 1)

Kit `train_adapter.py`, ModernBERT-base, LoRA rank 8, alpha 32, 3 epochs, max
length 512, on 1,020 pairs (5 h 35 min on the scorer VPS's CPU; validation
accuracy by epoch 73.9%, 79.4%, 78.3%); full record in
[`package-v1/train-result.json`](package-v1/train-result.json).
**Pairwise accuracy on 240 held-out pairs from another seed: 77.08%** (length
baseline 56.25%), verdict PASS. This is on our own generated pairs; the
node's public and hidden pairs are written by others.

Package: [`package-v1/CONTRACT_OBLIGATION_AUDIT.safetensors`](package-v1/),
6,776,916 bytes, keccak256
`0x350d09578ab3757ddfed360bc9e375be2c9b360af5a84aa67a8738b8829542a7`, sha256
`8c4299787c6cb420e70a516ddc4cfe4c1430d974bdf8bb20eb0ec76aa599afaf`, class
`judgment`. `adapterbuild lora` passed Stage 1, loaded it on the foundation
and scored its input twice with identical bits (`0x3df833a2`). The kit's
catalog lists this intent as judgment, so no catalog patch was needed.

## The executor

`https://scorer.truvian.xyz/coa/runnable`: the kit's `adapterexec` serving
this package as `truvian-scorer-coa` (127.0.0.1:8084), started on demand by
the adapter gate ([`../../deploy/scorer/adapter-gate.py`](../../deploy/scorer/adapter-gate.py))
and stopped after 15 idle minutes. Requests are logged to
`/var/log/nginx/scorer-coa-body.log`, so the node's public batch can be
replayed against a later version. Checked through the public URL with 10
held-out pairs, tokenised as the node does: 8 of 10 ordered, 287 s (cold
start, with a training run on the same CPU).

## Version 2 training data (queued 2026-11-24)

[`generate_pairs_v2.py`](generate_pairs_v2.py) writes synthetic contracts
(made-up parties, titles, laws, products and amounts; 24 provision types
plus the header fields) and cuts an excerpt around the provision asked for.
The better answer quotes what the excerpt shows; the worse one has one
fault: foreign_value (a value from another contract), wrong_label,
other_span (a sentence of another provision in the same excerpt) or
found_flip. 12% of questions ask for a provision the contract lacks, where
`"found": false` is right.

v1's own held-out pairs, scored by fault kind through the public URL
(185 of 240): misread_record 37.5%, wrong_obligor 60.6%, wrong_verdict
63.4%, misquote 88%, missed_obligation 93.1%, wrong_deadline 94.4%,
invented_obligation and wrong_amount 100%.

Training set: 1,400 extraction pairs plus 450 of v1's audit pairs, so the
audit shape stays covered; held-out: 220 pairs (extraction and v1 audit,
deduplicated against training). Kit dataset gate: PASS (surface probe
57.5%, length shortcut 53.6%, unique rejected answers 100%, held-out leak
0%).
