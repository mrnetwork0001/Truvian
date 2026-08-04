# 🛡️ Truvian — Verifiable Agentic Execution & Slippage Shield Engine

> **Telegraph Protocol Season I Hackathon Master Blueprint**  
> *Targeting Track 1 (Miner), Track 2 (Script Author), and Track 3 (Application)*  
> **Author:** `mrnetwork`  

---

## 📌 Executive Summary
Autonomous AI agents cannot execute transactions safely using unverified, raw API quotes. **Truvian** bridges this trust gap by acting as a **Verifiable Execution Oracle**. Before an agent signs any transaction, Truvian simulates execution, checks live order book depth, calculates maximum slippage bounds, and issues a signed verification payload.

---

## 🏗️ Tripartite Architecture & Hackathon Track Alignment

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         TRUVIAN TELEGRAPH ECOSYSTEM                      │
└──────────────────────────────────────────────────────────────────────────┘
                                      │
     TRACK 1: MINER                   ▼                    TRACK 2: SCRIPT
┌───────────────────────────┐    Queried by    ┌───────────────────────────┐
│  Truvian Miner API        │ ───────────────► │ On-Chain Settlement Eval  │
│  (Wraps DEX depth,        │                  │ (Parses RPC mined block   │
│   slippage & route risk)  │ ◄─────────────── │  logs vs predicted output)│
└─────────────┬─────────────┘                  └───────────────────────────┘
              │                                              ▲
              │ Issues Signed Verifications                  │ Evaluates
              ▼                                              │ Accuracy
┌────────────────────────────────────────────────────────────┴─────────────┐
│ TRACK 3: APPLICATION (Truvian Terminal & Autonomous Agent)                │
│ Live Next.js dashboard routing real-time transactions through Truvian,  │
│ driving massive verifiable request volume back to the Telegraph Miner.   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Core Components & Technical Specifications

### 1. Track 1: Truvian Miner (Supply Layer)
* **Endpoint:** `POST /telegraph/miner/verify-execution`
* **Input Schema:**
  ```json
  {
    "chain": "xlayer",
    "tokenIn": "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    "tokenOut": "0xE0B7A2bCF575CFBA10528C4E7C10BD3CE2D7769A",
    "amountIn": "100.0",
    "targetContract": "0x...",
    "slippageTolerance": 0.5
  }
  ```
* **Output Payload (Signed Signal):**
  ```json
  {
    "minerId": "truvian-miner-01",
    "timestamp": 1785800000,
    "guaranteedMinOutput": "99.82",
    "maxSlippagePercent": 0.18,
    "routeSafetyScore": 98,
    "executionValidityWindowSec": 30,
    "signature": "0x..."
  }
  ```

### 2. Track 2: On-Chain Settlement Evaluator (Quality Layer)
* **Methodology:** Listens for executed transaction hashes, fetches mined block receipts via RPC, parses actual `Transfer` / `Swap` event logs, and computes exact mathematical accuracy:
  $$\text{Accuracy Score} = 100 - \left| \frac{\text{Realized Output} - \text{Predicted Output}}{\text{Predicted Output}} \right| \times 100$$
* **Penalty:** Failed or reverted transactions score **0%**.

### 3. Track 3: Truvian Terminal (Demand Layer)
* **Features:**
  - **Live Verification Feed:** Real-time stream of incoming agent requests and verification scores.
  - **Interactive Trade Simulator:** Lets users or agents submit test payloads and visually inspect liquidity depth and slippage guarantees.
  - **On-Chain Accuracy Leaderboard:** Shows live accuracy scores verified by Track 2 scripts.

---

## ⏱️ 3-Phase Execution Plan

- **Phase 1 (Miner & Simulator Core):** Set up Node.js/TypeScript Telegraph Miner wrapper, DEX RPC simulation, and payload signing logic.
- **Phase 2 (Evaluation Script):** Build script to fetch mined transaction logs, compare against miner signatures, and compute ground-truth score.
- **Phase 3 (Next.js Dashboard & Demo Video):** Build premium dark-mode Next.js UI, connect live websocket feeds, record demo walkthrough, and post updates on X (`@TelegraphProto`).
