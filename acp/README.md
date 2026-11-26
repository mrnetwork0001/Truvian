# Truvian on Virtuals ACP

Truvian runs one agent on the [Agent Commerce Protocol](https://app.virtuals.io/acp) with two jobs:

- **Seller of "Counterparty due diligence"**: a buyer names a counterparty, Truvian quotes, and once the job is funded it delivers a report: PROCEED, REVIEW or DECLINE. The report rests on a sanctions screening and a corporate registry record bought from Telegraph's ranked miners (each with an escrow receipt), plus wallet balances read from the chain. Every claim in the report is in a checkable format, and the signed memo is linked. When the job settles, the sale is booked in Truvian's ledger with its revenue, its Telegraph cost and its margin: `GET https://truvian.xyz/api/business`.
- **Independent evaluator**: when a job names Truvian's wallet as its evaluator, Truvian checks the delivery before the provider is paid. Each claim is bought fresh from Telegraph or read from the chain; the job's requirement says what had to be covered. The job is completed only when the work is ACCEPTED. It is rejected when a claim is contradicted, a required item is missing, or a claim cannot be verified, and the reason and the signed memo go on the job. Truvian never evaluates a job it is the provider of. A delivery written in prose is read into claims by the agent model first; the verdict still rests only on the evidence.

The desks themselves run on Shield (`src/shield/commerce/` in the repo root). This folder is only the ACP side, kept apart so the ACP SDK's dependencies stay out of the server.

## What is real, and what is a fixture

- The reports, verifications and memos are real runs: real Telegraph purchases (test USDC on Ethereum Sepolia in Season II) and real chain reads.
- Agents registered on app.virtuals.io run on **Base mainnet with real USDC** (`ACP_NETWORK=mainnet`); new agents start in Virtuals' sandbox, unlisted. `ACP_NETWORK=testnet` points at the SDK's dev server.
- The **demo provider** in `src/demo.ts` is a test fixture. It fetches a real report, then delivers it correct, with the sanctions claim flipped, or with the registry claim left out, and its delivery says which (`demoFixture: true`). Truvian's evaluator does not read that label.

## Set up (once)

1. On [app.virtuals.io](https://app.virtuals.io/acp/new), register three agents, each with its own wallet:
   - **Truvian**. Offering **`counterpartyDueDiligence`**, price 0.01 USDC (Virtuals recommends $0.01 while testing), requirement schema:
     ```json
     {"type":"object","required":["entity","jurisdiction"],"properties":{
       "entity":{"type":"string","description":"the counterparty's legal name"},
       "jurisdiction":{"type":"string","description":"where it is registered, country or ISO code"},
       "wallets":{"type":"array","maxItems":3,"items":{"type":"object","properties":{"chain":{"type":"string"},"address":{"type":"string"},"token":{"type":"string"}}}}}}
     ```
   - **Truvian Demo Buyer**. No offering needed.
   - **Truvian Demo Seller** (the demo provider; agent names are capped at 20 characters). Offering **`counterpartyDueDiligenceDemo`**, price 0.01 USDC, requirement schema as above plus `"mode":{"type":"string","enum":["correct","incorrect","incomplete"]}`.
2. On each agent's page, open **Signers**, click **+ Add Signer**, then **Copy Key**. Note the agent's wallet address and wallet id.
3. Put them in the repo's `.env`. They are never printed or committed:
   ```
   ACP_NETWORK=testnet
   ACP_TRUVIAN_WALLET_ADDRESS=0x...
   ACP_TRUVIAN_WALLET_ID=...
   ACP_TRUVIAN_SIGNER_KEY=...
   ACP_BUYER_WALLET_ADDRESS=0x...
   ACP_BUYER_WALLET_ID=...
   ACP_BUYER_SIGNER_KEY=...
   ACP_DEMO_PROVIDER_WALLET_ADDRESS=0x...
   ACP_DEMO_PROVIDER_WALLET_ID=...
   ACP_DEMO_PROVIDER_SIGNER_KEY=...
   ACP_BUILDER_CODE=bc-...        # optional
   ```
   `SHIELD_INTERNAL_KEY` is already in `.env`. The Shield server needs the same value.
4. Give the demo buyer some test USDC on Base Sepolia (0.15 covers the four demo jobs).

## Run

```bash
cd acp && npm install
npm run truvian                    # Truvian's agent; keep it running
npm run demo                       # in a second terminal: three evaluation jobs and one paid job
npm run demo -- --only=evaluation  # the three evaluation jobs only
```

`npm run demo` writes every job id, outcome, reason and memo to `runs/<time>.json`.

## Without ACP

`SHIELD_URL=http://127.0.0.1:8790 npx tsx src/rehearse.ts` runs the same three deliveries through the same evaluator code, with no wallets and no jobs. It shows what Truvian will decide; it is not an ACP run.

## Notes from the first run (26 Nov 2026)

- **Gas:** each agent wallet needs a little ETH on Base (0.0001 ETH covers many jobs); the first transactions were not sponsored.
- **Signer policy "Virtuals-only":** the wallet's one-time EIP-7702 upgrade, and some calls, need a manual approval; the SDK prints the approval link and waits up to 5 minutes.
- **Node 26:** its built-in fetch stalls while the SDK's event streams are open; `src/agent.ts` installs undici's dispatcher to avoid it.
- `npx tsx src/check.ts <ROLE>` checks an agent's login and offerings, and `npx tsx src/jobs.ts <ROLE>` lists its jobs. Both are read-only.

First paid job: ACP job 83055 on Base, Truvian Demo Buyer → Truvian, `counterpartyDueDiligence` on Coinbase, Inc. (US-DE), $0.01: PROCEED, memo [yFfiYka5](https://truvian.xyz/api/work/yFfiYka5), completed by the buyer after checking the memo's signature. Record: `runs/2026-11-26T13-41-24-989Z.json`.
