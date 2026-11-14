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
  fee is within 15% of `eth_gasPrice` (measured 2026-11-14: 0.00%, 0.06% and
  2.87%).

## Known limits

- The balance source covers Ethereum only. The intent also allows Polygon
  and Arbitrum; no keyless API returning a decimal balance at a block was
  found for them (Routescan does not index them, and their Blockscout
  instances sit behind a browser challenge).
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
