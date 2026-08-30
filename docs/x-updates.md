# X Update Log — @Telegraphprotoc engagement track

25% of the Track 1 score is X engagement. Every meaningful milestone posts the
same day, tagged **@Telegraphprotoc**. This file logs drafts and what was posted.

---

## FINAL THREAD — the whole arc, Aug 23 → 30 (post this one; supersedes posts 1–4 below)

Enter the same handle on submissions.telegraphprotocol.com — the judges'
table counts tweets mentioning @Telegraphprotoc from that handle.

**1/** *(attach: submissions dashboard or explorer WASM leaderboard showing #544/#617 as former champions)*
> Day 8 of building on @Telegraphprotoc. Final update before Tracks 1 & 2 close:
> → miner live on Base, serving ONCHAIN_TX_LOOKUP + GAS_PRICE
> → our WASM judge took the ONCHAIN_TX_LOOKUP championship — twice
> → 10 gauntlet submissions, every rejection reverse-engineered
> Thread 🧵

**2/** *(attach: miner.truvian.xyz landing page)*
> The miner: exact on-chain answers read live from JSON-RPC — Base, Ethereum, Base Sepolia. Tx lookups include the OP-stack L1 data fee most implementations silently drop. Live at miner.truvian.xyz, ~0.8s median — faster than the intent's rank-1 miner.

**3/**
> Track 2: each intent's judge is a WASM module anyone can challenge; the node promotes you only if you separate good answers from bad more clearly than the incumbent. Rejected twice, then promoted. Dethroned. Promoted again. Dethroned by a step-function scorer.

**4/**
> What we learned about judging on-chain answers: text similarity can't tell "reverted" from "succeeded" when the numbers match. The incumbent scored a wrong-status answer 0.998 and a value-dump 0.998. Ours: 0.006 and 0.49. Facts, not vocabulary.

**5/**
> Then the arms race went meta: a champion with a hard step function maxed the benchmark's margin metric while scoring every REAL answer near zero — the live leaderboard collapsed to ≤0.013 for everyone. We documented it, told the team, and kept challenging.

**6/**
> v8 beat that champion's margin 0.857 vs 0.693 — then lost to a 10-minute evaluation clock. v9: same logic at 171 KB. Then one fixture, one ordering short. We hunted it with six adversarial fixture generators against the champion's own binary. v11 is next.

**7/**
> Everything is public and reproducible — fixtures, comparison harness, every binary, every rejection reason: github.com/mrnetwork0001/Truvian
>
> Track 3 opens tomorrow: Truvian Shield, an execution-safety agent that consumes live Telegraph miners before an agent signs. @Telegraphprotoc

---

## Post 1 — entry announcement (draft, ready to post)

> Building for the @Telegraphprotoc Season I hackathon: Truvian — an exact
> on-chain truth miner for Base.
>
> Serving ONCHAIN_TX_LOOKUP + GAS_PRICE. Tier A intents are scored by exact
> match, so the whole game is being *precisely* right — including the OP-stack
> L1 data fee most tx-cost calculations silently drop.
>
> Handlers are live against Base mainnet and passing a 15-check verification
> suite (fee invariants, determinism, revert handling).
>
> Track 2 eval script next. Building in public here 🧵

*(Optionally attach a screenshot of the `test:miner` run — all-green checks
make a good visual.)*

## Post 2 — miner registered (draft, pending registration)

> Truvian is registered and live on the @Telegraphprotoc leaderboard for
> ONCHAIN_TX_LOOKUP + GAS_PRICE. [details after registration]

## Post 3 — Track 2 scorer built (draft, ready once submitted)

> Track 2 shipped: a WASM scoring module for ONCHAIN_TX_LOOKUP on
> @Telegraphprotoc.
>
> The incumbent judge is generic text similarity. Ours extracts the on-chain
> facts — tx hashes, addresses, exact uint256 wei values, status — and scores
> factual correctness, with penalties for value-dump gaming.
>
> 110 KB, zero imports, 18/18 through Telegraph's own wazero harness.
> Deterministic to the byte. May the best judge win.

---

## Post 4 — the gauntlet iteration story (draft; post after v3 submission, any verdict)

> Two rejections, each one a lesson. Building a WASM judge for
> @Telegraphprotoc's ONCHAIN_TX_LOOKUP intent:
>
> v1: lost on ordering (13/15 vs champion's 15/15).
> v2: fixed ordering (15/15), beat the champion's margin (0.576 vs 0.557) —
> then hit a gate that didn't exist at breakfast: agreement with the champion
> on real traffic. Missed by 0.031.
>
> Along the way we benchmarked the incumbent with its own harness: on answers
> containing every correct number but a negated conclusion ("did NOT
> succeed…"), it ranks the wrong answer ABOVE the right one. Our scorer reads
> the logic, not just the vocabulary: 0.995 vs 0.035 on the same trap.
>
> Fixture suite, comparison harness, and every iteration are public in the
> repo. This is what "resistance to gaming" looks like in practice.
>
> v3 verdict: PROMOTED. 🏆 Truvian is now the live champion scorer for
> ONCHAIN_TX_LOOKUP — ordering 15/15, margin 0.565 vs 0.557, real-traffic
> agreement 0.645. Three submissions, two rejections, one belt. Every
> gauntlet gate was measured locally before we cleared it — with the node's
> own runtime, the champion's own binary, and live miners' real answers.

*(Attach: dashboard screenshot of the ACTIVE/champion card + the two
rejection cards above it — the arc is the story.)*

## Post 5 — the title war (draft; the current end of the story)

> The championship lasted 90 minutes. A challenger (reg 551) took it with a
> better margin. So we did what you do to a public binary: downloaded it and
> ran it through the official harness.
>
> Findings: the new judge scored "reverted" and "succeeded" identically
> (0.998), gave answer-stuffing a perfect 1.0, and broke on Chinese.
>
> v4 fixes what it gets wrong and beats it at what it gets right: margin
> 0.619 vs 0.597, agreement 0.731. Crown retaken. 🏆
>
> Five submissions. Two championships. One defense. All in day one, all
> reproducible: github.com/mrnetwork0001/Truvian @Telegraphprotoc

### Cadence plan
- Day of registration: post 2
- Each hardening milestone (fallback RPCs, eval script submitted, latency work): short update
- Track 3 launch (Aug 31): Truvian Shield announcement
- Keep every post concrete: a number, a screenshot, or a link. No filler.
