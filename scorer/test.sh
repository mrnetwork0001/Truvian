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
