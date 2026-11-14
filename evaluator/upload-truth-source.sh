#!/usr/bin/env bash
# Sign and upload one truth source to the Telegraph evaluation pool.
#
#   evaluator/upload-truth-source.sh <INTENT> <truth-source.yaml> <contributor address>
#
# The upload is credited to the address that signs it. The key is asked for by
# `cast` with hidden input and is never written to a file, an argument or the
# shell history. Uploading is free and registers nothing on-chain, but it
# changes the live pool from the next epoch, so run `npm run verify:truth`
# first.
#
# Format and signing rules: https://anjoman.ai/docs/scoring/contribute-evaluation-data
set -euo pipefail

INTENT=${1:?intent, e.g. GAS_PRICE_GENERAL}
YAML=${2:?path to the truth-source YAML}
ADDR=${3:?contributor address (the wallet that signs)}
NODE=${TELEGRAPH_NODE_URL:-https://devnode.telegraphprotocol.com}
CHAIN_ID=11155111   # the node's chain: Ethereum Sepolia

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# One row: the YAML text as a JSON string. No trailing newline, so the bytes
# signed are exactly the bytes sent.
jq -Rsjc '{label_kind: "truth_source", source: .}' "$YAML" > "$BODY"

BODY_SHA=$(shasum -a 256 "$BODY" | cut -d' ' -f1)
NONCE=$(openssl rand -hex 16)
MSG=$(printf 'Telegraph eval-pool submission v1\nintent_id: %s\nbody_sha256: %s\nnonce: %s\nchain_id: %s' \
  "$INTENT" "$BODY_SHA" "$NONCE" "$CHAIN_ID")

echo "Intent:      $INTENT"
echo "Source:      $YAML"
echo "Contributor: $ADDR"
echo "Body sha256: $BODY_SHA"
echo
echo "Pool before: $(curl -s "$NODE/api/evalpool/status?intent_id=$INTENT" | jq -c '{by_state, eligible_submitters}')"
echo
echo "Paste the private key of $ADDR when cast asks (input is hidden):"
SIG=$(cast wallet sign --interactive "$MSG")

SIGNER=$(cast wallet verify --address "$ADDR" "$MSG" "$SIG" >/dev/null 2>&1 && echo ok || echo mismatch)
if [ "$SIGNER" != ok ]; then
  echo "The signature does not belong to $ADDR. Nothing was uploaded." >&2
  exit 1
fi

echo
echo "Uploading..."
curl -s -X POST "$NODE/api/evalpool/submissions?intent_id=$INTENT&submitter=$ADDR" \
  -H "Content-Type: application/x-ndjson" \
  -H "X-Evalpool-Signature: $SIG" \
  -H "X-Evalpool-Nonce: $NONCE" \
  --data-binary @"$BODY" | jq .

echo
echo "Your rows for this intent (state and reason, newest first):"
curl -s "$NODE/api/evalpool/submissions/mine?submitter=$ADDR&intent_id=$INTENT" \
  | jq -c '.rows[] | {status, reason_code, provenance_class, created_at}'
