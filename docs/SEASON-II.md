# Telegraph Hackathon Season II - facts, network state, strategy

Everything here was measured from the live network on **2026-09-30**, not taken from
marketing copy. Re-run the measurements with the commands at the bottom before
relying on any number.

---

## 1. The event

| | |
|---|---|
| **Window** | 1 Nov → 1 Dec 2026 (30 days), one midpoint checkpoint |
| **Prize pool** | $15,000 USD |
| **Registration** | <https://hackathon.telegraphprotocol.com/> - open now, one registration covers all three tracks |
| **Tracks** | 01 Miners (Intelligence Providers) · 02 Evaluators · 03 Apps & Agents |
| **Missions** | 15 commercial missions defined for Apps & Agents - <https://hackathon.telegraphprotocol.com/missions> |

**The stated thesis.** Season I proved builders could contribute intelligence,
evaluation and applications. Season II asks the harder question: *can that
intelligence actually power useful applications?* They start from the demand
side - define what applications need, then work backwards to the intelligence
required. Their words: "A Provider existing is not enough. An Evaluator existing
is not enough. A leaderboard existing is not enough. If the intelligence cannot
power a working application, it is not enough."

## 2. Our Season I result

- **3rd place, Miner track - $600.** Announced 2026-09-28.
  <https://x.com/Telegraphprotoc/status/2104484144684098021>
- Miner `truvian-onchain-truth`, registration **#172**, catalog id **8453** - still live.
- WASM evaluator regs **#544** then **#617** - held `ONCHAIN_TX_LOOKUP` champion
  twice, later dethroned.
- Truvian Shield (Track 3 app) - live at <https://truvian.xyz>, **zero external users**.

## 3. Network state, measured 2026-09-30

This is the part that should drive strategy.

| Measurement | Value |
|---|---|
| Active miners | **1,670** (up from a few hundred in Season I) |
| Distinct intents served | **134** (up from 40) |
| Miners per intent | **7-29** - every intent is already served |
| Miners that have **ever** served a request | **230 of 1,670 (13.8%)** |
| Total requests served, all-time, whole network | **34,603** |
| Intents where no dedicated miner has served anything | **90 of 134** |
| Avg intents claimed per miner | 1.15 (97.6% claim exactly one) |

**Conclusions.**

1. **Supply is glutted, demand is scarce.** There is no unserved intent to claim.
   Registering a miner is cheap; getting used is not. 86% of miners are idle.
2. **Breadth catches traffic.** The busiest miners are the broad ones:
   TxLens (72 intents, 3,550 reqs), ChainSight (60, 2,970), LiveCert (36, 1,867).
   Apps route to whoever serves the intent they need.
3. **Rank tracks usage, not just answer quality.** Every top-5 miner in our intent
   has 1,800-3,500 requests served. See §4.
4. **An app that genuinely buys is the rare asset.** The whole network has served
   34,603 requests ever. An app driving ~1,000 real requests in 30 days moves a
   measurable fraction of it - which is exactly what Season II says it wants to expose.

### Demand by intent (single-intent miners only, the clean signal)

| Intent | Requests |
|---|---|
| STORM_ALERT | 1,757 |
| WEATHER_FORECAST | 1,686 |
| URL_SCAN | 1,585 |
| CVE_LOOKUP | 1,533 |
| FRAUD_DETECTION | 933 |
| CRYPTO_PRICE | 727 |
| TVL_LOOKUP | 699 |
| TOKEN_HOLDER_COUNT | 696 |
| ONCHAIN_TX_LOOKUP | 694 |
| CHAT_COMPLETION | 388 |
| AI_TEXT_DETECTION | 386 |

Counting all miners (multi-intent inflates every intent they claim),
`ONCHAIN_TX_LOOKUP` is the **most demanded intent on the network at 15,843
requests**, followed by WALLET_BALANCE_CHECK (14,874) and CRYPTO_PRICE (13,540).

## 4. Where our miner actually stands (changed since Season I)

**We have slipped.** The README's "rank 2 on debut epoch" is historical, not current.

| Intent | Our rank | Our score | Leader score | Our requests |
|---|---|---|---|---|
| `ONCHAIN_TX_LOOKUP` | **10 of 23** | 0.00552 | 0.01151 (PREFLIGHT) | 579 |
| `GAS_PRICE` | **unranked** | - | 1.58e-11 (GasWire) | - |

Top of `ONCHAIN_TX_LOOKUP`: PREFLIGHT (2,579 reqs) · ChainSight (2,970) ·
TxLens (3,550) · DegenLens (3,265) · LiveCert (1,867). All broad, all heavily used.
Our 579 requests are real and unprompted - but a fifth of the leaders'.

## 5. The 15 commercial missions

| # | Mission | Buyer | What has to work |
|---|---|---|---|
| 01 | **Exchange** | Global spot and derivatives venues | Autonomous listings desk: contract audit, contributor authenticity, holder concentration, sanctions exposure → **signed listing risk memo with costs** |
| 02 | **Stablecoin** | Issuers and onchain credit | Agent fleet: expense ledgers, compliance screening, vault ops, borrowing, spending on intelligence, mining, repayment |
| 03 | **Institutional Markets** | Privacy-first issuance venues | Private asset marking, autonomous issuance desk with input pricing, pre-trade diligence with hidden order books |
| 04 | **Legal** | International law firms, HK/APAC | Regulatory monitoring with chain of custody, five-jurisdiction overnight diligence, agents negotiating services agreements |
| 05 | **Conflict Intelligence** | Systematic macro and commodities funds | Escalation scoring traceable to inputs and prices, media forensics, verified answers across rates/FX/energy |
| 06 | **Resources and Agriculture** | Mines, cattle stations, grain growers | Site-specific days-to-impact, destocking timelines, yield forecasts vs official estimates |
| 07 | **Consumer Platform** | Social, camera, messaging platforms | Models paying for unknown factors, camera authenticity verification, marketplace agents verifying each other |
| 08 | **Commodities** | Physical trading houses | P&L per intelligence unit, cargo/counterparty provenance receipts, agent bidding for scarce answers |
| 09 | **Personal Agent** | OpenClaw, Hermes Agent, Kimi Claw | Wallet and market integration, assistants publishing capabilities as miners, task swaps settled in group chats |
| 10 | **Model Economy** | Hugging Face, GitHub, OpenRouter | Leaderboards in cost per verified correct answer, supply-chain verification per commit, coding agents buying answers |
| 11 | **Autonomous Systems** | Robotics fleets, frontier hardware | Unified intelligence budget across machines, **verification before action**, mid-task skill purchases |
| 12 | **Mining and Power** | Bitcoin miners, AI compute operators | Hourly megawatt allocation agents, trustless SLA verification, curtailment decisions with receipts |
| 13 | **Asset Management** | Thematic issuers, index providers | Open research with priced inputs, rebalancing receipts, daily holdings proofs verifiable by investor agents |
| 14 | **Web3 Native and DeFi** | Onchain traders, conditional contracts, whitehat security | **Bytecode and drainer analysis purchasing**, conditional escrow settlement, bug bounty payments to proving machines |
| 15 | **Consumer Automation** | Retail consumers, travel, e-commerce | Agents buying disruption reports and filing refund claims with receipts, browser agents awaiting stock proof before checkout |

**Best fits for what we already have**

- **14 Web3 Native and DeFi** - closest. Shield is pre-signature risk analysis
  bought through Telegraph. `ONCHAIN_TX_LOOKUP` is the most-demanded intent and we
  serve *and* evaluate it. Relevant intents already live: `SMART_CONTRACT_AUDIT` (10),
  `TRANSACTION_RISK` (10), `WASH_TRADING_DETECTION` (11), `MALWARE_DETECTION` (11),
  `LIQUIDITY_DEPTH_VERIFY` (12).
- **01 Exchange** - "signed listing risk memo with costs" is nearly what Shield
  already emits. Needs `TOKEN_HOLDER_COUNT` (696 reqs), `FRAUD_DETECTION` (933),
  `SANCTIONS_SCREENING_MATCH` (13 miners), `SMART_CONTRACT_AUDIT`.
- **11 Autonomous Systems** - "verification before action" is Shield's literal
  thesis, but the buyer is robotics/hardware, which we have no access to.

## 6. Strategy

**Do not start from scratch.** 30 days. Season I took ~3 weeks just to get a miner
scoring above zero and an evaluator through the gauntlet, most of it spent
discovering what the docs got wrong. The rails - x402 in both directions verified
against the live facilitator, a registered scoring miner, a champion-grade WASM
evaluator, deployed infra - are the asset. They are a machine for shipping a
provider + evaluator + app triple on any intent, fast.

**Do not resubmit Shield as-is.** Zero external usage is the exact weakness Season II
is built to expose, and a polished Season I entry is the weakest read.

**Do: new product, same rails, usage as the primary metric.** Pick one mission.
Build the app that creates demand, and supply/evaluate the intents it needs.

Open questions to settle before 1 Nov:

1. Which mission - 14 or 01.
2. How we get real users. This is the binding constraint, not the code.
3. Whether to broaden the miner. Leaders serve 36-72 intents; we serve 2, and rank
   correlates with usage.
4. Whether to re-enter the evaluator. We have v12 built but never submitted
   (uncommitted in `scorer/`), and evaluators are a full track with less competition.

## 7. Registration copy submitted

See §8 for the exact text used on <https://hackathon.telegraphprotocol.com/>.

## 8. Re-run the measurements

```bash
# whole miner catalog (2.4 MB)
curl -s https://devnode.telegraphprotocol.com/api/miners -o /tmp/miners.json

# intents, miners per intent, demand per intent, our standing
node -e '
const m=JSON.parse(require("fs").readFileSync("/tmp/miners.json","utf8"))
  .filter(x=>(x.activation_status??"active")==="active");
const solo={},all={};
for(const x of m){const n=+(x.total_requests_served||0);const L=x.supported_intents||[];
  for(const i of L){all[i]=(all[i]||0)+n; if(L.length===1) solo[i]=(solo[i]||0)+n;}}
console.log("active",m.length,"served-any",m.filter(x=>+(x.total_requests_served||0)>0).length);
console.log(Object.entries(solo).sort((a,b)=>b[1]-a[1]).slice(0,15));
console.log(m.filter(x=>/truvian/i.test(JSON.stringify(x))).map(x=>({id:x.id,reqs:x.total_requests_served,scores:x.scores})));
'
```

Leaderboard JSON: <https://explorer.telegraphprotocol.com/api/leaderboard/miners>
(add `?intent=ONCHAIN_TX_LOOKUP` to filter). Season I's
`/api/leaderboard/miners` returned 0 rows on 2026-09-30 - standings look archived
between seasons; the per-miner `scores[]` in the catalog above is the live source.
