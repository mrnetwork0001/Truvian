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

## Randomized runs: 53 questions across five chains

The fixed questions above are ones we picked. To remove that choice, the
script's `--random` mode draws its questions from the chain itself
(`npx tsx src/scripts/frontier-compare.ts --random [--agent] [--seed N]`):

- the fee of 4 random transactions per chain, taken from blocks 5, 8 and 11
  below the tip;
- the native balance of 3 of those transactions' senders;
- the USD liquidity of Uniswap V3 pools that emitted a swap in those blocks
  (pools under $1,000 skipped);
- the total supply of 2 tokens per chain from our token registry;
- the gas price.

The chains are Ethereum, Base, Arbitrum One, Polygon PoS and BNB Smart Chain.
Each run drew 53 questions: 20 fees, 15 balances, 10 supplies, 5 gas prices
and 3 pools. The seed defaults to the Ethereum block number, and each JSON
file records the seed it used (478025 and 478309), so a run can be drawn
again. The two runs drew different questions.

**Run 3, random questions, a model may decline**
([`2026-11-23-random-may-decline`](frontier-comparison/2026-11-23-random-may-decline.md)):

| Model | Correct | Wrong | Declined | Empty | Errors |
|---|---|---|---|---|---|
| claude-opus-5.5 | 1 | 0 | 52 | 0 | 0 |
| gpt-6.1-sol | 1 | 0 | 52 | 0 | 0 |
| gemini-3.1-pro-preview | 1 | 0 | 52 | 0 | 0 |
| deepseek-v4-pro | 1 | 3 | 31 | 18 | 0 |
| Truvian (chain reads) | 53 | 0 | 0 | 0 | 0 |

**Run 4, random questions, prompted as an agent's data step**
([`2026-11-23-random-agent`](frontier-comparison/2026-11-23-random-agent.md)):

| Model | Correct | Wrong | Declined | Empty | Errors |
|---|---|---|---|---|---|
| claude-opus-5.5 | 2 | 1 | 50 | 0 | 0 |
| gpt-6.1-sol | 2 | 1 | 50 | 0 | 0 |
| gemini-3.1-pro-preview | 2 | 51 | 0 | 0 | 0 |
| deepseek-v4-pro | 1 | 5 | 0 | 47 | 0 |
| Truvian (chain reads) | 53 | 0 | 0 | 0 | 0 |

**The pattern holds on questions we did not choose.** Of 424 model answers,
11 were correct. Ten were fixed supplies a model can know from training:
LINK's 1 billion, UNI's 1 billion and AAVE's 16 million. Claude gave UNI's
figure with a warning to check it on the chain. The one live figure a model
got right was GPT's Arbitrum gas price of 0.02 gwei, against 0.0215 on the
chain. Arbitrum's gas price barely moves.

**When the prompt asks for a number only, Gemini answers anyway, and is
wrong 51 times in 53.** It answered "0" to 35 questions, including every
balance and most fees. Its other figures:

| Fact | Gemini's figure | Chain reading |
|---|---|---|
| WETH supply on Base | 73,295 | 275,965 |
| DAI supply on Arbitrum | 65 million | 14.1 million |
| USDT supply on BNB Smart Chain | 3.54 billion | 9.18 billion |
| Polygon gas | 30 gwei | 282 gwei |
| BNB Smart Chain gas | 3 gwei | 0.05 gwei |
| a BNB Smart Chain transaction fee | 0.000105 BNB | 0.0000029 BNB |

DeepSeek returned nothing on 47 of 53 questions in Run 4 (its reasoning
used up the token limit) and said "0" for three balances. In Run 3 it stated
a fee of 10,668.73 ETH for one Ethereum transaction.

**What it cost.** Gemini used 102,419 output tokens for its 53 number-only
replies, DeepSeek 204,073. Claude used 14,075 and GPT 7,925, mostly on
refusals. Truvian answered all 53 from chain reads.

## What the fixed questions show

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

- It covers four models and one run per question: 10 to 11 fixed questions
  and two random draws of 53. The random runs remove our choice of questions,
  but not the choice of question kinds, which are the facts our desks buy.
- The models had no tools. An agent with a browsing or RPC tool could look
  the facts up, which is what a specialist miner sells.
- Run 2's prompt is designed to stop declining. It shows what happens when an
  agent's pipeline demands a number. It does not show how a model behaves in
  general.
- Liquidity is priced with DefiLlama's prices, and gas moves block to block.
  The scorer's tolerances allow for this: 5% to 10% for liquidity and 25% to
  50% for gas.
