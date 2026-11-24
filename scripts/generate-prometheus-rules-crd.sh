#!/usr/bin/env bash
# Generate Prometheus Operator PrometheusRule CRDs from monitoring/alerts/ (#2018).
#
# Each monitoring/alerts/*.yml file is wrapped as the `spec` of one
# PrometheusRule (its `groups:` block is already the operator's format).
# Output: k8s/monitoring/prometheus-rules.yaml (one document per alert file).
#
# Usage: scripts/generate-prometheus-rules-crd.sh [namespace]
#   namespace defaults to "monitoring".
#
# Requires kube-prometheus-stack (or any Prometheus Operator install) whose
# Prometheus `ruleSelector` matches the label `release: kube-prometheus-stack`.
# See docs/alerting.md.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALERTS_DIR="$ROOT/monitoring/alerts"
OUT="$ROOT/k8s/monitoring/prometheus-rules.yaml"
NAMESPACE="${1:-monitoring}"

mkdir -p "$(dirname "$OUT")"
: > "$OUT"

shopt -s nullglob
files=("$ALERTS_DIR"/*.yml)
if [ ${#files[@]} -eq 0 ]; then
  echo "No alert files found in $ALERTS_DIR" >&2
  exit 1
fi

for file in "${files[@]}"; do
  name="$(basename "$file" .yml | tr '_' '-' | tr '[:upper:]' '[:lower:]')"
  {
    echo "---"
    echo "apiVersion: monitoring.coreos.com/v1"
    echo "kind: PrometheusRule"
    echo "metadata:"
    echo "  name: stellaredupay-${name}"
    echo "  namespace: ${NAMESPACE}"
    echo "  labels:"
    echo "    release: kube-prometheus-stack"
    echo "spec:"
    # Indent the rule file's contents under spec:, keeping blank lines intact.
    sed 's/^\(.\)/  \1/; s/^$//' "$file"
  } >> "$OUT"
done

echo "Wrote ${#files[@]} PrometheusRule(s) to $OUT"
