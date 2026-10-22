#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${LOAD_TEST_OUTPUT_DIR:-$ROOT/load-test-results}"
mkdir -p "$OUTPUT_DIR"

: "${BASE_URL:?BASE_URL is required}"
: "${AUTH_TOKEN:?AUTH_TOKEN is required}"
: "${SCHOOL_ID:?SCHOOL_ID is required}"

if [[ "${LOAD_TEST_SEED:-false}" == "true" ]]; then
  : "${MONGO_URI:?MONGO_URI is required when LOAD_TEST_SEED=true}"
  SEED_SCHOOL_COUNT="${SEED_SCHOOL_COUNT:-200}" \
  SEED_STUDENTS_PER_SCHOOL="${SEED_STUDENTS_PER_SCHOOL:-500}" \
  MONGO_URI="$MONGO_URI" \
  node "$ROOT/scripts/seed-demo.js"
fi

traffic_pid=""
cleanup() {
  if [[ -n "$traffic_pid" ]]; then
    kill "$traffic_pid" 2>/dev/null || true
    wait "$traffic_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${LOAD_TEST_START_TRAFFIC:-false}" == "true" ]]; then
  LOAD_TEST_MANIFEST="$OUTPUT_DIR/payment-manifest.json" \
  node "$ROOT/tests/loadsim/traffic-generator.js" >"$OUTPUT_DIR/traffic-generator.log" 2>&1 &
  traffic_pid=$!
  sleep "${LOAD_TEST_TRAFFIC_WARMUP_SECONDS:-10}"
fi

LOAD_TEST_MANIFEST="${LOAD_TEST_MANIFEST:-$OUTPUT_DIR/payment-manifest.json}" \
LOAD_TEST_SUMMARY="$OUTPUT_DIR/load-test-summary.json" \
k6 run "$ROOT/tests/loadsim/k6/load-test.js" \
  --summary-export "$OUTPUT_DIR/k6-summary.json"
