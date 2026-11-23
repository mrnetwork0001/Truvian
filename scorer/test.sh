#!/usr/bin/env bash
# Truvian ONCHAIN_TX_LOOKUP scoring module — acceptance test suite.
# Drives the OFFICIAL Telegraph go-tester (wazero), exactly how validators run
# the module. Exits non-zero if any assertion fails.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM="$SCRIPT_DIR/target/wasm32-unknown-unknown/release/truvian_scorer.wasm"
TESTER_DIR="$SCRIPT_DIR/vendor/telegraph-examples/wasm-scoring-module/go-tester"
TESTER="$TESTER_DIR/tester"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

# --- Build the module and the official tester -------------------------------
echo "== building wasm module =="
(cd "$SCRIPT_DIR" && cargo build --release --target wasm32-unknown-unknown) || exit 1
[ -f "$WASM" ] || { echo "FATAL: wasm not found at $WASM"; exit 1; }

if [ ! -x "$TESTER" ]; then
  echo "== building official go-tester =="
  (cd "$TESTER_DIR" && go build -o tester .) || exit 1
fi

PASS=0
FAIL=0

# run <question> <ground_truth> <miner_answer> -> prints score to stdout
run() {
  local out
  out="$("$TESTER" "$WASM" "$1" "$2" "$3" 2>&1)" || { echo "TRAP"; return; }
  echo "$out" | awk '/^score:/{print $2}'
}

check() { # check <name> <score> <awk-condition using s>
  local name="$1" s="$2" cond="$3"
  if [ "$s" = "TRAP" ]; then
    echo "FAIL  $name  (module trapped)"; FAIL=$((FAIL+1)); return
  fi
  if awk -v s="$s" "BEGIN{exit !($cond)}"; then
    echo "PASS  $name  score=$s  ($cond)"; PASS=$((PASS+1))
  else
    echo "FAIL  $name  score=$s  (wanted: $cond)"; FAIL=$((FAIL+1))
  fi
}

# --- Fixtures: realistic ONCHAIN_TX_LOOKUP pair (modeled on real Base data) --
Q="What are the details of transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base?"
GT="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1, value 0 ETH, gas used 171101, total fee 9398486826272 wei."

REWORDED="The tx 0xE5CF8EA2682A3A49C02C2CCAF55D1BBAC1975AB23B9BF30A0A4321C8713E9668 was mined successfully on Base at block height 50,343,626. Sender: 0x76f68adf3d4ecfdd0725b1320fb25b6772754ae2, recipient: 0xecec48ec5a7b7f7b96460b0f4e2b99cf0db94cb1. It transferred 0 ETH, consumed 171101 gas, and cost 9398486826272 wei in fees."
CLEAN="Answer: Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1, value 0 ETH, gas used 171101, total fee 9398486826272 wei."
WRONG_STATUS="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base reverted in block 50343626, from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1, value 0 ETH, gas used 171101, total fee 9398486826272 wei."
WRONG_NUMBER="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343627, from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1, value 0 ETH, gas used 171101, total fee 9398486826272 wei."
WRONG_WEI="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1, value 0 ETH, gas used 171101, total fee 9398486826273 wei."
UNRELATED="The capital of France is Paris, a lovely city famous for croissants, museums and pleasant spring weather."

# value-dump gaming answer: correct facts + 30 deterministic extra hex values
DUMP="$GT Also possibly relevant:"
i=1
while [ $i -le 30 ]; do
  DUMP="$DUMP $(printf '0x%040d' "$i")"
  i=$((i+1))
done

# 50KB answer
BIG=""
b="lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
while [ ${#BIG} -lt 51200 ]; do BIG="$BIG$b"; done

EMOJI="🚀🌕 交易成功 ✅ 但是这个回答和问题无关 🤖 emoji stress test ラーメン 한국어"
ZH_GT="交易 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 在 Base 链上成功，区块 50343626，手续费 9398486826272 wei。"
ZH_REWORD="该笔交易 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 于区块 50343626 成功上链，费用为 9398486826272 wei"

echo
echo "== running cases =="

s_self=$(run "$Q" "$GT" "$GT")
check "self-match (gt == answer)"            "$s_self"        "s >= 0.99"

s_empty=$(run "$Q" "$GT" "")
check "empty answer == 0"                    "$s_empty"       "s == 0.0"

s_ws=$(run "$Q" "$GT" "
	  ")
check "whitespace answer == 0"               "$s_ws"          "s == 0.0"

s_unrel=$(run "$Q" "$GT" "$UNRELATED")
check "unrelated near 0"                     "$s_unrel"       "s < 0.15"
check "unrelated < self-match"               "$s_unrel"       "s < $s_self"

s_reword=$(run "$Q" "$GT" "$REWORDED")
check "reworded-correct high"                "$s_reword"      "s >= 0.6"

s_clean=$(run "$Q" "$GT" "$CLEAN")
check "clean-correct high"                   "$s_clean"       "s >= 0.8"

s_wstatus=$(run "$Q" "$GT" "$WRONG_STATUS")
check "wrong status < reworded-correct"      "$s_wstatus"     "s <= $s_reword - 0.05"

s_wnum=$(run "$Q" "$GT" "$WRONG_NUMBER")
check "wrong block number < exact"           "$s_wnum"        "s <= $s_self - 0.03"

s_wwei=$(run "$Q" "$GT" "$WRONG_WEI")
check "wrong wei value < exact"              "$s_wwei"        "s <= $s_self - 0.05"

s_dump=$(run "$Q" "$GT" "$DUMP")
check "value-dump < clean correct"           "$s_dump"        "s < $s_clean"
check "value-dump < reworded correct"        "$s_dump"        "s < $s_reword"

s_big=$(run "$Q" "$GT" "$BIG")
check "50KB answer returns number in [0,1]"  "$s_big"         "s >= 0.0 && s <= 1.0"

s_emoji=$(run "$Q" "$GT" "$EMOJI")
check "emoji answer no trap, in [0,1]"       "$s_emoji"       "s >= 0.0 && s <= 1.0"

s_zh_self=$(run "$Q" "$ZH_GT" "$ZH_GT")
check "Chinese self-match == 1"              "$s_zh_self"     "s >= 0.99"

s_zh_re=$(run "$Q" "$ZH_GT" "$ZH_REWORD")
check "Chinese reworded-correct high"        "$s_zh_re"       "s >= 0.6"

s_zh_bad=$(run "$Q" "$ZH_GT" "$EMOJI")
check "Chinese gt vs emoji junk low"         "$s_zh_bad"      "s < $s_zh_re"

# --- v2 regression cases: negation, yes/no, near-miss, question handling ----

# Negation trap: right numbers wrapped in a negated conclusion must score low.
NEG_TRAP="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 did not succeed and was never included in block 50343626; the transfer from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1 failed."
s_negtrap=$(run "$Q" "$GT" "$NEG_TRAP")
check "negation trap well below reworded"     "$s_negtrap"    "s <= $s_reword - 0.3"
check "negation trap low"                     "$s_negtrap"    "s < 0.2"

# Yes/No contradiction: gt answers Yes, miner answers No with same facts.
YN_Q="Did transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 succeed?"
YN_GT="Yes, it succeeded in block 50343626."
s_yn_good=$(run "$YN_Q" "$YN_GT" "Yes — confirmed at block 50343626.")
s_yn_bad=$(run "$YN_Q" "$YN_GT" "No, it did not succeed; it was dropped before block 50343626.")
check "yes/no good answer high"               "$s_yn_good"    "s >= 0.6"
check "yes/no contradiction crushed"          "$s_yn_bad"     "s < $s_yn_good - 0.3"

# Terse correct answer that does not echo the asked-about hash still ranks
# above a wrong-status answer.
s_terse=$(run "$Q" "$GT" "It succeeded at block 50343626 with 171101 gas, total fee 9398486826272 wei.")
# (Omits both addresses and the value — a partial answer. Since v5 the final
# score passes a step-band transform: partial answers land in the compressed
# low band, so the guards are ordering-only — above wrong-status and above
# zero — not absolute levels.)
check "terse correct in scored range"         "$s_terse"      "s > 0.005"
check "terse correct > wrong status"          "$s_terse"      "s > $s_wstatus"

# --- v3 regression cases: structured-blob handling --------------------------

# A raw JSON blob with fully correct values: real miners do this (verity,
# degenlens). It must land in the mid band — below every correct prose answer
# (champion agreement + the network's revealed preference) but above errors.
JSON_OK='{"chain":"base","chain_id":8453,"tx_hash":"0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668","status":"confirmed_success","block_number":"50343626","from":"0x76f68adf3d4ecfdd0725b1320fb25b6772754ae2","to":"0xecec48ec5a7b7f7b96460b0f4e2b99cf0db94cb1","value_wei":"0","gas_used":171101,"fee_wei":"9398486826272","confidence":1}'
s_json_ok=$(run "$Q" "$GT" "$JSON_OK")
check "correct JSON blob below clean prose"   "$s_json_ok"    "s < $s_clean - 0.3"
check "correct JSON blob below reworded"      "$s_json_ok"    "s < $s_reword - 0.3"
check "correct JSON blob above floor"         "$s_json_ok"    "s >= 0.01"

# A JSON error blob (real veyctum shape) must score near zero.
JSON_ERR='{"schema_version":"1.0.0","chain_id":8453,"state":"RPC_DISAGREEMENT","status":"error","canonical":null,"effects":[],"error_code":"RPC_DISAGREEMENT","error_detail":"only primary provider responded; independent agreement required"}'
s_json_err=$(run "$Q" "$GT" "$JSON_ERR")
check "JSON error blob near 0"                "$s_json_err"   "s < 0.1"
check "JSON error blob < correct JSON blob"   "$s_json_err"   "s < $s_json_ok"

# When the ground truth itself is structured, the blob penalty neutralizes:
# a near-identical JSON answer must still score high.
GT_JSON='{"tx":"0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668","status":"success","block":50343626,"fee_wei":"9398486826272"}'
MA_JSON='{"tx":"0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668","status":"success","block":50343626,"fee_wei":"9398486826272","source":"rpc"}'
s_jsongt=$(run "$Q" "$GT_JSON" "$MA_JSON")
check "JSON gt neutralizes blob penalty"      "$s_jsongt"     "s >= 0.6"

# --- v7 regression cases: semantic fusion ------------------------------------

# Distant-but-correct paraphrase (near-zero token overlap). v9 dropped the
# MiniLM channel for latency, so this class is no longer LIFTED into the high
# band — the honest requirement is that it still ORDERS above a same-topic
# wrong answer, which the fact/contradiction machinery must deliver on its own.
DIST_GT="A blockchain is a distributed ledger maintained by a network of nodes without a central authority."
s_dist_good=$(run "What is a blockchain?" "$DIST_GT" "Blockchains are decentralized ledgers kept in sync by many independent nodes rather than one central party.")
s_dist_bad=$(run "What is a blockchain?" "$DIST_GT" "A blockchain is a centralized database controlled by a single administrator.")
check "distant paraphrase good > wrong"       "$s_dist_good"  "s > $s_dist_bad"
check "distant topic-match wrong stays low"   "$s_dist_bad"   "s < 0.15"

# Wrong-value answer with near-perfect semantic topicality stays low.
POP_GT="Tokyo has a population of about 14 million people."
s_pop_good=$(run "What is the population of Tokyo?" "$POP_GT" "Around 14 million people live in Tokyo.")
s_pop_bad=$(run "What is the population of Tokyo?" "$POP_GT" "Tokyo has a population of about 4 million people.")
check "population paraphrase good high"       "$s_pop_good"   "s >= 0.6"
check "wrong population not rescued by sem"   "$s_pop_bad"    "s < 0.5"
check "wrong population < good"               "$s_pop_bad"    "s < $s_pop_good - 0.3"

# --- v8 SUBSTITUTION block: wrong values are false claims, not omissions ----
# Realistic data: 66-char tx hash, 42-char addresses. Every substitution must
# land under 0.15 AND below both the verbatim good and a terse-correct answer.
SQ="What are the details of transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base?"
SGT="Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, transferring 5 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
s_sub_verb=$(run "$SQ" "$SGT" "$SGT")
s_sub_terse=$(run "$SQ" "$SGT" "It succeeded in block 50343626, transferring 5 ETH.")
check "substitution-gt verbatim == 1"         "$s_sub_verb"   "s >= 0.99"
check "terse-correct (omission only) high"    "$s_sub_terse"  "s >= 0.6"

sub_check() { # sub_check <name> <answer>
  local sc; sc=$(run "$SQ" "$SGT" "$2")
  check "SUB $1 < 0.15"                       "$sc"           "s < 0.15"
  check "SUB $1 < verbatim"                   "$sc"           "s < $s_sub_verb"
  check "SUB $1 < terse-correct"              "$sc"           "s < $s_sub_terse"
}
sub_check "wrong amount"   "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, transferring 9 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
sub_check "wrong to-addr"  "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, transferring 5 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xdEAD000000000000000042069420694206942069."
sub_check "wrong from-addr" "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, transferring 5 ETH from 0xdEAD000000000000000042069420694206942069 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
sub_check "wrong tx hash"  "Transaction 0xabcd1234682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343626, transferring 5 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
sub_check "wrong block"    "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343627, transferring 5 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
sub_check "wrong chain"    "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Arbitrum succeeded in block 50343626, transferring 5 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."
sub_check "two facts wrong" "Transaction 0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668 on Base succeeded in block 50343699, transferring 9 ETH from 0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2 to 0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1."

# Gas-price-style ground truth: wrong gwei value is the same class of error.
GQ="What is the current gas price on Ethereum?"
GGT="The current gas price on Ethereum is 32 gwei (32000000000 wei), with a base fee of 30 gwei."
s_gas_good=$(run "$GQ" "$GGT" "Gas is currently about 32 gwei on Ethereum (32000000000 wei), base fee 30 gwei.")
s_gas_bad=$(run "$GQ" "$GGT" "The current gas price on Ethereum is 85 gwei (85000000000 wei), with a base fee of 81 gwei.")
check "gas-price good high"                   "$s_gas_good"   "s >= 0.6"
check "SUB wrong gwei < 0.15"                 "$s_gas_bad"    "s < 0.15"
check "SUB wrong gwei < good"                 "$s_gas_bad"    "s < $s_gas_good"

# --- v10 regression block: substitution veto must respect SLOT CONTEXT -------
# These are correct answers that v9b wrongly vetoed (magnitude-only match).
VH=0xe5cf8ea2682a3a49c02c2ccaf55d1bbac1975ab23b9bf30a0a4321c8713e9668
VF=0x76F68ADF3D4eCFDd0725b1320fB25B6772754Ae2; VT=0xecec48Ec5A7B7F7B96460b0F4E2B99cf0dB94Cb1
VQ="What are the details of transaction $VH on Base?"
VGT="Transaction $VH on Base succeeded in block 50343626, transferring 5 ETH from $VF to $VT."
s_v_ether=$(run "$VQ" "$VGT" "Transaction $VH on Base succeeded in block 50343626, transferring 5 Ether from $VF to $VT.")
check "alias ETH->Ether not vetoed"           "$s_v_ether"    "s >= 0.9"
s_v_mainnet=$(run "What are the details of transaction $VH on Ethereum?" "Transaction $VH on Ethereum succeeded in block 19284756, transferring 5 ETH from $VF to $VT." "Transaction $VH on Mainnet succeeded in block 19284756, transferring 5 ETH from $VF to $VT.")
check "alias Ethereum->Mainnet not vetoed"    "$s_v_mainnet"  "s >= 0.9"
VGTT="Transaction $VH on Base succeeded in block 50343626 at 14:32:11 UTC, transferring 5 ETH from $VF to $VT."
s_v_clock=$(run "$VQ" "$VGTT" "Transaction $VH on Base succeeded in block 50343626 at 2:32 PM UTC, transferring 5 ETH from $VF to $VT.")
check "clock 14:32 -> 2:32 PM not vetoed"     "$s_v_clock"    "s >= 0.9"
s_v_clockbad=$(run "$VQ" "$VGTT" "Transaction $VH on Base succeeded in block 50343626 at 14:45:11 UTC, transferring 5 ETH from $VF to $VT.")
check "clock 14:32 -> 14:45 still crushed"    "$s_v_clockbad" "s < 0.15"
VGTD="Transaction $VH on Base succeeded in block 50343626 about 24 hours ago, transferring 5 ETH from $VF to $VT."
s_v_dur=$(run "$VQ" "$VGTD" "Transaction $VH on Base succeeded in block 50343626 about 1 day ago, transferring 5 ETH from $VF to $VT.")
check "duration 24 hours -> 1 day not vetoed" "$s_v_dur"      "s >= 0.9"
VGTC="Transaction $VH on Base succeeded in block 50343626 with 12 confirmations, transferring 5 ETH from $VF to $VT."
s_v_omit=$(run "$VQ" "$VGTC" "Transaction $VH on Base succeeded in block 50343626, transferring 5 ETH from $VF to $VT; it has 2 logs.")
check "omitted fact + unrelated number ok"    "$s_v_omit"     "s >= 0.9"
s_v_slot=$(run "$VQ" "$VGTC" "Transaction $VH on Base succeeded in block 50343626 with 2 confirmations, transferring 5 ETH from $VF to $VT.")
check "same-slot 12 -> 2 confirmations crushed" "$s_v_slot"   "s < 0.15"
# Proper-noun affirm/deny clash is a veto: asserting an entity the ground
# truth denies must be crushed, while the correct answer stays high.
s_v_cd_good=$(run "What is the capital of Australia?" "The capital of Australia is Canberra, not Sydney." "Canberra is Australia's capital city.")
s_v_cd_bad=$(run "What is the capital of Australia?" "The capital of Australia is Canberra, not Sydney." "The capital of Australia is Sydney.")
check "denied-entity good high"               "$s_v_cd_good"  "s >= 0.9"
check "denied-entity asserted crushed"        "$s_v_cd_bad"   "s < 0.15"


# --- v11 HUNTER PINS: every pair v10 lost or won hair-thin (external hunters) ---
# Each must be a strict win with margin >= 0.5 (good high band, bad crushed).
hg=$(run 'What happened with transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base?' 'Transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base succeeded in block 50343626, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.' 'Tx 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 was confirmed in block 50343626, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.'); hb=$(run 'What happened with transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base?' 'Transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base succeeded in block 50343626, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.' 'Tx 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 is pending in the mempool, awaiting inclusion in block 50343626; it will send 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.')
check "HUNTER 01 status-polarity good high"  "$hg" "s >= 0.6"
check "HUNTER 01 status-polarity bad low"    "$hb" "s < 0.15"
check "HUNTER 01 status-polarity margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, calling function 0xa9059cbb (transfer) on 0x2626664c2603336E57B271c5C0b26F421741e481 from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, calling transfer(address,uint256) — selector a9059cbb — on 0x2626664c2603336E57B271c5C0b26F421741e481 from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD.'); hb=$(run 'Look up tx 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, calling function 0xa9059cbb (transfer) on 0x2626664c2603336E57B271c5C0b26F421741e481 from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, calling approve(address,uint256) — selector 095ea7b3 — on 0x2626664c2603336E57B271c5C0b26F421741e481 from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD.')
check "HUNTER 02 format-variants good high"  "$hg" "s >= 0.6"
check "HUNTER 02 format-variants bad low"    "$hb" "s < 0.15"
check "HUNTER 02 format-variants margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 250 USDC from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 03 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 03 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 03 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 25000000 gwei from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 04 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 04 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 04 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 2500 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 05 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 05 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 05 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 250 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 06 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 06 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 06 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf on Base.' 'Transaction 0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf succeeded on Base in block 50388101, moving 1.5 ETH from 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc to 0x80d143489D02A02c89C182b02D26e66f35cBcf8F.' '0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf succeeded on Base in block 50388101 and moved 1.5 ETH from 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc to 0x80d143489D02A02c89C182b02D26e66f35cBcf8F.'); hb=$(run 'Look up tx 0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf on Base.' 'Transaction 0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf succeeded on Base in block 50388101, moving 1.5 ETH from 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc to 0x80d143489D02A02c89C182b02D26e66f35cBcf8F.' '0xd4b69047aa4602920390ef25ace6bf4cbbfed501445088bdb6461ae593894fdf succeeded on Base in block 50388101 and moved 150 ETH from 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc to 0x80d143489D02A02c89C182b02D26e66f35cBcf8F.')
check "HUNTER 07 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 07 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 07 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917, moving 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917, moving 12.505 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 08 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 08 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 08 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917, moving 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 1250.5 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917, moving 1250500000 USDC from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 09 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 09 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 09 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 5034362600, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 10 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 10 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 10 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 503436, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 11 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 11 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 11 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 at a gas price of 0.0102 gwei.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 at a gas price of 0.0102 gwei.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 at a gas price of 0.0102 gwei.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 at a gas price of 1020000 wei.')
check "HUNTER 12 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 12 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 12 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 with a fee of 0.0000034 ETH.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702; the fee was 0.0000034 ETH.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 with a fee of 0.0000034 ETH.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702; the fee was 340 gwei.')
check "HUNTER 13 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 13 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 13 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Tx 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd landed in Base block 50343626 and moved a quarter ETH (0.25) from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 over to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Tx 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd landed in Base block 50343626 and moved 25000 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 over to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 14 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 14 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 14 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 using 21000 gas.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 and using 21000 gas.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 using 21000 gas.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 and using 2100000 gas.')
check "HUNTER 15 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 15 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 15 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 with a fee of 0.0000034 ETH.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702; the fee was 0.0000034 ETH.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 with a fee of 0.0000034 ETH.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702 with a fee of 34000000000000 wei.')
check "HUNTER 16 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 16 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 16 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 0.025 ETH from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 17 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 17 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 17 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 2500000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 18 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 18 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 18 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'Look up tx 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base.' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917, transferring 250000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base (block 51002917), transferring 25000000000000000000 wei from 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 to 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 19 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 19 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 19 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 503436, sending 250 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 20 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 20 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 20 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base is still pending in the mempool as of block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 21 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 21 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 21 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base ran out of gas in block 50343626 while sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 22 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 22 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 22 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917: 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 called approve (0x095ea7b3) on the USDC contract 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917; 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 invoked approve (0x095ea7b3) on the USDC contract at 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.'); hb=$(run 'What did transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base do?' 'Transaction 0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 on Base succeeded in block 51002917: 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 called approve (0x095ea7b3) on the USDC contract 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.' '0x7f8c5e5a52c744e2abdf850d02e89ec72c45a6bf7b341fbea8a22503e7b00061 succeeded on Base in block 51002917; 0x2a1179904A9beEBd7797D79362Ca430299AE6aA8 invoked transfer (0xa9059cbb) on the USDC contract at 0xFce2Ea467E01Be31DCF366Bf96341e0377B83AAc.')
check "HUNTER 23 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 23 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 23 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.'); hb=$(run 'What happened in transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base?' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base succeeded in block 50343626, transferring 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.' 'Transaction 0x543998c04c8814bdb567456a67f7a8a4aa9a08ba88264edcb19e8764efa661bd on Base has status 0 (execution error) in block 50343626, sending 0.25 ETH from 0xDa5E243b243c66b276aa44F856f6A66a30aC7641 to 0x67e61d7B437b419717f117b928CCE1D73628f702.')
check "HUNTER 24 near-ties good high"  "$hg" "s >= 0.6"
check "HUNTER 24 near-ties bad low"    "$hb" "s < 0.15"
check "HUNTER 24 near-ties margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base?' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.' 'Success. Block 50343626 on Base: 0xe5cf…9668 sent 0.25 ETH from 0xd8dA…6045 to 0x4200…0006.'); hb=$(run 'What happened in transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base?' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.' 'Reverted. Block 50343626 on Base: 0xe5cf…9668 attempted to send 0.25 ETH from 0xd8dA…6045 to 0x4200…0006.')
check "HUNTER 25 format-variants good high"  "$hg" "s >= 0.6"
check "HUNTER 25 format-variants bad low"    "$hb" "s < 0.15"
check "HUNTER 25 format-variants margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base?' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 succeeded on Base in block 50343626, transferring 0.25 ETH from 0xd8dA…6045 to 0x4200…0006.'); hb=$(run 'What happened in transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base?' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.' 'Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 succeeded on Base in block 50343626, transferring 0.25 ETH from 0xd8dA…6045 to 0x1F98…F984.')
check "HUNTER 26 format-variants good high"  "$hg" "s >= 0.6"
check "HUNTER 26 format-variants bad low"    "$hb" "s < 0.15"
check "HUNTER 26 format-variants margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Look up tx 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, consuming 21000 gas and transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x2626664c2603336E57B271c5C0b26F421741e481.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de succeeded on Base in block 50412907, transferring 0.25 ETH (~$1,050) from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x2626664c2603336E57B271c5C0b26F421741e481.'); hb=$(run 'Look up tx 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de on Base succeeded in block 50412907, consuming 21000 gas and transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x2626664c2603336E57B271c5C0b26F421741e481.' 'Transaction 0x7b218a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3cc0de succeeded on Base in block 50412907, transferring 1.75 ETH (~$7,350) from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x2626664c2603336E57B271c5C0b26F421741e481.')
check "HUNTER 27 format-variants good high"  "$hg" "s >= 0.6"
check "HUNTER 27 format-variants bad low"    "$hb" "s < 0.15"
check "HUNTER 27 format-variants margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'Did transaction 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d on Base succeed or revert?' 'Transaction 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d reverted (status 0) in block 49988123 on Base.' 'Tx 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d failed in block 49988123; 1 log was emitted before the revert.'); hb=$(run 'Did transaction 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d on Base succeed or revert?' 'Transaction 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d reverted (status 0) in block 49988123 on Base.' 'Tx 0x2e9d7c5b3a1f8e6d4c2b0a9f7e5d3c1b8a6f4e2d0c9b7a5f3e1d8c6b4a2f0e9d succeeded in block 49988123; 1 log was emitted.')
check "HUNTER 28 status-polarity good high"  "$hg" "s >= 0.6"
check "HUNTER 28 status-polarity bad low"    "$hb" "s < 0.15"
check "HUNTER 28 status-polarity margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base?' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base succeeded in block 50343626, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000, total fee 2100000000000 wei.' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f succeeded in block 50343626 on Base, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000, L1 data fee 1834720000000 wei.'); hb=$(run 'What happened in transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base?' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base succeeded in block 50343626, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000, total fee 2100000000000 wei.' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base reverted in block 50343626; the 0.25 ETH transfer from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f failed; gas used 21000, total fee 2100000000000 wei.')
check "HUNTER 29 incidental-numbers good high"  "$hg" "s >= 0.6"
check "HUNTER 29 incidental-numbers bad low"    "$hb" "s < 0.15"
check "HUNTER 29 incidental-numbers margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened with transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base?' 'Transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 succeeded (status 1) in block 50343626 on Base, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.' 'Tx 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 was confirmed in block 50343626 after 0 reverts, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.'); hb=$(run 'What happened with transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 on Base?' 'Transaction 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 succeeded (status 1) in block 50343626 on Base, transferring 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.' 'Tx 0x4f7c2a9e1b3d5f60817293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 reverted in block 50343626, attempting to transfer 0.25 ETH from 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD to 0x8B4a2f9C1e7D3b5A6f0E2c4D8b1A9e3F5c7B0d2E.')
check "HUNTER 30 status-polarity good high"  "$hg" "s >= 0.6"
check "HUNTER 30 status-polarity bad low"    "$hb" "s < 0.15"
check "HUNTER 30 status-polarity margin>=0.5" "$hg" "s > $hb + 0.5"
hg=$(run 'What happened in transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base?' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base succeeded in block 50343626, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000 at an effective gas price of 0.0102 gwei, nonce 3184.' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f succeeded in block 50343626 on Base, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000 (fee about $0.03), nonce 3184.'); hb=$(run 'What happened in transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base?' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base succeeded in block 50343626, transferring 0.25 ETH from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f; gas used 21000 at an effective gas price of 0.0102 gwei, nonce 3184.' 'Transaction 0x8f2c4e7a1b9d3f6e5c0a2d8b4f7e1c3a9d6b5e8f2a4c7d1e3b6f9a0c2e5d8b7f on Base reverted in block 50343626; the 0.25 ETH transfer from 0x7C3e9A1f4B8d2E6c0A5F9b3D7e1C4a8B2f6E0d9A to 0x2F8b6C4a1E9d3B7f5A0c8E2d6B4a9F1e3C7b5D0f failed; gas used 21000 at an effective gas price of 0.0102 gwei, nonce 3184.')
check "HUNTER 31 incidental-numbers good high"  "$hg" "s >= 0.6"
check "HUNTER 31 incidental-numbers bad low"    "$hb" "s < 0.15"
check "HUNTER 31 incidental-numbers margin>=0.5" "$hg" "s > $hb + 0.5"


# --- v11 synthesis-audit pins (D1..D6) -------------------------------------
DQ="What are the details of transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base?"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 1234567890123456789 wei from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 1234567890123456788 wei from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.")
check "D1 1-wei-off wei amount crushed"          "$s" "s < 0.15"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base reverted in block 50343626." "Tx 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 was mined in block 50343626.")
check "D2 'was mined' vs reverted gt crushed"    "$s" "s < 0.15"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base reverted in block 50343626." "Tx 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 was confirmed in block 50343626.")
check "D2 'was confirmed' vs reverted gt crushed" "$s" "s < 0.15"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Yes, mined in block 50343626, 0.25 ETH.")
check "D2 terse 'mined' good high"               "$s" "s >= 0.6"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Tx 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 was included in block 50343626 but reverted.")
check "D2 'included but reverted' crushed"       "$s" "s < 0.15"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base reverted in block 50343626." "Tx 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 has status 0, reverted, in block 50343626.")
check "D3 'status 0, reverted' good high"        "$s" "s >= 0.6"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006; fee 0.0000034 ETH." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 succeeded in block 50343626, transferring 0.25 ETH (about 812.50 USD) from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.")
check "D4 fee omitted + USD equivalent high"     "$s" "s >= 0.6"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50291338 at 14:03:11 UTC, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50291338 at 14:03:11 UTC (timestamp 1755698591), transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.")
check "D5 gt clock + answer timestamp high"      "$s" "s >= 0.6"
s=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626; the value was 0.52 ether, from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.")
check "D6a '0.52 ether' vs 0.25 ETH crushed"     "$s" "s < 0.15"
sg=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006."); so=$(run "$DQ" "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, transferring 0.25 ETH from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006." "Transaction 0xe5cf8a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c4e5f60718a1d2b3c9668 on Base succeeded in block 50343626, from 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 to 0x4200000000000000000000000000000000000006.")
check "D6c omission-only strictly below complete" "$so" "s < $sg"
check "D6c omission-only still high"            "$so" "s >= 0.6"

# Empty question must not trap and self-match must still be 1.0.
s_noq=$(run "" "$GT" "$GT")
check "empty question self-match == 1"        "$s_noq"        "s >= 0.99"

# scores must vary (not constant)
if [ "$s_self" != "$s_unrel" ] && [ "$s_reword" != "$s_unrel" ]; then
  echo "PASS  scores vary (self=$s_self reword=$s_reword unrelated=$s_unrel)"; PASS=$((PASS+1))
else
  echo "FAIL  scores do not vary"; FAIL=$((FAIL+1))
fi

echo
echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
