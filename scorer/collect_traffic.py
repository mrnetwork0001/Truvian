#!/usr/bin/env python3
"""Build scorer/traffic.tsv — a real-traffic corpus for ONCHAIN_TX_LOOKUP.

Answer styles mirror the live miner catalog, captured empirically on
2026-08-23 from the devnode's registered miners:

  prose-chainsight   one-sentence prose signal (chainsight-oracle /tx)
  prose-truvian      detailed prose (truvian-onchain-truth /tx; fetched live
                     with a 10s hard timeout, template fallback)
  json-verity        flat JSON blob, correct values (verity /v1/lookup)
  json-degenlens     flat JSON blob, correct values + reasoning field
  json-wrong-value   verity-style blob with a wrong block / corrupted value
  json-truncated     degenlens-style blob cut off mid-field
  prose-wrong-status truvian-style prose with the status flipped
  json-error         veyctum RPC_DISAGREEMENT error blob (observed verbatim)
  json-vulnfeed      off-topic contract-vulnerability report (vulnfeed)

The devnode's generic-protocol adapter scores the "signal"/"answer" prose
field when a response has one (that is why prose miners sit at 0.83+ on the
live leaderboard) and the raw JSON body otherwise (why verity/interlock/
vulnfeed sit near 0). The corpus reproduces exactly that node view.

Ground truths are prose derived from eth_getTransactionReceipt facts.

Usage: python3 collect_traffic.py <txfacts.json> <out.tsv> [--offline]
"""
import json
import sys
import urllib.request
import urllib.error

UA = {"User-Agent": "Mozilla/5.0"}
MAX_ANSWER = 4000


def http_get(url, timeout=10):
    req = urllib.request.Request(url, headers=UA)
    try:
        return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
    except Exception:
        return None


def clean(s):
    return " ".join(s.replace("\t", " ").replace("\r", " ").replace("\n", " ").split())[:MAX_ANSWER]


def eth(wei):
    return f"{wei / 1e18:.18f}".rstrip("0").rstrip(".") or "0"


def ground_truth(f):
    h, blk = f["hash"], f["block"]
    frm, to, ca = f["from"], f["to"], f["contractAddress"]
    val, gas, egp, fee, logs = (f["value_wei"], f["gas_used"],
                                f["effective_gas_price"], f["fee_wei"], f["n_logs"])
    if f["status"] == 0:
        core = (f"Transaction {h} on Base reverted in block {blk}. "
                f"It was sent from {frm} to {to} and failed")
    elif ca:
        core = (f"Transaction {h} on Base succeeded in block {blk}. It was a contract "
                f"creation from {frm}, deploying the new contract {ca}")
    else:
        core = (f"Transaction {h} on Base succeeded in block {blk}, from {frm} to {to}, "
                f"transferring {eth(val)} ETH ({val} wei)")
    return (f"{core}, with gas used {gas} at an effective gas price of {egp} wei, "
            f"total fee {fee} wei. It emitted {logs} logs.")


def corrupt_digits(s):
    """Deterministically corrupt the last digit of a digit string."""
    s = str(s)
    last = s[-1]
    return s[:-1] + ("0" if last != "0" else "1")


def styles(f, offline):
    h, blk = f["hash"], f["block"]
    frm, to, ca = f["from"], f["to"], f["contractAddress"]
    val, gas, egp, fee, logs = (f["value_wei"], f["gas_used"],
                                f["effective_gas_price"], f["fee_wei"], f["n_logs"])
    ok = f["status"] == 1
    to_disp = to or ca or "null"
    out = {}

    # --- prose-chainsight (observed template) ------------------------------
    if ok:
        out["prose-chainsight"] = (
            f"The transaction transferred {eth(val)} ETH from {frm} to the recipient "
            f"{to_disp} on Base, included in block {blk}.")
    else:
        out["prose-chainsight"] = (
            f"The transaction from {frm} to {to_disp} on Base failed (reverted) in block {blk}.")

    # --- prose-truvian (live, hard 10s timeout; template fallback) ---------
    live = None
    if not offline:
        raw = http_get(f"https://miner.truvian.xyz/tx?hash={h}&chain=base")
        if raw:
            try:
                obj = json.loads(raw)
                a = obj.get("answer") or obj.get("signal")
                if isinstance(a, str) and a.strip():
                    live = a
            except Exception:
                pass
    if live is None:
        status_word = "succeeded" if ok else "reverted"
        live = (f"Transaction {h} on Base (chain id 8453) {status_word} in block {blk}. "
                f"It transferred {eth(val)} ETH ({val} wei) from {frm} to the recipient "
                f"{to_disp}. Gas used was {gas} at an effective gas price of {egp} wei, "
                f"for a total fee of {fee} wei. The transaction emitted {logs} logs.")
    out["prose-truvian"] = live

    # --- json-verity (observed field layout, correct values) ---------------
    status = "confirmed_success" if ok else "confirmed_revert"
    out["json-verity"] = json.dumps({
        "chain": "base", "chain_id": 8453, "tx_hash": h, "status": status,
        "block_number": str(blk), "from": frm, "to": to, "value_wei": str(val),
        "confidence": 1, "canonical": f"base|{h}|{status}|{blk}|{frm}|{to}|{val}",
    }, separators=(",", ":"))

    # --- json-degenlens (observed field layout, correct values) ------------
    out["json-degenlens"] = json.dumps({
        "tx_hash": h, "chain": "base", "status": "confirmed" if ok else "failed",
        "block_number": blk, "from_address": frm, "to_address": to,
        "value_wei": str(val), "value_native": val / 1e18, "gas": gas,
        "gas_price_wei": str(egp), "input": "0x", "classification": "unattributed",
        "associations": [], "confidence": 1.0,
        "verdict": "confirmed" if ok else "failed",
        "reasoning": ("Transaction resolved by chain RPC and classified as "
                      "unattributed using 0 registry claim(s)."),
        "data_source": "live", "method": "direct_rpc_lookup",
    }, separators=(",", ":"))

    # --- json-wrong-value: verity-style with wrong block AND value ---------
    wrong_blk = str(blk + 1)
    wrong_val = corrupt_digits(val) if val > 0 else "1000000000000000"
    out["json-wrong-value"] = json.dumps({
        "chain": "base", "chain_id": 8453, "tx_hash": h, "status": status,
        "block_number": wrong_blk, "from": frm, "to": to, "value_wei": wrong_val,
        "confidence": 1, "canonical": f"base|{h}|{status}|{wrong_blk}|{frm}|{to}|{wrong_val}",
    }, separators=(",", ":"))

    # --- json-truncated: degenlens-style cut off mid-field ------------------
    out["json-truncated"] = out["json-degenlens"][:180]

    # --- prose-wrong-status: truvian-style prose, status flipped ------------
    flipped = "reverted" if ok else "succeeded"
    out["prose-wrong-status"] = (
        f"Transaction {h} on Base (chain id 8453) {flipped} in block {blk}. "
        f"It transferred {eth(val)} ETH ({val} wei) from {frm} to the recipient "
        f"{to_disp}. Gas used was {gas} at an effective gas price of {egp} wei, "
        f"for a total fee of {fee} wei.")

    # --- json-error: veyctum RPC_DISAGREEMENT blob (observed verbatim) ------
    out["json-error"] = json.dumps({
        "schema_version": "1.0.0", "chain_id": 8453, "tx_hash": h,
        "state": "RPC_DISAGREEMENT", "status": "error", "canonical": None,
        "finality": {"required_confirmations": 2, "confirmations": None, "reached": False},
        "effects": [], "evidence": {"block_number": None, "block_hash": None,
                                    "tx_from": None, "tx_to": None, "value_wei": None,
                                    "receipt_status": None, "provider": "n/a"},
        "error_code": "RPC_DISAGREEMENT",
        "error_detail": "only primary provider responded; independent agreement required",
    }, separators=(",", ":"))

    # --- json-vulnfeed: off-topic vulnerability report (observed shape) -----
    out["json-vulnfeed"] = json.dumps({
        "intent": "ONCHAIN_TX_LOOKUP", "address": to_disp, "risk_score": 0.0,
        "rating": "clean", "exploit_probability": 0.02,
        "severity_counts": {"high": 0, "medium": 0, "low": 0, "informational": 6},
        "summary": "No high/medium/low severity issues detected.",
        "findings": [{"title": "Assembly usage", "impact": "informational",
                      "confidence": "high",
                      "description": ("Address._functionCallWithValue(address,bytes,uint256,"
                                      "string) (@openzeppelin/contracts/utils/Address.sol"
                                      "#119-140) uses assembly - INLINE ASM"),
                      "file": "@openzeppelin/contracts/utils/Address.sol",
                      "line_start": 119},
                     {"title": "Incorrect versions of Solidity",
                      "impact": "informational", "confidence": "high",
                      "description": ("Version constraint ^0.6.2 contains known severe "
                                      "issues - MissingSideEffectsOnSelectorAccess, "
                                      "DirtyBytesArrayToStorage, KeccakCaching"),
                      "file": "contracts/FiatTokenProxy.sol", "line_start": 1}],
    }, separators=(",", ":"))

    return out


def main():
    facts = json.load(open(sys.argv[1]))
    offline = "--offline" in sys.argv
    rows = []
    for kind in sorted(facts):
        f = facts[kind]
        q = f"What are the details of transaction {f['hash']} on Base?"
        gt = ground_truth(f)
        for slug, ans in styles(f, offline).items():
            rows.append((kind, slug, q, clean(gt), clean(ans)))
            print(f"row  {kind}/{slug}: {len(ans)} chars", file=sys.stderr)
    with open(sys.argv[2], "w") as out:
        out.write("qid\tminer\tquestion\tground_truth\tminer_answer\n")
        for r in rows:
            out.write("\t".join(r) + "\n")
    print(f"wrote {len(rows)} rows to {sys.argv[2]}", file=sys.stderr)


if __name__ == "__main__":
    main()
