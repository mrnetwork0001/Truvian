# OPTIMAL_EXECUTION_ROUTE evaluator adapter

Our second evaluator adapter, after the SMART_CONTRACT_AUDIT champion
([`../adapter/`](../adapter/)). OPTIMAL_EXECUTION_ROUTE had no champion when
we started (checked 2026-11-23): four adapters had been registered for it
and none was active. Three never got a hearing because their executors were
unreachable or refused the batch. The fourth (id 94) ordered 10 of the node's
15 public pairs, below the 70% floor. Our miner does not serve this intent,
so the adapter scores other teams' miners, never ours.

**Status, 2026-11-23 11:38 UTC: v1 registered as id 209** (tx
`0x74a0494788d0e00bc8bd69802a75a2b6addaf8574234fec701ab06a5f7d6f81b`,
package URL pinned to commit `36e46e0`, runnable URL
`https://scorer.truvian.xyz/oer/runnable`). Waiting for the node's
public-pair check (needs 11 of 15) and the hidden benchmark (70% floor with no
incumbent). Progress: `GET https://devnode.telegraphprotocol.com/api/wasm/209`.

## The intent

Sell exactly 1 ETH for USDC on Ethereum mainnet; the scored field is
`amount_out` in USDC base units (6 decimals), between 10^8 and 10^11
(`GET /engine/v1/intents/OPTIMAL_EXECUTION_ROUTE`).

## Training data: `generate_pairs.py`

An adapter cannot know the live price, so a pair is never decided by price.
Each pair puts one correct answer against the same answer with one fault a
judge can check inside the text:

| Fault (`worse_kind`) | The worse answer |
|---|---|
| whole_units | amount_out given in whole USDC, not base units |
| wei_units | amount_out with 18 decimals instead of USDC's 6 |
| decimal_slip | base units off by a factor of 10, 100 or 1,000 from the whole-USDC figure |
| inverted | the route quoted the other way: 1 USDC sold for ETH, amount in wei |
| wrong_pair | names another token received (USDT, DAI, USDe, USDC.e, PYUSD) |
| wrong_chain | the route placed on another chain (Base, Arbitrum One, OP Mainnet, Polygon, BNB Smart Chain, Avalanche) |
| contradiction | amount_out 12% to 40% away from what the stated price and fee give |
| out_of_range | amount_out outside the intent's range of 10^8 to 10^11 |
| no_number | the figures replaced by words ("the current amount of", "the live price in") |
| range | a range (plus or minus 5%) instead of one amount |

Both sides draw on one pool of phrases (routes, venues, caveats), so length
and surface words do not give the answer away. The kit's dataset gate on
1,200 test pairs:

| Check | Value | Limit |
|---|---|---|
| surface probe | 62.6% | at most 65% |
| length shortcut | 51.0% | at most 65% |
| unique rejected answers | 100% | at least 80% |
| eval negatives leaked into training | 0 | 0 |

## Training and package (version 1)

Kit `train_adapter.py`, ModernBERT-base, LoRA rank 8, alpha 32, 3 epochs,
max length 512, on 1,020 pairs; full record in
[`package-v1/train-result.json`](package-v1/train-result.json).
**Pairwise accuracy on 240 held-out pairs: 96.67%** (length baseline 50%),
verdict PASS.

Package: [`package-v1/OPTIMAL_EXECUTION_ROUTE.safetensors`](package-v1/),
6,776,916 bytes, keccak256
`0x4503820bb1d689a2e9edff7f660a6528b69dbaeb3d03d00111edd9c2ae648a52`, class
`judgment`. `adapterbuild lora` passed Stage 1, loaded it on the foundation
and scored its input twice with identical bits (`0xbf5624ae`).

**The class.** The kit's compiled-in catalog (commit `1ed063e`, 1 Nov) lists
this intent as hybrid, so `adapterbuild` refuses a judgment package. The node
says judgment (`"class":"judgment"` from the intent API), and the package of
registration 94, which declares judgment, passed the node's install checks
and reached the public-pair check. So the package is judgment, and the
`adapterbuild` check was run with this intent removed from the kit's
`compiledHybrid` list in our scratch copy (restored afterwards).

## The executor

`https://scorer.truvian.xyz/oer/runnable`: the kit's `adapterexec` serving
this package on its own process (`truvian-scorer-oer`, 127.0.0.1:8082) beside
the SMART_CONTRACT_AUDIT executor, which it does not touch. Requests are logged
to `/var/log/nginx/scorer-oer-body.log`, so the node's public batch can be
replayed against a later version. Checked through the public URL with 10
held-out pairs, tokenised as the node does: 10 of 10 ordered, 115 s.
