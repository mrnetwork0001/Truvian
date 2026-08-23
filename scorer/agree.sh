#!/usr/bin/env bash
# Truvian v3 — champion agreement harness.
#
# Scores every row of traffic.tsv (real-traffic corpus: qid, miner, question,
# ground_truth, miner_answer) with BOTH the candidate and the champion binary
# through the official wazero go-tester, then reports Spearman rank
# correlation between the two score vectors: pooled, per-question, and the
# worst random 17-row subsample (mirrors the node's historical_rows gate).
#
# Usage: bash agree.sh [--skip-build] [candidate.wasm]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OURS="${2:-$SCRIPT_DIR/target/wasm32-unknown-unknown/release/truvian_scorer.wasm}"
CHAMP="$SCRIPT_DIR/vendor/telegraph-wasm-baseline/target/wasm32-unknown-unknown/release/telegraph_scoring.wasm"
TESTER_DIR="$SCRIPT_DIR/vendor/telegraph-examples/wasm-scoring-module/go-tester"
TESTER="$TESTER_DIR/tester"
TRAFFIC="$SCRIPT_DIR/traffic.tsv"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

if [ "${1:-}" != "--skip-build" ]; then
  echo "== building candidate =="
  (cd "$SCRIPT_DIR" && cargo build --release --target wasm32-unknown-unknown) || exit 1
fi
[ -f "$OURS" ] || { echo "FATAL: candidate wasm missing"; exit 1; }
[ -f "$CHAMP" ] || { echo "FATAL: champion wasm missing (build with real_weights)"; exit 1; }
[ -x "$TESTER" ] || (cd "$TESTER_DIR" && go build -o tester .) || exit 1

run() {
  local out
  out="$("$TESTER" "$1" "$2" "$3" "$4" 2>&1)" || { echo "TRAP"; return; }
  echo "$out" | awk '/^score:/{print $2}'
}

SCORES="$SCRIPT_DIR/.agree_scores.tsv"
: > "$SCORES"
while IFS=$'\t' read -r qid miner q gt ans; do
  [ "$qid" = "qid" ] && continue
  [ -z "$qid" ] && continue
  o=$(run "$OURS" "$q" "$gt" "$ans")
  c=$(run "$CHAMP" "$q" "$gt" "$ans")
  printf "%s\t%s\t%s\t%s\n" "$qid" "$miner" "$o" "$c" >> "$SCORES"
done < "$TRAFFIC"

python3 - "$SCORES" <<'EOF'
import sys, random

rows = []
for line in open(sys.argv[1]):
    qid, miner, o, c = line.rstrip("\n").split("\t")
    rows.append((qid, miner, float(o), float(c)))

def avg_ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0]*len(xs)
    i = 0
    while i < len(order):
        j = i
        while j+1 < len(order) and xs[order[j+1]] == xs[order[i]]:
            j += 1
        r = (i + j)/2 + 1
        for k in range(i, j+1):
            ranks[order[k]] = r
        i = j+1
    return ranks

def spearman(a, b):
    n = len(a)
    if n < 2:
        return float('nan')
    ra, rb = avg_ranks(a), avg_ranks(b)
    ma, mb = sum(ra)/n, sum(rb)/n
    num = sum((x-ma)*(y-mb) for x, y in zip(ra, rb))
    da = sum((x-ma)**2 for x in ra) ** 0.5
    db = sum((y-mb)**2 for y in rb) ** 0.5
    if da == 0 or db == 0:
        return float('nan')
    return num/(da*db)

ours = [r[2] for r in rows]
champ = [r[3] for r in rows]
print(f"\n== agreement over {len(rows)} rows ==")
print(f"{'qid':14} {'miner':22} {'ours':>7} {'champ':>7}")
for qid, miner, o, c in rows:
    print(f"{qid:14} {miner:22} {o:7.4f} {c:7.4f}")
print(f"\npooled Spearman: {spearman(ours, champ):.4f}")

qids = sorted(set(r[0] for r in rows))
for q in qids:
    sub = [r for r in rows if r[0] == q]
    rho = spearman([r[2] for r in sub], [r[3] for r in sub])
    print(f"  per-question {q:14} n={len(sub):2}  rho={rho:.4f}")

rng = random.Random(1337)
worst, worst_idx = 2.0, None
vals = []
for t in range(2000):
    idx = rng.sample(range(len(rows)), 17)
    rho = spearman([rows[i][2] for i in idx], [rows[i][3] for i in idx])
    if rho == rho:
        vals.append(rho)
        if rho < worst:
            worst, worst_idx = rho, idx
vals.sort()
print(f"\nrandom 17-row subsamples (n=2000, seed 1337):")
print(f"  worst={vals[0]:.4f}  p5={vals[len(vals)//20]:.4f}  median={vals[len(vals)//2]:.4f}")
if worst_idx is not None:
    print("  worst subsample rows:", ", ".join(f"{rows[i][0]}/{rows[i][1]}" for i in sorted(worst_idx)))
EOF
