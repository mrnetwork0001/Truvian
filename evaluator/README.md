# Evaluation material

Truvian's contributions to the Telegraph evaluation pool for Season II.

Both intents below are **deterministic**: each has one right answer, and the
network gets it from *truth sources*. A truth source is a free public API
that needs no key, described in the same format as a miner YAML. Each epoch
the node calls up to three of them per question, takes the median, and scores
every miner against it. A wrong truth source makes correct miners look
wrong, so each one here is checked against the chain before it is uploaded.

| File | Intent | API | Covers |
|---|---|---|---|
| `truth-sources/onchain-metric-routescan.yaml` | `ONCHAIN_METRIC_VERIFY_GENERAL` | Routescan `balancehistory` | Native balance of an address at a block, Ethereum |
| `truth-sources/gas-price-metamask.yaml` | `GAS_PRICE_GENERAL` | MetaMask gas API | Estimated base fee, Ethereum, Arbitrum One, Avalanche C-Chain |
| `truth-sources/onchain-metric-truvian.yaml` | `ONCHAIN_METRIC_VERIFY_GENERAL` | Truvian truth API (ours, `src/truth`) | Native balance of an address at a block, Ethereum, Polygon PoS, Arbitrum One |
| `truth-sources/token-total-supply-truvian.yaml` | `TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL` | Truvian truth API, `/total-supply` | ERC-20 total supply in whole tokens, now; Ethereum, Base, Arbitrum One, OP Mainnet, Polygon PoS |
| `truth-sources/wallet-balance-truvian.yaml` | `WALLET_BALANCE_CHECK_GENERAL` | Truvian truth API, `/wallet-balance` | Native or ERC-20 balance in whole units, now; same five chains |
| `truth-sources/onchain-tx-lookup-truvian.yaml` | `ONCHAIN_TX_LOOKUP_GENERAL` | Truvian truth API, `/tx` | Block a transaction was included in; same five chains |

Bounties: `telegraphprotocol/bounties` #87 and #179.

## Adapters

Judgment intents have no single right answer, so the node scores them with an
adapter: a LoRA layer on Telegraph's shared ModernBERT-base model that must
rank the better of two answers higher. We have two, each with its pair
generator, package and runbook in its own folder.

| Folder | Intent | Registration | Result |
|---|---|---|---|
| [`adapter/`](adapter/) | `SMART_CONTRACT_AUDIT` | id 187, Nov 22 ([`/api/wasm/187`](https://devnode.telegraphprotocol.com/api/wasm/187)) | **Champion**: the intent's first Canonical adapter, 83.33% of 30 hidden pairs (floor 70%). v1 (id 175) and v2 (id 182) were rejected on the public pairs first |
| [`adapter-oer/`](adapter-oer/) | `OPTIMAL_EXECUTION_ROUTE` | id 209, Nov 23 ([`/api/wasm/209`](https://devnode.telegraphprotocol.com/api/wasm/209)) | Pending (`awaiting_compatible_material` at 12:44 UTC); 96.67% of our 240 held-out pairs. No adapter had held this intent: three earlier ones had unreachable executors and one ordered 10 of the node's 15 public pairs |

Our miner does not serve `OPTIMAL_EXECUTION_ROUTE`, so that adapter never
scores our own answers. Both executors run on the scorer VPS behind
`scorer.truvian.xyz` (`/runnable` and `/oer/runnable`), and each logs the
node's requests so a rejected version can be retrained against the batch
the node actually sent, as v3 of the first adapter was.

## What was verified

`npm run verify:truth` builds each request from the descriptor itself, reads
the mapped output field, converts its unit, and compares the result with
archive RPC reads.

- **Balance at a block.** For ten address and block pairs taken from Ethereum
  blocks 2 days to 5 years old, the value equals `eth_getBalance` at that
  block to the wei. For Polygon and Arbitrum the API answers
  `status 0, chain not supported`, which the descriptor marks as a failure,
  so the source gives no value there instead of another chain's number.
- **Gas price.** On Ethereum, Arbitrum One and Avalanche the estimated base
  fee is within 15% of `eth_gasPrice`. Two runs on 2026-11-14 measured
  between 0.00% and 4.97% off: the API estimates the next block's base fee,
  which can move up to 12.5% from the current one.

## Why one source is our own

`ONCHAIN_METRIC_VERIFY_GENERAL`'s request schema also accepts Polygon and
Arbitrum (its `chain` enum), and no free keyless API was found that returns a
decimal balance at a block there:
Routescan does not index them, their Blockscout explorers sit behind a
browser challenge an automated caller cannot pass, Etherscan-family APIs need
a key, and JSON-RPC returns hex, which the mapping cannot convert.

So the third source is an API we run at `https://truth.truvian.xyz`
(`src/truth`), disclosed as ours in its own description. It does not answer
from one node: it reads the balance and nonce from two archive endpoints run
by different providers and returns a value only when they agree exactly.
Disagreement (502), fewer than two answers (503) or a block beyond the tip
(422) are HTTP errors, which the node treats as "no value" and leaves out of
the median. Truvian does not mine `ONCHAIN_METRIC_VERIFY`.

What is and is not shown, as of 2026-11-21: all three sources are `eligible`
in the evaluation pool. Eligible is not the same as used. The node's scoring
questions for `ONCHAIN_METRIC_VERIFY_GENERAL` are all on Ethereum (block
23000000), so the Polygon and Arbitrum coverage serves apps that ask, not
scoring. The server log for `truth.truvian.xyz` shows no request from the
node yet. `GAS_PRICE_GENERAL` has not been ranked for any miner since epoch 13
(18 Nov), so the gas source has fed no reference since then. The node
publishes no record of which source built which reference, so use of the
Routescan source cannot be confirmed either way.

`npm run test:truth` checks those rules with stand-in endpoints and, live,
that the answer for an address at blocks 2 days, 60 days and a year old on
each chain equals every archive endpoint's own read.

## Total supply, wallet balance and transaction block (ours)

Three more sources point at the same API (`src/truth/state.ts`,
`src/truth/tx.ts`), under the same rule: two endpoints from different
providers (`src/truth/endpoints.ts`, probed 2026-11-21) must read exactly the
same thing, or the answer is an HTTP error. Truvian mines all three intents,
so these sources score our own miner too. They share none of its code paths
or endpoint choices, and they answer less than the miner does: where the
miner tries to work out which token a question means, the truth API refuses.

- **Total supply and wallet balance** are read at one block about a minute
  below the tip, and the two endpoints must also agree on that block's hash.
  The block is returned with the value. Amounts are exact decimal strings
  with decimals applied (`total_supply`, `balance`). A token is the contract
  address in the question, or a symbol in the verified table (USDC, USDT, DAI,
  WETH, WBTC); its `symbol()` must match and a name written beside it must
  agree. A symbol outside the table ("Kelp DAO Restaked ETH (rsETH)"), an
  address with no code on the chain ("USDC (0xA0b8…) on Arbitrum") and a total
  supply with no chain named are refused, not guessed.
- **Transaction block** reads the receipt and transaction from two receipt
  archives that served three-year-old receipts. Both lacking the
  transaction is 404; it is never answered as a value. The node's question key
  is Ethereum's first transaction (block 46147): before Byzantium a receipt has
  no status, eth.drpc.org reports one anyway and rpc.mevblocker.io does not,
  so the (unscored) status is read as null there.

`npm run verify:truth` sends each of the node's own question keys through
these descriptors to the live API: supply and balance are within the intent's
tolerance (50 and 100 bps) of a separate read, measured at under 0.001 bps,
and the block number is exact. `npm run test:truth` checks the agreement
rules with stand-in endpoints, and live, that every answer equals each
endpoint's own read at the answer's block on all five chains, and that
transactions 2 days, 1 year and 3 years old come back in the block they were
taken from.

All three were uploaded on 2026-11-21 and were `eligible` in the evaluation
pool by 15:50 UTC the same day. As with the first three, eligible is not the
same as used.

### Open for review and co-ownership (from 2026-11-23)

Telegraph asks evaluators not to build tests around their own miner. These
three sources set references for intents our miner is scored on, so we are
handing them over instead of keeping sole control of them:

- **Review.** Any team can check every reference independently:
  `npm run verify:truth` and `npm run test:truth` run against the live API,
  and `src/truth` is the whole server. If a reference is wrong, open an issue
  here. Once a wrong reference is confirmed, the API stops serving that kind
  of answer until it is fixed: it returns an HTTP error, which the node leaves
  out of the median.
- **Co-ownership.** We are looking for another team, preferably one with no
  miner in these intents, to co-maintain the sources: review every change to
  `src/truth`, and run a mirror of the truth API from this code on their own
  server, so that no reference depends on our server alone. The descriptors
  would then name both endpoints.
- **Until someone takes this up,** the sources keep running as described
  above, and every change to `src/truth` is a public commit.

## Known limits

- The three newer sources are ours as well, so for those intents too they are
  one contributor's source, and the node's question keys for them are all on
  Ethereum (as of 2026-11-21); the other four chains serve apps that ask.
- Their endpoints are free public tiers. A burst of test reads rate-limited
  optimism.drpc.org; OP Mainnet then falls back to 10.rpc.thirdweb.com, which
  answers in about 2 s. Blast API, an Arbitrum archive here, has already shut
  down on OP Mainnet and Polygon.

- The Routescan source covers Ethereum only; Polygon and Arbitrum are
  covered by our own API (above), which is one contributor's source, not an
  independent third party.
- The Arbitrum archive endpoints are a short list: a balance more than about
  a year old needs both arb-pokt.nodies.app and the Blast API endpoint, and
  Blast has announced its shutdown on other chains.
- Routescan answers a block number beyond the chain tip with the latest
  balance. A question about a block that does not exist has no right answer
  either way.
- The gas source reports the base fee, not `eth_gasPrice`. The two agree on
  the three chains offered. On Polygon, OP Mainnet, Base and BNB Chain a
  priority fee is effectively mandatory and the base fee understates the gas
  price (on OP Mainnet by 7x, and BNB Chain's base fee is 0), so the
  descriptor refuses those chains.
- The intent's `chain` is a name and both APIs take an EIP-155 chain id. The
  node's request builder makes that translation from the mapping's `how`
  text. The verification script does it with a fixed table, so that one step
  is not exercised here.
- Hex-returning endpoints (`eth_gasPrice`, `eth_getTransactionCount` through
  explorer proxies) were not used: the mapping converts units in code and
  has no conversion from hex.

## What the node's schema refuses

The first upload of both sources (2026-11-14) was stored and then rejected
with `source_unparseable`. The pool does not say which rule failed. The cause
was `accepted_fields` on a parameter, written as a list the way the YAML docs
show it: the node's schema answers `accepted_fields: Invalid type. Expected:
object, given: array` (its verdict on another operator's miner registration,
read from `GET /api/miners/{registrationId}`), and no active miner on the
network uses the field.

The allowed chain ids are now an `enum` in the top-level `input_schema`,
which the node also checks a built request against. Before the second
upload, every key in both descriptors was compared with 366 descriptors the
node has active: none is unseen. `verify:truth` fails if `accepted_fields`
comes back.

## Uploading

Uploads are signed by the contributor wallet and credited to it. They are
free and register nothing on-chain, but they change the live pool from the
next epoch.

```bash
npm run verify:truth
evaluator/upload-truth-source.sh ONCHAIN_METRIC_VERIFY_GENERAL evaluator/truth-sources/onchain-metric-routescan.yaml <address>
evaluator/upload-truth-source.sh GAS_PRICE_GENERAL evaluator/truth-sources/gas-price-metamask.yaml <address>
evaluator/upload-truth-source.sh TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL evaluator/truth-sources/token-total-supply-truvian.yaml <address>
evaluator/upload-truth-source.sh WALLET_BALANCE_CHECK_GENERAL evaluator/truth-sources/wallet-balance-truvian.yaml <address>
evaluator/upload-truth-source.sh ONCHAIN_TX_LOOKUP_GENERAL evaluator/truth-sources/onchain-tx-lookup-truvian.yaml <address>
```

The script asks for the private key with hidden input, checks that the
signature belongs to the address given, uploads, and prints the state of the
uploaded row (`admitted`, then `eligible` after the next epoch rollover, or
`rejected` with a reason).
