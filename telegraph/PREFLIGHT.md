# Truvian Shield: token preflight and listing review

**Live:** <https://truvian.xyz/preflight> · **API:** `POST https://truvian.xyz/api/preflight` · **Source:** [`src/shield/preflight.ts`](../src/shield/preflight.ts)

Shield decides about a token before anyone acts on it. It buys security,
supply, wash-trading, liquidity and sanctions intelligence through Telegraph
and checks it against the chain. The result is a signed memo that gives the
decision, every finding with its evidence, and what the decision cost.

One engine serves two desks, one for each Season II mission:

| Desk | Mission | Customer | Decision |
|---|---|---|---|
| Token preflight | [14, Web3 Native & DeFi](https://github.com/telegraphprotocol/bounties/issues/202), route 1 "token-risk preflight" | a trading agent about to buy a token | HOLD / REVIEW / REJECT; the buy is simulated |
| Listing review | [01, Exchange](https://github.com/telegraphprotocol/bounties/issues/189), route 1 "autonomous listing review" | an exchange listings desk | LIST / REVIEW / REJECT for the contract, its issuer and its treasury wallet |

## Try it

Open <https://truvian.xyz/preflight>, pick a desk, and run a fixture or your
own token. Each Telegraph answer appears as it lands, with its miner, cost,
latency and signal hash, followed by the decision and the signed memo.

From an agent:

```bash
# trading agent: may I buy $1,000 of WETH through the Uniswap V3 USDC/WETH pool?
curl -s https://truvian.xyz/api/preflight -H 'content-type: application/json' -d '{
  "mode": "trade", "chain": "ethereum",
  "token": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "pool":  "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  "tradeUsd": 1000
}' | jq '{decision: .memo.decision, rule: .memo.decisionRule, cost: .memo.cost, url}'

# listings desk: should we list UNI? issuer screened, treasury balance checked
curl -s https://truvian.xyz/api/preflight -H 'content-type: application/json' -d '{
  "mode": "listing", "chain": "ethereum",
  "token": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  "issuer": "Uniswap Labs",
  "treasury": "0x1a9C8182C09F50C8318d769245beA52c32BE35BC"
}' | jq '{decision: .memo.decision, findings: [.memo.findings[] | {severity, title}]}'
```

Add `?stream=1` to receive NDJSON progress events: `chain`, `plan`, one
`purchase` per answer, then `memo`. Free use is rate limited per visitor,
like the pre-sign check.

## What one decision does

1. **Free chain reads at one block** ([`tokenFacts.ts`](../src/shield/tokenFacts.ts)).
   These are Truvian's own JSON-RPC reads, labelled as such in every memo,
   never presented as Telegraph answers:
   - whether the address holds contract code; an EIP-7702 delegation does not count;
   - name, symbol, decimals and totalSupply;
   - owner();
   - the proxy implementation and admin (EIP-1967 or ZeppelinOS slots).

   An address with no contract code is rejected here, and nothing is bought.
2. **One routed Telegraph request per fact.** Each request goes to Anjoman's
   routed ask (`POST https://backend.telegraphprotocol.com/engine/ask` with
   `intent` and typed `params`). The node routes it once to its ranked miner,
   the answer is paid from escrow, and the reply carries a payment receipt
   that goes into the memo. Since 2026-11-21 08:20 UTC this is one billed
   miner call per fact. Before that, Shield used the agent route
   (`/agent/chat`), whose agent kept making billed calls to other miners
   after Shield had its answer (see Accounting below).

   | Fact | Intent | Scored field used |
   |---|---|---|
   | contract security | `SECURITY_REVIEW_GENERAL` | `verdict`, `vulnerability_count`, `issues`, scan facts in `summary` |
   | total supply | `TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL` | `total_supply`, compared with the chain read |
   | wash trading | `WASH_TRADING_DETECTION_GENERAL` | `wash_volume_pct` |
   | pool depth | `LIQUIDITY_DEPTH_VERIFY_GENERAL` | `liquidity_usd` |
   | issuer sanctions (listing) | `SANCTIONS_SCREENING_MATCH_GENERAL` | `matched`, `match_score` |
   | treasury balance (listing) | `ONCHAIN_METRIC_VERIFY_GENERAL` | `balance_gwei`, compared with the chain read |

   An answer bought in the last 10 minutes is reused at $0 instead of bought
   again. A failed answer is never reused.
3. **Fixed rules** ([`evaluate()`](../src/shield/preflight.ts), a pure
   function). The thresholds are written into every memo, so anyone can
   re-derive a decision:
   - any blocking finding rejects;
   - any finding that needs a person makes the decision REVIEW;
   - only a run where every check answered and nothing was raised clears.

   **A check that did not answer can never clear a token.**
4. **A signed memo** ([`memo.ts`](../src/shield/memo.ts)):
   - The memo is hashed as canonical JSON (keys sorted, no whitespace).
   - The digest is signed as the EIP-191 message `Truvian Shield memo sha256:<hex>`.
   - The signing key is used for nothing else. Its address is
     `0x956aECB0b0DEfC2f2631C26ec0FF7366Ebb53245`.
   - Anyone can verify a memo with any EIP-191 library, or with `POST /api/memo/verify`.

### The rules

| Finding | Severity |
|---|---|
| no contract code at the address | block (nothing bought) |
| honeypot reported, or buy or sell tax ≥ 50% | block |
| security verdict `Insecure` | block |
| ≥ 50% of volume is wash trading | block |
| issuer matches a sanctions list | block |
| security verdict `Needs changes`, a reported weakness, honeypot status not determined, tax ≥ 10% | review |
| no verdict and incomplete scan facts (honeypot, both taxes, holder concentration) | review |
| total supply more than 50 bps from the chain read, or treasury balance more than 5 bps from it (the node's own comparator tolerances) | review: conflicting sources |
| 20-50% wash volume, pool under $100k, trade over 1% of the pool | review |
| top 10 holders above 50%, with a pool under $1M | review (with a deeper pool this is disclosed as info) |
| sanctions near match (score ≥ 0.85) or no clear result | review |
| any check that did not answer, or escrow or budget too low to buy | review |
| an answer that says it examined nothing ("no code was provided", "insufficient data"), whatever verdict or figure it carries | review: no evidence either way; it can neither clear nor reject a token |
| upgradeable proxy, contract owner | info, disclosed |

## Measured on 2026-11-20

These runs are against the live network, using `npm run test:preflight` with
`PREFLIGHT_LIVE=1` and the page.

| Input | Decision | Telegraph cost | Time | What happened |
|---|---|---|---|---|
| WETH, $1,000 through the USDC/WETH pool | **HOLD** | $0.04 (4 answers) | 66 s | scan clean, supply within 50 bps of the chain, 0% wash volume, $66.5M pool; 58.2% top-10 concentration disclosed as info because the pool is deep |
| the same request again | **HOLD** | **$0** (4 reused) | under 1 s | fresh answers reused instead of bought again |
| USDC, same pool | **REVIEW** | $0.04 | 108 s | the ranked security review (TxLens) said "Needs changes": one admin key can freeze, upgrade and mint |
| SQUID (the 2021 rug pull) on BSC, 19:20 answers | **REVIEW** | (rules on the live answers) | | honeypot status not determined, 59.1% held by ten holders, $167k pool |
| SQUID again on truvian.xyz, 20:33 ([memo](https://truvian.xyz/preflight?m=FKLfi2qT)) | **REVIEW** | $0.04 | 39 s | a different reviewer said "Secure" about code it never saw, and the wash check said "Insufficient data" next to 0%; the supply cross-check caught the ranked answer 514 bps under the contract's 800M. Both "examined nothing" answers now count as no evidence, so SQUID stays in REVIEW even without the supply gap |
| WETH again on truvian.xyz, 20:32 ([memo](https://truvian.xyz/preflight?m=63zSY25V)) | **HOLD** | $0.04 | 68 s | four paid answers, each with its signal hash |
| vitalik.eth as a "token" | **REJECT** | **$0** (nothing bought) | 0.3 s | EIP-7702 delegation, not contract code |
| listing with issuer "Garantex Europe OU" | **REJECT** | $0.04 | | OFAC SDN match, score 1; also a unit test on the recorded answer |
| listing: UNI by "Uniswap Labs", governance timelock as treasury ([memo](https://truvian.xyz/preflight?m=Pi1JfTCY)) | **REVIEW** | $0.04 | 109 s | the security reviewer refused ("intellectual property policies"), the wash check said "Insufficient data", and the issuer scored 0.85 against OFAC SDN without matching: each goes to a person. The treasury balance (0.2377 ETH) agreed with the chain read |

**Cost per decision, corrected on 2026-11-21.** The memos above record what
the answers Shield used were billed: $0.04 for a trade preflight and
$0.04-0.06 for a listing review. The node's ledger shows those runs actually
cost more, about $0.07 per preflight and $0.09 per listing review, because
the agent route Shield then used made extra billed calls to other miners
(and one refused answer that the memo recorded as $0). Since 2026-11-21
08:20 UTC Shield asks through `/engine/ask`, which bills exactly the one
miner call it routes: $0.01 per answer, each with a receipt, so a trade
preflight costs $0.04 and a listing review $0.04-0.06, now matching the
memo. A repeat within 10 minutes costs $0. Nothing is spent on inputs that
are not tokens.

**Latency:** each answer takes as long as the ranked miner that serves it.
On 2026-11-21 through `/engine/ask`: total supply about 3 s, liquidity about
8 s, the security review about 22 s. A decision takes as long as its slowest
answer plus the chain reads, 25-85 s in the runs so far. The node holds
$0.26 of escrow per ask while it runs, so asks only run three at a time when
the escrow holds at least $0.78; below that they queue. Below $0.26, nothing
is bought and the decision is REVIEW.

## Accounting: tracing what was paid

- **Each memo** lists, per answer, the miner, the signal hash and (since
  2026-11-21 08:20 UTC) the payment receipt: `receipt_hash`, `rail`
  (`escrow`), `payer`, the paid miner's registration id, the amount and the
  settlement epoch.
- **The signal** resolves on the node:
  `GET https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>`.
- **The payer's ledger** is public on the node:
  `GET https://devnode.telegraphprotocol.com/v1/ledger/account/0x29476125898638c8634a97fdca8994530e8c9055`.
  At 08:18 UTC on 2026-11-21 it read: deposited 2.00, charged 1.09, unbilled
  0.18, balance 0.91 (test USDC, 6 decimals).
- **The Anjoman account's own spend listing** (`GET /agent/spend`) is not a
  complete record: on 2026-11-21 it listed 20 jobs and $0.15, against $1.09
  charged on the node ledger above. Use the node ledger.

## Failure cases a reviewer can reproduce

| Case | How | Result |
|---|---|---|
| not a token | token = any wallet, e.g. `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | REJECT, $0, "EIP-7702 delegation to …" |
| a provider that examined nothing | SQUID on BSC (memo `FKLfi2qT`); unit test on the exact answers | REVIEW: "Security review did not examine the contract" |
| a check does not answer | seen live on 2026-11-20: the facilitator refused one liquidity payment twice in a row ("Payment was rejected by the facilitator"); Shield now retries twice with a backoff | REVIEW: "Pool liquidity: no answer"; the failure is not cached |
| conflicting sources | a supply answer more than 50 bps from the chain read (unit test with a 12.7% gap) | REVIEW: "Total supply conflicts with the chain" |
| sanctioned or uncertain screening | issuer `Garantex Europe OU`; a screening with no `matched` value | REJECT; REVIEW, never cleared |
| price impact | WETH with `tradeUsd` 5,000,000 | REVIEW: "Trade is 7.5% of the pool" |
| unavailable chain | an RPC outage | HTTP 503 `CHAIN_UNAVAILABLE`: nothing bought, no decision |
| spending limit | escrow below $0.26, or a plan over the $0.10 budget | REVIEW: "Escrow too low to buy" or "Over budget" |
| tampered memo | change any field and call `/api/memo/verify` | `signedByThisShield: false` |

## What we found about the network while building this

- **`SMART_CONTRACT_AUDIT_GENERAL` is not callable.** It is the first family
  both missions list, but its lifecycle state is `registered`: the node says
  it has no response format, its own or its family's, so there are no inputs
  or outputs to route. Shield uses `SECURITY_REVIEW_GENERAL`, which is
  active, instead.
- **The ranked security review often leaves its scored fields empty.** On
  2026-11-20, `verdict` came back `rejected` and `vulnerability_count`
  `missing`. In that case Shield clears a token only if the provider's scan
  facts (honeypot, buy and sell tax, holder concentration) are all present
  and clean, and it says so in the memo.
- **A ranked provider can say "Secure" about code it never saw.** At 20:33 UTC
  the ranked `SECURITY_REVIEW_GENERAL` answer for SQUID was verdict `Secure`,
  `vulnerability_count` 0: "No code, configuration, or system description was
  provided to evaluate". The same miner's wash-trading answer was 0% `organic`
  with a summary beginning "Insufficient data". The scored fields alone would
  have cleared a rug-pull token. Shield treats an answer that says it examined
  nothing as no evidence, and the cross-check against the chain caught a wrong
  total supply in the same run.
- **Ranking changes between asks.** The same USDC question went to two
  different miners an hour apart, and one answered "Needs changes" while the
  other left the verdict empty. A memo records which miner answered and its
  signal hash, so a decision can be traced to the answer it rests on.
- **The auto-routed ask needs a budget of at least $0.26 per message, but
  bills about $0.01.** An agent that sets `maxSpendUsd` to $0.10 is refused
  before anything is bought.

## Run it yourself

```bash
git clone https://github.com/mrnetwork0001/Truvian && cd Truvian && npm install
cp .env.example .env   # set TELEGRAPH_API_KEY (an anjoman.ai API key with escrow); optional SHIELD_MEMO_KEY
npm run test:preflight                    # rules on recorded live answers, memo signing; free
PREFLIGHT_LIVE=1 npm run test:preflight   # real preflights through Telegraph, about $0.08
npm run shield                            # http://127.0.0.1:8788/preflight
```

Settlement is on testnet. Answers are paid in test USDC from an Anjoman
escrow on Ethereum Sepolia, while the facts checked are about the mainnet
chain named in the request. Trades are only simulated; Shield never sends one.
