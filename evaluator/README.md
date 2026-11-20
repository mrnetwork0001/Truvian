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

Bounties: `telegraphprotocol/bounties` #87 and #179.

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

`ONCHAIN_METRIC_VERIFY_GENERAL` also asks about Polygon and Arbitrum, and no
free keyless API was found that returns a decimal balance at a block there:
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

`npm run test:truth` checks those rules with stand-in endpoints and, live,
that the answer for an address at blocks 2 days, 60 days and a year old on
each chain equals every archive endpoint's own read.

## Known limits

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
```

The script asks for the private key with hidden input, checks that the
signature belongs to the address given, uploads, and prints the state of the
uploaded row (`admitted`, then `eligible` after the next epoch rollover, or
`rejected` with a reason).
