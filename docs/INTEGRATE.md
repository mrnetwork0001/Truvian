# Use Truvian from your agent

Three ways in, from quickest to deepest. Each takes a few minutes and needs
no account, no key and no SDK. If you try one, tell us what broke or what
was missing: open an issue on this repository or reply on
[bounties#202](https://github.com/telegraphprotocol/bounties/issues/202).

## 1. Ask Shield before your agent trades (2 minutes)

Shield answers "may my agent buy $1,000 of this token through this pool?"
with `HOLD`, `REVIEW` or `REJECT`. It reads the token from the chain itself,
buys four facts from Telegraph miners ($0.01 each: security review, total
supply, wash trading, pool depth), checks them against its own reading, and
returns a memo it has signed.

```bash
curl -s https://truvian.xyz/api/preflight \
  -H 'content-type: application/json' \
  -d '{"mode":"trade","chain":"ethereum",
       "token":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
       "pool":"0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
       "tradeUsd":1000}'
```

- The reply holds `memo.decision`, the `memo.findings` behind it, every
  purchase with its payment receipt (`memo.purchases`), what it cost
  (`memo.cost`), and a link such as `https://truvian.xyz/preflight?m=<id>`.
- It takes 30 to 60 seconds. Add `?stream=1` to receive each step as a line of
  JSON while it runs.
- A listing review is the same call with `"mode":"listing"`, the issuer's
  legal name in `"issuer"` and, optionally, its treasury wallet in
  `"treasury"`.
- Each IP address gets 5 free runs a day (reset at 00:00 UTC). Beyond that the
  endpoint answers HTTP 402 with an x402 payment request (test USDC on Base
  Sepolia) that your agent can pay to run it at once.

**Gate your agent on it.** Act only on `HOLD`; send `REVIEW` to a human. A
missing fact is never read as safe.

```js
const r = await fetch('https://truvian.xyz/api/preflight', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'trade', chain: 'ethereum', token, pool, tradeUsd: 1000 }),
}).then((res) => res.json());
if (r.memo?.decision !== 'HOLD') throw new Error(`Shield: ${r.memo?.decision ?? r.error}, see https://truvian.xyz${r.url ?? ''}`);
```

## 2. Check a memo without trusting us (1 minute)

Every memo is signed with EIP-191 by `0x956aECB0b0DEfC2f2631C26ec0FF7366Ebb53245`.
Fetch one and check the signature yourself:

```bash
curl -s https://truvian.xyz/api/memo/B4k2AxbY > memo.json
cast wallet verify --address 0x956aECB0b0DEfC2f2631C26ec0FF7366Ebb53245 \
  "$(jq -r .message memo.json)" "$(jq -r .signature memo.json)"
# Validation succeeded. Address 0x956a…3245 signed this message.
```

`POST https://truvian.xyz/api/memo/verify` with `{"memo": …, "signature": …}`
also recomputes the memo's SHA-256 and recovers the signer, free.

## 3. Call the miner directly (free, any chain it serves)

`https://miner.truvian.xyz` answers six Telegraph intents. Every answer leads
with an `answer` sentence, carries the intent's fields by name, and is read
live from public JSON-RPC at one block.

| What you need | Call |
|---|---|
| Did a transfer settle, and what did it cost? | `/transfer?tx_hash=0x…&chain=base` |
| A DEX pool's liquidity in USD | `/liquidity?pool=0x…&chain=ethereum` (or `pool=WETH%20/%20USDC%200.05%25`) |
| An ERC-20's total supply | `/total-supply?token=USDC%20on%20Ethereum` |
| A wallet's balance of a coin or token | `/balance?address=vitalik.eth&chain=ethereum&token=USDC` |
| A transaction's status, block, sender and value | `/tx?tx_hash=0x…` (every chain is searched when none is given) |
| The gas price, anchored to a block | `/gas?chain=base` |

```bash
curl -s 'https://miner.truvian.xyz/liquidity?pool=0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640&chain=ethereum' | jq '{liquidity_usd, answer}'
```

Chains: Ethereum, Base, Arbitrum One, OP Mainnet, Polygon, BNB Smart Chain,
Avalanche, Scroll, Linea, Gnosis, ZKsync Era, X Layer, Ethereum Sepolia and
Base Sepolia (`/liquidity` serves the first eleven).

Through Telegraph, the same answers are bought by intent (for example
`TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL`) with the node ranking competing miners;
see Anjoman's docs at <https://anjoman.ai/docs>.

## Run it yourself

```bash
git clone https://github.com/mrnetwork0001/Truvian && cd Truvian && npm install
npm run dev            # the miner on :8787
npm run test:miner     # 273 live checks against the chains
```

Shield needs a Telegraph API key in `.env` to buy facts; the miner needs
nothing.
