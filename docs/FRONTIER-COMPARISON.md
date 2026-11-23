# Frontier models against the chain, on the questions our desks buy

Run 23 Nov 2026 with [`src/scripts/frontier-compare.ts`](../src/scripts/frontier-compare.ts).
Every true answer was read from the chain at one block by the same code the
miner serves. Every reply was scored by rule, not by a model. Raw replies,
readings and token counts are in [`frontier-comparison/`](frontier-comparison/).

**Models:** `claude-opus-5.5`, `gpt-6.1-sol`, `gemini-3.1-pro-preview` and
`deepseek-v4-pro`, through the 0G compute router, with no tools.

**Questions:** the facts the preflight, listing and holdings desks need:
- USDC's total supply and SQUID's total supply;
- whether SQUID is safe to buy;
- the WETH/USDC 0.05% pool's USD liquidity;
- the fee of a transaction mined three blocks earlier;
- vitalik.eth's ETH balance;
- the gas price.

Each was asked twice: once pinned to a block, and once the way an agent
usually asks it ("right now").

## Results

**Run 1, where a model may decline** ("If you cannot know, say so"):

| Model | Correct | Wrong | Declined | Empty | Errors |
|---|---|---|---|---|---|
| claude-opus-5.5 | 1 | 0 | 10 | 0 | 0 |
| gpt-6.1-sol | 1 | 0 | 10 | 0 | 0 |
| gemini-3.1-pro-preview | 1 | 1 | 9 | 0 | 0 |
| deepseek-v4-pro | 1 | 0 | 7 | 3 | 0 |
| Truvian (chain reads) | 11 | 0 | 0 | 0 | 0 |

**Run 2, prompted as an agent's data step** ("Reply with exactly one number
and nothing else"):

| Model | Correct | Wrong | Declined | Empty | Errors |
|---|---|---|---|---|---|
| claude-opus-5.5 | 0 | 0 | 10 | 0 | 0 |
| gpt-6.1-sol | 1 | 0 | 9 | 0 | 0 |
| gemini-3.1-pro-preview | 1 | 9 | 0 | 0 | 0 |
| deepseek-v4-pro | 0 | 3 | 0 | 7 | 0 |
| Truvian (chain reads) | 10 | 0 | 0 | 0 | 0 |

Run 2 has 10 cases because the yes/no question about SQUID cannot be asked
for a number.

## What it shows

**Every model failed every live figure.** Across both runs, no model gave a
correct balance, liquidity, fee or gas price, or a correct supply for USDC.
The only correct figure was SQUID's total supply. It has been a fixed 800
million since its 2021 launch, so a model can know it from training.

**The ones that did not decline were wrong in ways an agent would act on.**
Gemini answered "0" five times when asked for a number only. It also gave
these figures:

| Fact | Gemini's figure | Chain reading |
|---|---|---|
| USDC supply | 24.0 billion | 44.3 billion |
| WETH/USDC 0.05% pool | $290 million | $71.2 million |
| vitalik.eth's balance | 245.5 ETH | 5.80 ETH |
| Ethereum gas | 15 gwei | 0.11 gwei |

With permission to decline, Gemini still stated a USDC supply of 33.2 billion
as exact, against 44.3 billion on the chain. DeepSeek gave $150 million,
245,000 ETH and 1 gwei, and returned nothing on 7 of 10 questions: its
reasoning ran past 4,000 tokens before it answered.

**The best behaviour was a refusal, which leaves the agent with nothing.**
Claude and GPT declined almost every figure, correctly. A refusal does not
let the agent act. Shield, the agent in our case, turns it into REVIEW, or
buys the fact.

**Where models do well is history.** All four knew the SQUID token was the
2021 rug pull. Shield's preflight also flags it, but from the chain: it
caught a supply 514 bps off the chain reading on memo `FKLfi2qT`. A new rug
pull is not in any model's training data. The chain read does not depend on
it.

## Cost per answer

- **Truvian.** A fact bought through Telegraph costs $0.01 from escrow, with
  a payment receipt. Our miner answers the same facts free when called
  directly, in about 0.6 s for a transfer and 1 to 2 s for a pool.
- **The models.** Their token counts are recorded per reply in the JSON
  files. A reply is cheaper than $0.01, but it does not contain the fact.

## Limits of this test

- It covers four models, 10 to 11 questions and one run per question, so
  read the results as illustrations, not rates.
- The models had no tools. An agent with a browsing or RPC tool could look
  the facts up, which is what a specialist miner sells.
- Run 2's prompt is designed to stop declining. It shows what happens when an
  agent's pipeline demands a number. It does not show how a model behaves in
  general.
- Liquidity is priced with DefiLlama's prices, and gas moves block to block.
  The scorer's tolerances allow for this: 5% to 10% for liquidity and 25% to
  50% for gas.
