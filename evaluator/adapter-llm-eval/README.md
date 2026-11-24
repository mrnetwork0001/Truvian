# LLM_OUTPUT_EVALUATION evaluator adapter

Our third evaluator adapter, after the SMART_CONTRACT_AUDIT champion
([`../adapter/`](../adapter/)) and OPTIMAL_EXECUTION_ROUTE
([`../adapter-oer/`](../adapter-oer/)). The intent gives a task and a model's
output and asks for a judgement: a rating (Excellent, Good, Acceptable, Poor,
Fails), a score out of 10, strengths and specific errors
(`GET /engine/v1/intents/LLM_OUTPUT_EVALUATION`, class `judgment`). Our miner
does not serve this intent, so the adapter scores other teams' miners, never
ours.

**Where the intent stood (checked 2026-11-23):** the champion is a seed
package the Telegraph team installed on 31 Oct (registration 900002, no
runnable URL, no published score). Two adapters had been registered and both
were rejected: one ordered 5 of the 15 public pairs (33.3%, below the 70%
floor), the other's executor was unreachable. With an incumbent, a new
adapter has to beat it by 2 points on the hidden benchmark.

**Status, 2026-11-23 16:55 UTC: v1 registered as id 211** (tx
`0x07efbc8e5e20d41f6d3b77d3b82974a34dc35bb99eff7f42465ae556a9aa9bc2`,
package URL pinned to commit `e6e17a8`, runnable URL
`https://scorer.truvian.xyz/lle/runnable`). Next: the node's public-pair
check (11 of 15) and the hidden round against the seed champion. Progress:
`GET https://devnode.telegraphprotocol.com/api/wasm/211`.

**v1 rejected, 2026-11-23 18:17 UTC:** at the runnable URL it ordered 7 of
the node's 15 public pairs (46.7%, below the 70% floor). The batch was logged
(`input_root` included) and decoded on the scorer server; it is kept there,
not here, because the pool does not publish its rows. The 15 pairs were of
four kinds, and v1 was trained on part of one:

| Kind | Pairs | What separates the answers |
|---|---|---|
| Evaluation of a model output, as "Verdict: Poor, 2 out of 10. Errors: … Strengths: …", "Rating: … Score: …/10" or JSON | 7 | the rating that matches whether the output is true (misconceptions, false premises, hallucinated details), or a rating that contradicts its own errors |
| Workflow case ("case 5 concerns …") | 4 | an answer naming the issue, its consequence and a bounded next step, against a generic one |
| Direct factual answer | 2 | the right fact against a wrong one of the same type |
| Passage extraction | 2 | the passage's sentence word for word against one with a phrase swapped |

v2 ([`generate_pairs_v2.py`](generate_pairs_v2.py)) generates all four kinds
from our own facts and wording. Kit dataset gate PASS on 1,400 pairs: surface
probe 59.2%, length shortcut 56.5%, unique negatives 100%, held-out leak 0%
(`dedupe_test.py` drops held-out pairs whose negative is in training). Before
v2 is registered, the logged batch is replayed against it with
[`replay-log.py`](../../deploy/scorer/replay-log.py).

**v2 not registered, 2026-11-24 00:30 UTC.** Trained on the 1,400 pairs
(3 epochs, 2 h 30 min; 72.5% on its held-out pairs, length baseline 55%,
verdict PASS; `adapterbuild` Stage 1 passed, keccak256
`0x5a616071…10bb6b`). Replayed on a temporary executor against the node's
logged batch, it ordered **8 of the 15** pairs (v1: 7), so it would fail the
same check. It ordered every passage-extraction pair and three of the four
workflow pairs. It missed both direct factual answers and four of the seven
evaluations. In each of those, the right answer depends on knowing a fact
about the world (who directed a film, the year of a prize, where a tune came
from), which a rank-8 adapter on ModernBERT-base cannot learn from generated
pairs. We stopped work on this intent there and used the server's CPU for
intents with no champion. The package stays on the scorer server, not here,
because it was never registered.

## Training data: `generate_pairs.py`

A pair is (question, better evaluation, worse evaluation). The better one is
right by construction: each output is built from facts the script holds, with
exactly one planted flaw or none, so the true errors are known.

| Output kind | What the model was asked |
|---|---|
| fact | a short factual answer (capitals, elements, dates, distances) |
| calc | a worked calculation (percentages, unit conversions, totals) |
| summary | a summary of a passage given in the task, with figures and names |
| cited | an answer citing numbered sources given in the task |
| code | a short Python function for a stated job |

Flaws planted in half the outputs: wrong_fact, wrong_arithmetic,
changed_figure, swapped_entity, unsupported_detail, wrong_citation, code_bug.

| Worse evaluation (`worse_kind`) | What it gets wrong |
|---|---|
| missed_error | praises a flawed output and lists no errors |
| invented_error | names an error in a correct output |
| wrong_target | names an error, but in a claim that is correct |
| bad_correction | names the right claim, then "corrects" it to another wrong value |
| inconsistent | the rating contradicts the score or the errors it lists |

Invented errors use the same templates as real ones, with plausible near-miss
values, and both sides share openers, strengths, closers and hedges in three
answer styles (JSON, labelled lines, prose), so length and surface words do
not give the answer away. The kit's dataset gate on 1,200 pairs (seed 7):

| Check | Value | Limit |
|---|---|---|
| surface probe | 64.3% | at most 65% |
| length shortcut | 52.9% | at most 65% |
| unique rejected answers | 100% | at least 80% |
| eval negatives leaked into training | 0 | 0 |

```
python3 generate_pairs.py --n 1200 --seed 7 --out pairs.jsonl
python3 generate_pairs.py --n 240 --seed 97 --out test.jsonl
```

## Training and package (version 1)

Kit `train_adapter.py`, ModernBERT-base, LoRA rank 8, alpha 32, 3 epochs, max
length 512, on 1,020 pairs (2 h 9 min on the scorer VPS's CPU); full record in
[`package-v1/train-result.json`](package-v1/train-result.json).
**Pairwise accuracy on 240 held-out pairs from another seed: 83.75%**
(length baseline 51.0%), verdict PASS. This is on our own generated pairs;
the node's public and hidden pairs are written by others.

Package: [`package-v1/LLM_OUTPUT_EVALUATION.safetensors`](package-v1/),
6,776,916 bytes, keccak256
`0x8b2c89ff070fb58fe7256b4e44ee2ae8efb0348e1958432b2e08ab326fcf842d`, sha256
`0324522ee1339105c85755e50b87eaeb5ac1343852d889fac38aded3ac137dbe`, class
`judgment`. `adapterbuild lora` passed Stage 1, loaded it on the foundation
and scored its input twice with identical bits (`0x3d9290c8`). The kit's
catalog lists this intent as judgment, so no catalog patch was needed.

## The executor

`https://scorer.truvian.xyz/lle/runnable`: the kit's `adapterexec` serving
this package as `truvian-scorer-lle` (127.0.0.1:8083), started on demand by
the adapter gate ([`../../deploy/scorer/adapter-gate.py`](../../deploy/scorer/adapter-gate.py))
and stopped after 15 idle minutes. Requests are logged to
`/var/log/nginx/scorer-lle-body.log`, so the node's public batch can be
replayed against a later version. Checked through the public URL with the
last 10 held-out pairs, tokenised as the node does: 8 of 10 ordered, 113 s
(including a cold start). The reply echoes the foundation, adapter and
tokenizer hashes when the request carries them.
