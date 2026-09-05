# Truvian Shield — Track 3 Runbook

Track 3 window: **Aug 31 → Sep 7** (deadline **2026-09-07T23:59:59Z**).
Hard rule: the app **must consume real live Telegraph miners** — mocked or
simulated data is grounds for disqualification. The Track 1 miner
(miner.truvian.xyz) must also stay live through Sep 7.

## What Shield is

An execution-safety checkpoint for agents. Before an agent signs a
transaction, it POSTs the intended action to Shield; Shield queries **live
Telegraph miners** and returns a go/no-go verdict with per-check evidence.

**Four live-miner checks** (all real Telegraph intents):

| Check | Intent | Params | Question it answers |
|---|---|---|---|
| Gas sanity | `GAS_PRICE` | `{chain}` | Is gas normal right now, or is the agent about to overpay? |
| Tx ground truth | `ONCHAIN_TX_LOOKUP` | `{chain, hash}` | Does the referenced tx actually say what the agent believes? |
| Asset sanity | `CRYPTO_PRICE` | `{symbol}` | Is the asset's price where the agent's plan assumes? |
| Protocol sanity | `TVL_LOOKUP` | `{protocol}` | Does the target protocol have real TVL, or is it a husk? |

Each check reports `pass | warn | fail | error`, the miner's answer, latency,
transport, and (when the engine returns one) a **signal hash** — verifiable by
anyone at `GET https://devnode.telegraphprotocol.com/engine/v1/signal/{hash}`.
The report rolls up to `SAFE | CAUTION | BLOCK` with a 0–100 score and reasons.

**Two transports** (`src/shield/telegraph.ts`, env `SHIELD_TRANSPORT`):

- **`x402`** (default when `TELEGRAPH_PAYER_KEY` is set): pays per query
  through the Telegraph node at `https://devnode.telegraphprotocol.com` —
  engine auto-ask `POST /engine/v1/ask`, direct ask
  `POST /engine/v1/ask/{minerId}`, dispatcher
  `POST|GET /miner-dispatcher/v1/{minerId}{path}`. Payment: USDC on Base
  Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), facilitator
  `https://facilitator.payai.network`.
- **`direct`** (dev/fallback): calls live miners' public `base_url`s from the
  FREE catalog `GET https://devnode.telegraphprotocol.com/api/miners`. Still
  real Telegraph miners — no mocks — and every check is labeled
  `transport: "direct"` so nothing masquerades as paid traffic.

**Server** (`src/shield/server.ts`, Fastify, PORT 8788):

| Route | Purpose |
|---|---|
| `POST /api/check` | body `{chain?, to?, valueEth?, txHash?, protocol?}` → CheckReport |
| `GET /api/verify/:txHash` | single ONCHAIN_TX_LOOKUP-based verification report |
| `GET /healthz` | `{ok:true}` |
| `GET /api/stats` | `{checksRun, telegraphRequests, byIntent}` (persisted best-effort to `.shield-stats.json`) |
| `GET /` | dashboard, static from `src/shield/public/` |

## Run locally

```bash
npm install
SHIELD_TRANSPORT=direct npx tsx src/shield/server.ts
# open http://localhost:8788

curl -s localhost:8788/healthz
curl -s -X POST localhost:8788/api/check \
  -H 'content-type: application/json' \
  -d '{"chain":"base","txHash":"0x<some-base-tx>","protocol":"aave","valueEth":"0.5"}'
```

## Deploy to the VPS (38.49.213.208, repo at /opt/truvian)

```bash
ssh <vps>
cd /opt/truvian
git pull
npm install                              # tsx runs TS directly; no build step
pm2 start deploy/ecosystem.shield.cjs    # app: truvian-shield on 127.0.0.1:8788
pm2 save

sudo cp deploy/nginx-shield.conf /etc/nginx/sites-available/truvian-shield.conf
sudo ln -s ../sites-available/truvian-shield.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

DNS + TLS:

1. A records: `truvian.xyz` → `38.49.213.208`, `www.truvian.xyz` → same.
2. Once resolving: `sudo certbot --nginx -d truvian.xyz -d www.truvian.xyz`.
3. If DNS lags, use the commented fallback block in `deploy/nginx-shield.conf`
   to serve Shield at `miner.truvian.xyz/shield/` temporarily (imperfect —
   see the caveat in that file).

Smoke test: `curl -s https://truvian.xyz/healthz` → `{"ok":true}`.

## Fund the x402 payer (flip from direct to paid)

1. **Fresh burner key** — never the miner registration wallet:
   ```bash
   npx tsx -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k = generatePrivateKey(); console.log(k, privateKeyToAccount(k).address)"
   ```
2. **Base Sepolia USDC**: Circle faucet **https://faucet.circle.com** →
   network Base Sepolia (token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
3. **Base Sepolia gas ETH**: a small amount from the Coinbase or Alchemy Base
   Sepolia faucet (same faucets used for miner registration — see
   `telegraph/REGISTRATION.md`).
4. **Set the key** on the VPS (never commit it):
   ```bash
   export TELEGRAPH_PAYER_KEY=0x…
   pm2 restart truvian-shield --update-env
   # or put it in /opt/truvian/.env (dotenv is a dependency), then pm2 restart
   ```
5. **Flip transport**: with the key set, `x402` is already the default —
   just make sure no stray `SHIELD_TRANSPORT=direct` remains (or set
   `SHIELD_TRANSPORT=x402` explicitly in the pm2 env).
6. **Verify**: run a check and confirm each entry reports
   `transport: "x402"` plus a `costUsd`, and that `signalHash` values resolve
   at `GET /engine/v1/signal/{hash}` on the devnode.

## Track 3 submission checklist

- [ ] Shield live at **https://truvian.xyz** and stable through Sep 7.
- [ ] Track 1 miner still live at miner.truvian.xyz (required alongside Track 3).
- [ ] `TELEGRAPH_PAYER_KEY` funded; production checks run over **x402**.
- [ ] Real-miner proof on hand: transport labels, `costUsd`, and signal hashes
      in every CheckReport (mocked data = disqualification).
- [ ] Submit at **submissions.telegraphprotocol.com** before
      2026-09-07T23:59:59Z, using the same X handle as the posts.
- [ ] X thread posted from `docs/x-track3-draft.md`, tagged **@Telegraphprotoc**
      (engagement is scored; the handle on the submission must match).
- [ ] Judging criteria covered: **users** and **usage** (`GET /api/stats` —
      checksRun / telegraphRequests / byIntent), **creativity** (execution-safety
      checkpoint with verifiable signal hashes), **must-use-real-miners**
      (x402 receipts + signal hashes), **engagement** (the thread).
- [ ] Bonus: Shield's traffic counts toward the ≥100-real-request /
      ≥3-active-miner eligibility bar for the intents it queries — real usage
      helps the whole intent pool, our Track 1 miner included.
