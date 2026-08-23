#!/usr/bin/env bash
# Truvian v2 — champion comparison harness.
#
# Runs BOTH the Truvian candidate scorer and the incumbent champion
# (telegraph-wasm-baseline, MiniLM-L6-v2 INT8 + BM25 + length) over the
# fixture suite in fixtures.tsv (columns: id, question, ground_truth,
# good_answer, bad_answer) through the OFFICIAL wazero go-tester, and reports
# per-case ordering (good > bad?) and margin (good - bad) for each scorer.
#
# Usage: bash compare.sh [--skip-build] [--ours-only]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OURS="$SCRIPT_DIR/target/wasm32-unknown-unknown/release/truvian_scorer.wasm"
CHAMP_DIR="$SCRIPT_DIR/vendor/telegraph-wasm-baseline"
CHAMP="${CHAMP_WASM:-$CHAMP_DIR/target/wasm32-unknown-unknown/release/telegraph_scoring.wasm}"
TESTER_DIR="$SCRIPT_DIR/vendor/telegraph-examples/wasm-scoring-module/go-tester"
TESTER="$TESTER_DIR/tester"
FIXTURES="$SCRIPT_DIR/fixtures.tsv"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

SKIP_BUILD=0
OURS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --ours-only)  OURS_ONLY=1 ;;
  esac
done

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== building candidate =="
  (cd "$SCRIPT_DIR" && cargo build --release --target wasm32-unknown-unknown) || exit 1
  if [ "$OURS_ONLY" -eq 0 ] && [ ! -f "$CHAMP" ]; then
    echo "== building champion (real_weights) =="
    (cd "$CHAMP_DIR" && cargo build --release --target wasm32-unknown-unknown --features real_weights) || exit 1
  fi
fi
if [ ! -x "$TESTER" ]; then
  echo "== building official go-tester =="
  (cd "$TESTER_DIR" && go build -o tester .) || exit 1
fi
[ -f "$OURS" ] || { echo "FATAL: candidate wasm missing"; exit 1; }
if [ "$OURS_ONLY" -eq 0 ]; then
  [ -f "$CHAMP" ] || { echo "FATAL: champion wasm missing"; exit 1; }
fi

run() { # run <wasm> <q> <gt> <ma> -> score
  local out
  out="$("$TESTER" "$1" "$2" "$3" "$4" 2>&1)" || { echo "TRAP"; return; }
  echo "$out" | awk '/^score:/{print $2}'
}

printf "%-30s | %7s %7s %8s %2s | %7s %7s %8s %2s\n" \
  "case" "our_g" "our_b" "our_m" "ok" "ch_g" "ch_b" "ch_m" "ok"
printf -- "-------------------------------+------------------------------+------------------------------\n"

our_wins=0; ch_wins=0; cases=0
our_msum=0; ch_msum=0
our_losses=""

while IFS=$'\t' read -r id q gt good bad; do
  [ "$id" = "id" ] && continue
  [ -z "$id" ] && continue
  og=$(run "$OURS" "$q" "$gt" "$good")
  ob=$(run "$OURS" "$q" "$gt" "$bad")
  if [ "$OURS_ONLY" -eq 0 ]; then
    cg=$(run "$CHAMP" "$q" "$gt" "$good")
    cb=$(run "$CHAMP" "$q" "$gt" "$bad")
  else
    cg="0"; cb="0"
  fi
  cases=$((cases+1))
  om=$(awk -v a="$og" -v b="$ob" 'BEGIN{printf "%.4f", a-b}')
  cm=$(awk -v a="$cg" -v b="$cb" 'BEGIN{printf "%.4f", a-b}')
  ook=$(awk -v a="$og" -v b="$ob" 'BEGIN{print (a>b)?"Y":"N"}')
  cok=$(awk -v a="$cg" -v b="$cb" 'BEGIN{print (a>b)?"Y":"N"}')
  [ "$ook" = "Y" ] && our_wins=$((our_wins+1)) || our_losses="$our_losses $id"
  [ "$cok" = "Y" ] && ch_wins=$((ch_wins+1))
  our_msum=$(awk -v s="$our_msum" -v m="$om" 'BEGIN{printf "%.4f", s+m}')
  ch_msum=$(awk -v s="$ch_msum" -v m="$cm" 'BEGIN{printf "%.4f", s+m}')
  printf "%-30s | %7s %7s %8s %2s | %7s %7s %8s %2s\n" \
    "$id" "$og" "$ob" "$om" "$ook" "$cg" "$cb" "$cm" "$cok"
done < "$FIXTURES"

our_avg=$(awk -v s="$our_msum" -v n="$cases" 'BEGIN{printf "%.4f", s/n}')
ch_avg=$(awk -v s="$ch_msum" -v n="$cases" 'BEGIN{printf "%.4f", s/n}')

echo
echo "== summary over $cases cases =="
echo "candidate: ordering wins $our_wins/$cases, avg margin $our_avg"
if [ "$OURS_ONLY" -eq 0 ]; then
  echo "champion:  ordering wins $ch_wins/$cases, avg margin $ch_avg"
fi
if [ -n "$our_losses" ]; then
  echo "candidate ordering LOSSES:$our_losses"
fi
