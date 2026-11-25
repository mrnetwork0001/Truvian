# Settlement assurance on Solana

Solana use case 1, *Institutional Transaction Intelligence & Settlement
Assurance*: before a custodian pays a counterparty in a token on Solana,
Truvian Shield decides **RELEASE**, **REVIEW** or **REJECT**. On RELEASE it
can send the payment on Solana devnet and checks on chain that the exact
amount arrived. Everything goes into one signed memo.

Run it: [`/preflight?desk=settlement`](https://truvian.xyz/preflight?desk=settlement) ·
code: [`src/shield/settlement.ts`](../src/shield/settlement.ts),
[`src/shield/solana.ts`](../src/shield/solana.ts)

## What is checked

| Check | Source | Rule |
|---|---|---|
| What the token's issuer can still do to the recipient's tokens | Solana mint account, read from `api.mainnet-beta.solana.com` and `solana-rpc.publicnode.com` (must agree) | non-transferable or paused: REJECT. Permanent delegate (can move or burn tokens out of any account), transfer hook, a non-zero transfer fee, or accounts frozen by default: REVIEW. Freeze authority, mint authority, confidential transfers: disclosed as info |
| Payer can cover the payment | Solana: the payer's accounts of the mint, listed on one provider and re-read by address on the other | short: REJECT; a frozen payer account: REJECT |
| Recipient | Solana | a frozen recipient account: REJECT; a program-derived address instead of a wallet: REVIEW |
| Counterparty on a sanctions list | Telegraph `SANCTIONS_SCREENING_MATCH_GENERAL`, paid, receipt | match: REJECT; fuzzy score ≥ 0.85 or no clear answer: REVIEW |
| Counterparty is a registered, active entity | Telegraph `CORPORATE_REGISTRY_LOOKUP_GENERAL`, paid, receipt. Truvian's adapter 242 is the champion evaluator for this intent | inactive: REJECT; a record for another entity, a registry in another country, or no answer: REVIEW |
| Payer balance, independently | Telegraph `WALLET_BALANCE_CHECK_GENERAL` | disagrees with the chain: REVIEW. No answer is noted but does not hold the payment: on 2026-11-25 no miner on the node answered Solana balances (five asked), so the funds check rests on the two-provider chain read |

An answer that is no evidence (no answer, no figure, about another entity) gets one second opinion from the next-best ranked miner, as on the other desks. Over budget or escrow too low: nothing is bought and the decision is REVIEW.

**Sending.** Only on RELEASE, only when asked (`execute: true`), only on devnet, only from Shield's own devnet wallet `A4X5JKBCLobAY5MeDXkwiRV5Hr7Uu4vUhzHQczwXMBnz`, at most 1 token. Shield waits for `finalized`, reads the transaction back and checks that the recipient's accounts of the mint gained exactly the amount. Otherwise the decision becomes REJECT.

## Evidence, 2026-11-25

| Memo | Counterparty | Token | Decision | Why | Cost |
|---|---|---|---|---|---|
| [`sEDw0qBk`](https://truvian.xyz/preflight?m=sEDw0qBk) | Coinbase Global, Inc. (US-DE) | tUSD | **RELEASE**, paid | sanctions clear (OpenSanctions US OFAC Index), registry active (Praman Desk), payer funded; 1 tUSD sent and verified at finalized: [Explorer](https://explorer.solana.com/tx/382vFshku8AJtsnPWiPHVbsmDu3DRqKqM9LMzVyGSuQXDsBTRHQ38PCgwfHixRhLw5o2H6Tj6fLipWcFwyF3Ukkg?cluster=devnet) | $0, reused within 10 min of the run below |
| (first run, not stored) | Coinbase Global, Inc. | tUSD | RELEASE, paid | same checks; tx [`2fWoSshh…`](https://explorer.solana.com/tx/2fWoSshhwL6PofbWjRGJq5Ggo2j2efeGxdrusqanWHyGDsa1BEbRHNo9dexa1wJiHpXM2eLQiL1zJeRq4pcyAQbB?cluster=devnet), slot 526130868 | $0.03 |
| [`Py5ehwTL`](https://truvian.xyz/preflight?m=Py5ehwTL) | Garantex Europe OU (Estonia) | tUSD | **REJECT**, not sent | matched `us_ofac_sdn`; registry shows it inactive | $0.04 |
| [`HB7ZGFGr`](https://truvian.xyz/preflight?m=HB7ZGFGr) | Coinbase Global, Inc. | rUSD | **REVIEW**, not sent | rUSD's issuer holds a permanent delegate: it can take the payment back out of the recipient's account | $0.04 |

The same check on Solana mainnet: PayPal USD (PYUSD, `2b1kV6…GXo`) is a Token-2022 mint with a permanent delegate, a transfer-fee authority and confidential transfers. An institution accepting a PYUSD settlement accepts that its issuer can move the tokens; Shield says so before the payment, instead of after.

## Test tokens (devnet)

Created by [`src/scripts/solana-devnet-fixtures.ts`](../src/scripts/solana-devnet-fixtures.ts) from Shield's devnet wallet:

- **tUSD** `DThEeRe6uhj2eT8SLrjiLexUiuxrggysA4zCuHE2sUFb`: plain SPL, 6 decimals, a stand-in for USDC while Circle's devnet faucet was rate-limited.
- **rUSD** `B6yxPoHwxdThmbJ9C58TXF2TK3JYzsC2R6ggFdUvAz1v`: Token-2022 with a permanent delegate.

Recipient in the fixtures: a fresh devnet wallet `Afb8MYs9G63oHAPkZiK6cb5JKzuWy9is3pHc6Zj5voYZ`.

## Who pays, and why

A custodian, an exchange's treasury desk or a payment processor releasing stablecoin payouts on Solana pays per decision (x402, $0.05 test USDC today). One signed memo replaces a manual sanctions check, a registry lookup and a token-terms review, and records the settlement itself, so the audit trail exists before the money moves.

## Reproduce

```bash
curl -s https://truvian.xyz/api/preflight -H 'content-type: application/json' -d '{
  "mode": "settlement", "network": "solana-devnet", "mint": "RUSD", "amount": "1",
  "recipient": "Afb8MYs9G63oHAPkZiK6cb5JKzuWy9is3pHc6Zj5voYZ",
  "counterparty": "Coinbase Global, Inc.", "jurisdiction": "US-DE", "execute": true
}' | jq '{decision: .memo.decision, findings: [.memo.findings[] | {severity, title}], sent: .memo.settlement.execution}'
```
