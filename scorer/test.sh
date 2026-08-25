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

# Distant-but-correct paraphrase (near-zero token overlap) must clear the
# high band via the MiniLM channel...
DIST_GT="A blockchain is a distributed ledger maintained by a network of nodes without a central authority."
s_dist_good=$(run "What is a blockchain?" "$DIST_GT" "Blockchains are decentralized ledgers kept in sync by many independent nodes rather than one central party.")
check "distant paraphrase good high"          "$s_dist_good"  "s >= 0.6"
# ...while embeddings must NEVER rescue a same-topic wrong answer.
s_dist_bad=$(run "What is a blockchain?" "$DIST_GT" "A blockchain is a centralized database controlled by a single administrator.")
check "distant topic-match wrong below good"  "$s_dist_bad"   "s < $s_dist_good - 0.3"

# Wrong-value answer with near-perfect semantic topicality stays low.
POP_GT="Tokyo has a population of about 14 million people."
s_pop_good=$(run "What is the population of Tokyo?" "$POP_GT" "Around 14 million people live in Tokyo.")
s_pop_bad=$(run "What is the population of Tokyo?" "$POP_GT" "Tokyo has a population of about 4 million people.")
check "population paraphrase good high"       "$s_pop_good"   "s >= 0.6"
check "wrong population not rescued by sem"   "$s_pop_bad"    "s < 0.5"
check "wrong population < good"               "$s_pop_bad"    "s < $s_pop_good - 0.3"

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
