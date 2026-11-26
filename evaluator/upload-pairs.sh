#!/usr/bin/env bash
# Sign and upload a JSONL file of preference pairs to the Telegraph evaluation pool.
#
#   evaluator/upload-pairs.sh <INTENT> <pairs.jsonl> <contributor address>
#
# Same signing as upload-truth-source.sh: the key is asked for by `cast` with
# hidden input and is never written to a file, an argument or the shell
# history. The file is sent byte for byte (--data-binary), so the hash signed
# is the hash of what the node receives. Free, nothing on-chain; rows join the
# pool at the next epoch rollover.
#
# Format and signing rules: https://anjoman.ai/docs/scoring/contribute-evaluation-data
set -euo pipefail

INTENT=${1:?intent, e.g. SLA_COMPLIANCE_GENERAL}
BODY=${2:?path to the pairs JSONL}
ADDR=${3:?contributor address (the wallet that signs)}
NODE=${TELEGRAPH_NODE_URL:-https://devnode.telegraphprotocol.com}
CHAIN_ID=11155111   # the node's chain: Ethereum Sepolia

# every line must be a JSON object for this intent
jq -e --arg i "$INTENT" -s 'all(.[]; type == "object" and ((.intent_id // $i) == $i))' "$BODY" >/dev/null \
  || { echo "$BODY has a line that is not a row for $INTENT. Nothing was uploaded." >&2; exit 1; }

BODY_SHA=$(shasum -a 256 "$BODY" | cut -d' ' -f1)
NONCE=$(openssl rand -hex 16)
MSG=$(printf 'Telegraph eval-pool submission v1\nintent_id: %s\nbody_sha256: %s\nnonce: %s\nchain_id: %s' \
  "$INTENT" "$BODY_SHA" "$NONCE" "$CHAIN_ID")

echo "Intent:      $INTENT"
echo "Rows:        $(wc -l < "$BODY" | tr -d ' ') from $BODY"
echo "Contributor: $ADDR"
echo "Body sha256: $BODY_SHA"
echo
echo "Pool before: $(curl -s "$NODE/api/evalpool/status?intent_id=$INTENT" | jq -c '{by_state, submitters, min_submitters}')"
echo
echo "Paste the private key of $ADDR when cast asks (input is hidden):"
SIG=$(cast wallet sign --interactive "$MSG")

if ! cast wallet verify --address "$ADDR" "$MSG" "$SIG" >/dev/null 2>&1; then
  echo "The signature does not belong to $ADDR. Nothing was uploaded." >&2
  exit 1
fi

echo
echo "Uploading..."
curl -s -X POST "$NODE/api/evalpool/submissions?intent_id=$INTENT&submitter=$ADDR" \
  -H "Content-Type: application/x-ndjson" \
  -H "X-Evalpool-Signature: $SIG" \
  -H "X-Evalpool-Nonce: $NONCE" \
  --data-binary @"$BODY" | jq '{received, accepted, duplicate, rejected, errors, state_counts}'

echo
echo "Pool after: $(curl -s "$NODE/api/evalpool/status?intent_id=$INTENT" | jq -c '{by_state, submitters, min_submitters}')"
