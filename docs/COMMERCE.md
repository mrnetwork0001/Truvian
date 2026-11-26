# Truvian for commercial agents

Four of Telegraph's commercial use cases run on the same engine: buy each fact from Telegraph's ranked miners with a receipt, read the chain where the fact is on-chain, decide under fixed rules, and sign the memo. Every memo below is live on truvian.xyz and verifiable with `POST /api/memo/verify`.

| Use case | What runs | Endpoint |
|---|---|---|
| Tencent: Enterprise Decision Assurance | An agent reads a decision brief, investigates the counterparty, follows up on missing or conflicting information, and writes the case. The rules decide. | `POST /api/investigate` |
| Tencent: Independent Enterprise Agent Verification | Any agent's deliverable is reduced to claims; each is checked against fresh evidence. ACCEPTED, REJECTED, INCOMPLETE or REVIEW. | `POST /api/verify-work` |
| Virtuals: Independent Agent Commerce Evaluation | The same verifier as the evaluator of ACP jobs: it completes or rejects the job on chain. | `acp/` (`npm run truvian`) |
| Virtuals: Autonomous Intelligence Businesses | Truvian sells counterparty due diligence on ACP and over x402, and keeps books: revenue, Telegraph cost and margin per job. | `POST /api/diligence`, `GET /api/business`, `acp/` |

## What is real, and what is not yet

- **Real:** every Telegraph answer (routed asks paid from Truvian's escrow, each with a receipt and a signal hash), every chain read, and every verdict, recommendation and signed memo listed here.
- **Testnet:** Telegraph Season II settles in test USDC on Ethereum Sepolia. x402 payments settle on Base Sepolia.
- **Mainnet:** the ACP jobs below ran on Base with real USDC ($0.01 each), through agents registered on app.virtuals.io (still in Virtuals' unlisted sandbox stage).
- **Test inputs:** the deliverables in the verification cases were written for the run, and their task text says so. The exception is the USDC supply figure, a real answer gemini-3.1-pro-preview gave on 23 Nov. The decision briefs are written for the demo.
- **Demo fixtures:** the Truvian Demo Buyer and Truvian Demo Seller are Truvian's own test agents. The seller delivers the same real report correct, with the sanctions claim flipped, or with the registry claim left out, and says so in its delivery (`demoFixture: true`); Truvian's evaluator does not read that label. The agent model is Hunyuan when `HUNYUAN_API_KEY`, `HUNYUAN_BASE_URL` and `HUNYUAN_MODEL` are set; until then the fallback model is used and each memo names the model that ran (`llm.provider`, `llm.model`).

## Enterprise Decision Assurance (Tencent)

The agent model reads the brief into a subject (who, where, which wallets). Truvian buys the sanctions screening and the registry record on Telegraph. When the registry has no usable record, or a record from another country, the agent proposes the company's full legal name or registering state, and Truvian buys that lookup and screens the full name for sanctions. A record found under a name the agent proposed always needs a person to confirm the identity: the agent can add evidence but never clear a counterparty on an identity it inferred. The rules decide; the agent then writes the case and cites each finding by rule id.

| Brief | Decision | What decided it | Cost | Memo |
|---|---|---|---|---|
| Approve a USD 250,000 prepayment to Garantex Europe OU (Estonia) | **DECLINE** | OFAC SDN and UN match; inactive in the Estonian registry. The brief called it "fully licensed". | $0.02, 2 answers | [wBBu-3JD](https://truvian.xyz/api/work/wBBu-3JD) |
| Sign a 3-year custody contract with Coinbase (Delaware) | **PROCEED** | Active registry record, no sanctions match | $0.02, 2 answers | [v5E-414S](https://truvian.xyz/api/work/v5E-414S) |
| Open a settlement account with "Circle" (United States) | **REVIEW** | The registry's record for "Circle" was French. The agent followed up with "Circle Internet Financial, LLC" (Delaware), found it active, screened that name too, and left the identity for a person to confirm. | $0.04, 4 answers | [QtaNDFfX](https://truvian.xyz/api/work/QtaNDFfX) |

Agent model: `openai-compatible/gpt-6.1-sol` (the Hunyuan slot is wired and waiting for its key), about 700 to 1,300 tokens per investigation.

## Independent Enterprise Agent Verification (Tencent)

Run with `SHIELD_URL=https://truvian.xyz npx tsx src/scripts/commerce-cases.ts`; the record is [docs/commerce/verification-cases-2026-11-26.json](commerce/verification-cases-2026-11-26.json).

| Task | Deliverable | Verdict | Why | Memo |
|---|---|---|---|---|
| Vendor onboarding | Prose: "not sanctioned ... active and in good standing" | **REJECTED** | Both claims contradicted: OFAC SDN match, inactive registry record. The claims were extracted from the prose by the agent model. | [q6yjaOmw](https://truvian.xyz/api/work/q6yjaOmw) |
| Market research | Gemini's USDC supply, 33,246,830,704 | **REJECTED** | The chain shows 44,817,776,470.35; the Telegraph miner's cross-check agreed with the chain to 0.00 bps. | [4SpzhW8i](https://truvian.xyz/api/work/4SpzhW8i) |
| Treasury proof | ENS DAO timelock holds 2,435,008.157713 USDC | **ACCEPTED** | balanceOf at the run's block; the Telegraph miner agreed to 0.00 bps. | [VZMB3YqE](https://truvian.xyz/api/work/VZMB3YqE) |
| Supplier KYB | Sanctions only, the registry check skipped | **INCOMPLETE** | The one claim is confirmed, but the required registry record is not covered. | [jxbqkb4Q](https://truvian.xyz/api/work/jxbqkb4Q) |

Total Telegraph cost for the four: $0.05. Each fact is bought fresh for the verification, never reused from the work being checked.

**The rules.** REJECTED if any claim is contradicted. Otherwise INCOMPLETE if a required item is not covered or a claim is malformed. Otherwise REVIEW if any claim could not be verified. ACCEPTED only when every required item is covered and every claim is confirmed. On-chain claims are decided by the chain read (balances within 50 bps, supplies within 10 bps); the Telegraph answer is a cross-check, and a miner that disagrees is recorded as wrong. Sanctions and registry claims are decided by the Telegraph answer, with a second opinion from the next-ranked miner when the first is no evidence.

## Agent Commerce on Virtuals ACP

`acp/` runs one Truvian agent that sells `counterpartyDueDiligence` and evaluates other agents' jobs. Four ACP jobs ran on Base mainnet on 26 Nov 2026, each paid $0.01 in USDC:

| ACP job | What happened | Truvian's verdict | Memo |
|---|---|---|---|
| 83055 | Demo Buyer bought Truvian's due diligence on Coinbase, Inc. (US-DE); the buyer checked the memo's signature and completed the job | PROCEED (not sanctioned, active Delaware registration) | [yFfiYka5](https://truvian.xyz/api/work/yFfiYka5) |
| 83057 | Demo Seller delivered a correct report, Truvian evaluating | ACCEPTED, job completed | [Hehi_9kr](https://truvian.xyz/api/work/Hehi_9kr) |
| 83058 | Demo Seller delivered the sanctions claim flipped to "not listed" | REJECTED (contradicted by fresh evidence), job rejected | [pqnUapI_](https://truvian.xyz/api/work/pqnUapI_) |
| 83059 | Demo Seller left out the registry claim | INCOMPLETE (required item missing), job rejected | [DpzCNrrm](https://truvian.xyz/api/work/DpzCNrrm) |

Records: [acp/runs/2026-11-26T13-41-24-989Z.json](../acp/runs/2026-11-26T13-41-24-989Z.json) and [acp/runs/2026-11-26T15-47-40-998Z.json](../acp/runs/2026-11-26T15-47-40-998Z.json). Telegraph cost per evaluation: $0.01 to $0.02.

## The business

`GET https://truvian.xyz/api/business` returns the books: jobs, revenue, Telegraph cost, margin, by channel (free, x402, ACP) and by product. A due diligence report costs Truvian $0.02 to $0.05 in Telegraph answers (two answers, plus one per wallet checked) and sells for $0.05 over x402 or $0.10 on ACP. Free runs are booked at a price of 0, so the books show what they cost. Truvian's own test runs go through an internal key and are not booked as sales.

## Run it

```bash
npm run test:commerce                       # the rules, over live answers from memo rk43l_0A
COMMERCE_LIVE=1 npm run test:commerce       # a real report, then honest, flipped and partial deliveries (about $0.07)
npx tsx src/scripts/commerce-run.ts investigate "<decision brief>"
curl -X POST https://truvian.xyz/api/diligence -H 'content-type: application/json' \
  -d '{"entity":"Garantex Europe OU","jurisdiction":"Estonia"}'
```
