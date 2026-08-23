# X Update Log — @Telegraphprotoc engagement track

25% of the Track 1 score is X engagement. Every meaningful milestone posts the
same day, tagged **@Telegraphprotoc**. This file logs drafts and what was posted.

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

### Cadence plan
- Day of registration: post 2
- Each hardening milestone (fallback RPCs, eval script submitted, latency work): short update
- Track 3 launch (Aug 31): Truvian Shield announcement
- Keep every post concrete: a number, a screenshot, or a link. No filler.
