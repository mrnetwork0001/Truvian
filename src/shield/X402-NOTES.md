# x402 payment mechanics — Telegraph node (empirical notes)

Findings captured live on 2026-09-05 against `https://devnode.telegraphprotocol.com`,
cross-checked against the x402 v2 specification (`coinbase/x402` →
`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`,
`specs/schemes/exact/scheme_exact_evm.md`) and the client code in
`telegraphprotocol/telegraph-usecases` (`*/api/src/x402Fetch.ts`, which uses the
`@x402/fetch` npm client — Solana scheme only, so our EVM client is built from
the spec directly with viem; **no `@x402/*` dependency needed or added**).

## 1. The live 402 challenge (verified with curl)

Both paid surfaces answer identically when unpaid:

- `POST /engine/v1/ask` (LLM-routed auto-ask)
- `GET|POST /miner-dispatcher/v1/{minerId}{endpointPath}` (deterministic dispatch — what Shield uses)

Response: HTTP **402** with a **`payment-required`** header containing
base64-encoded JSON (`x402Version: 2`). Decoded challenge from the dispatcher:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "description": "Payment required for all subnet APIs. Price is the on-chain committed minPriceUsdc floor; YAML is informational only.",
    "mimeType": "application/json",
    "url": "https://devnode.telegraphprotocol.com/miner-dispatcher/v1/8453/tx?chain=base&hash=0x…"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    },
    { "scheme": "exact", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "…": "(Solana option — not used)" }
  ]
}
```

- Price is `10000` atomic USDC = **$0.01 per request** (the miner's on-chain
  `minPriceUsdc` floor; the same amount appears on every miner probed).
- `asset` is Circle USDC on **Base Sepolia (84532)**; `payTo` is the Telegraph
  Diamond contract. The JSON *body* of the 402 is a v1-style human summary —
  the header is authoritative.

## 2. Client protocol (x402 v2 over HTTP, exact/EVM scheme, EIP-3009)

Header summary (all base64-encoded JSON):

| Header              | Direction       | Content                                        |
| ------------------- | --------------- | ---------------------------------------------- |
| `PAYMENT-REQUIRED`  | server → client | `PaymentRequired` challenge (above)            |
| `PAYMENT-SIGNATURE` | client → server | `PaymentPayload` (signed authorization)        |
| `PAYMENT-RESPONSE`  | server → client | `SettlementResponse` (tx hash or errorReason)  |

The client never talks to the facilitator (`https://facilitator.payai.network`)
directly — the node does verification + settlement server-side and the
facilitator broadcasts `transferWithAuthorization`, paying the gas. **The payer
wallet therefore needs USDC only, no Base Sepolia ETH.**

Payment payload we send (built in `telegraph.ts` → `buildPaymentSignature`):

```json
{
  "x402Version": 2,
  "resource": { "…": "echoed verbatim from the challenge" },
  "accepted": { "…": "the chosen accepts[] entry, verbatim" },
  "payload": {
    "signature": "0x…65-byte EIP-712 signature…",
    "authorization": {
      "from": "<payer address>",
      "to": "<payTo from challenge>",
      "value": "<amount from challenge>",
      "validAfter": "<unix now - 600, as string>",
      "validBefore": "<unix now + maxTimeoutSeconds, as string>",
      "nonce": "0x<32 random bytes>"
    }
  }
}
```

EIP-712 signing (viem `account.signTypedData`, no RPC involved):

- domain: `{ name: extra.name ("USDC"), version: extra.version ("2"), chainId: 84532, verifyingContract: asset }`
- primaryType `TransferWithAuthorization`, fields
  `(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)` — EIP-3009.

## 3. What is verified vs. what awaits funding

**Verified live (no funded key needed):**

- The 402 challenge parses exactly as above on both engine and dispatcher.
- The server *reads* `PAYMENT-SIGNATURE`: garbage in that header flips the
  response from 402 "Payment required" to **400 `{"error":"Invalid payment"}`**.
- Full crypto round-trip with a throwaway unfunded key: the node/facilitator
  **verified our signature, recovered the correct payer address**, and rejected
  with 402 + `PAYMENT-RESPONSE`:

  ```json
  {"success":false,"errorReason":"invalid_exact_evm_insufficient_balance","payer":"0xd8D5…C14C","transaction":"","network":"eip155:84532"}
  ```

  `payer` matched our signing address exactly — signing, encoding and header
  transport are all correct; only the balance check failed. `askIntent` on the
  x402 transport surfaces this as
  `unavailable: … payment rejected: invalid_exact_evm_insufficient_balance`.

**Unverified until a funded key exists:**

- A settled 200 through the dispatcher (and the `PAYMENT-RESPONSE` settlement
  tx hash on success).
- The paid response body shape. The dispatcher OpenAPI (`/miner-dispatcher/openapi.json`,
  free) documents the **raw miner JSON** as the 200 body; the engine ask route
  may instead wrap it in the `{miner_id, miner_name, result, cost_usd,
  signal_hash, …}` envelope. `parseAnswerBody` in `telegraph.ts` handles both,
  and also looks for `signal-hash` / `x-signal-hash` response headers — confirm
  which fields actually arrive once funded, especially where `signal_hash`
  lives on dispatcher responses.

## 4. Environment needed to go live

| Variable                 | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `TELEGRAPH_PAYER_KEY`    | 0x-prefixed EVM private key. Fund its address with **Base Sepolia USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — Circle faucet: <https://faucet.circle.com> (select Base Sepolia). No ETH needed. $0.01/request → $1 of USDC ≈ 100 requests. |
| `SHIELD_TRANSPORT`       | `x402` \| `direct`. Default: `x402` when `TELEGRAPH_PAYER_KEY` is set, else `direct`.                |
| `SHIELD_MAX_PAYMENT_USDC`| Per-request price cap in USD (default `0.10`). A challenge above the cap is refused, never signed.   |
| `TELEGRAPH_NODE_URL`     | Node override (default `https://devnode.telegraphprotocol.com`).                                     |

First funded test (expected to 200 and settle):

```bash
SHIELD_TRANSPORT=x402 TELEGRAPH_PAYER_KEY=0x… npx tsx -e "…askIntent('GAS_PRICE',{chain:'base'})…"
```

Then check the settlement tx (in `raw._x402Settlement.transaction`) on
<https://sepolia.basescan.org> and the signal via
`GET /engine/v1/signal/{hash}` if a `signal_hash` is returned.
