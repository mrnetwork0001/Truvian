# Truvian on Solana: demo film (60 s)

A one-minute film for X: a real Solana payment to a sanctioned exchange that Truvian refused, why the facts come from Telegraph miners, the miner answer Truvian caught against the chain, the settlement and resolution desks on the live site, the Solana anchor, and our miner (registration 6194) answering Solana on Telegraph.

Deliverables: `out/truvian-solana-4k.mp4`, `out/truvian-solana-1080p.mp4`, `out/truvian-solana-thumbnail.png`.

## What is real

- **Every figure** is read back by `scripts/data.mjs` into `data/onchain.json` (read 2026-11-25 20:59 UTC):
  - Settlement memo `rk43l_0A` (truvian.xyz/preflight?m=rk43l_0A), created 2026-11-25 17:08:10 UTC by a visitor using the desk's Garantex example: REJECT. Sanctions match on OFAC SDN and UN Consolidated (ChainSight, miner 302), registry inactive in Estonia (TxLens, miner 9002), and a balance answer of 855.24 from PREFLIGHT Infrastructure Signals (miner 20260828) against 998 tUSD on Solana devnet at slot 526,219,339, flagged `balance.conflict`. Three facts, $0.01 each, receipts shown are the memo's signal hashes. The payment was not sent.
  - Resolution `UnLKfa5v` (truvian.xyz/resolve?r=UnLKfa5v), Polymarket market 253591: RESOLVED YES from TxLens (rank 1), Takar Outcome Resolver (rank 14) and ZK Source-Checked Event Results (rank 35). Its sha256 is anchored on Solana devnet by SPL Memo in tx `2pjabbtR…1qGn`, slot 526,136,425, 11:36:04 UTC; `getTransaction` confirms the memo text equals `Truvian Resolve sha256:<digest>`.
  - Miner registration 6194: `updateMiner` tx `0xa4924481…01f8` on Ethereum Sepolia, block 12,209,795, 13:21:00 UTC, status 1, to the Telegraph Diamond `0x72a7…a08b`. Its Solana intents (balance, supply, transfer) are from `telegraph/truvian-miner.yaml` and `/docs/miner`.
  - "23 signed desk decisions" is `/api/stats` at the same read.
- **Footage:** recorded from https://truvian.xyz and Solana Explorer on 2026-11-25 ~21:05 UTC with `scripts/capture.mjs` (headless Chrome, 1600×900 at device scale 2). No writes: the one click is a desk example button, which only fills the form.
- **Logos:** Solana's mark (cryptologos.cc copy of the official mark), Polymarket's from its GitHub organisation, Anjoman's from anjoman.ai, Truvian's from the repo. Telegraph only publishes its Σ mark as a 41×48 PNG (`telegraphprotocol.com/t-logo.png`); `public/logos/telegraph-mark.svg` is a vector redraw of the same geometry, measured pixel by pixel, so it stays sharp in 4K.
- **Voice, music, sound:** ElevenLabs. Narrator: Daniel. Score: ElevenLabs Music. Effects: ElevenLabs sound generation.

## Build it

The ElevenLabs key is read at runtime from `~/.config/elevenlabs/.env` and never stored here.

```
npm install
npm run data                                       # figures from the API and chains
npm run vo && npm run music && npm run sfx && npm run timing
node scripts/capture.mjs && npm run encode         # live site footage
npm run draft                                      # half-scale check
npm run render4k && npm run finish && npm run 1080p
npm run poster
```
