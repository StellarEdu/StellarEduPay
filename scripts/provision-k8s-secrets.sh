#!/usr/bin/env bash
# provision-k8s-secrets.sh — Initial provisioning for the stellaredupay
# Kubernetes Secret used by the backend deployment.
#
# Usage:
#   JWT_SECRET=<value> MONGO_URI=<value> \
#     ADMIN_USERNAME=<value> ADMIN_PASSWORD_HASH=<value> \
#     METRICS_BEARER_TOKEN=<value> \
#     WEBHOOK_SECRET_ENCRYPTION_KEY=<value> \
#     RECEIPT_SIGNATURE_SECRET=<value> \
#     AUDIT_HMAC_KEY=<value> \
#     [SIGNER_MASTER_KEY=<value>] \
#     [SCHOOL_WALLET_ADDRESS=<value>] \
#     [NAMESPACE=default] \
#     [SECRET_NAME=stellaredupay] \
#     [DRY_RUN=1] \
#     ./scripts/provision-k8s-secrets.sh
#
# The script is idempotent — running it again with updated values patches
# the existing secret in place without downtime.
#
# Required env vars:
#   JWT_SECRET                    — HS256 signing key for session JWTs.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
#   MONGO_URI                     — MongoDB connection string (including credentials).
#   ADMIN_USERNAME                — Initial admin username for bootstrap login.
#   ADMIN_PASSWORD_HASH           — bcrypt hash of the admin password.
#                                   Generate: node scripts/hash-admin-password.js
#   METRICS_BEARER_TOKEN          — Bearer token protecting the /metrics endpoint.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   WEBHOOK_SECRET_ENCRYPTION_KEY — AES-256 key that encrypts webhook endpoint secrets at rest.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   RECEIPT_SIGNATURE_SECRET      — HMAC-SHA256 key for receipt signatures.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   AUDIT_HMAC_KEY                — HMAC key for audit log integrity signatures.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#
# Optional env vars:
#   SIGNER_MASTER_KEY             — AES-256 key encrypting stored Stellar signing keys.
#                                   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   SCHOOL_WALLET_ADDRESS         — School's Stellar public key (G...).
#   REDIS_PASSWORD                — Redis auth password (if Redis requires auth).
#   BACKUP_NOTIFY_TOKEN           — Shared secret for backup heartbeat endpoint.
#   EMAIL_WEBHOOK_SECRET          — Shared secret for email bounce/complaint webhooks.
#   EMAIL_SNS_TOPIC_ARNS          — Comma-separated SES/SNS topic ARNs.
#   EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY — SendGrid Signed Event Webhook public key.
#   NAMESPACE                     — Kubernetes namespace (default: default).
#   SECRET_NAME                   — Name of the Secret resource (default: stellaredupay).
#   DRY_RUN                       — Set to 1 to print the kubectl command without running it.
#
# See also: docs/operator-runbooks.md § Secret Provisioning

set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
SECRET_NAME="${SECRET_NAME:-stellaredupay}"
DRY_RUN="${DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

missing=()

for required_var in JWT_SECRET MONGO_URI ADMIN_USERNAME ADMIN_PASSWORD_HASH \
                    METRICS_BEARER_TOKEN WEBHOOK_SECRET_ENCRYPTION_KEY \
                    RECEIPT_SIGNATURE_SECRET AUDIT_HMAC_KEY; do
  if [[ -z "${!required_var:-}" ]]; then
    missing+=("$required_var")
  fi
done

if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "ERROR: the following required environment variables are not set:" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  echo "" >&2
  echo "See the script header comment for usage and generation instructions." >&2
  exit 1
fi

if [[ -z "${SIGNER_MASTER_KEY:-}" ]]; then
  echo "WARNING: SIGNER_MASTER_KEY is not set. The backend will start but" >&2
  echo "         Stellar signing operations will fail until it is provisioned." >&2
  echo "         For production deployments, set SIGNER_MASTER_KEY." >&2
fi

# ---------------------------------------------------------------------------
# Build the kubectl command
# ---------------------------------------------------------------------------

CLUSTER_CONTEXT="$(kubectl config current-context 2>/dev/null || echo 'unknown')"

echo "Provisioning secret '${SECRET_NAME}' in namespace '${NAMESPACE}'"
echo "  Cluster context : ${CLUSTER_CONTEXT}"
echo "  Operator        : ${USER:-unknown}"
echo "  Timestamp (UTC) : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

KUBECTL_ARGS=(
  create secret generic "${SECRET_NAME}"
  "--from-literal=JWT_SECRET=${JWT_SECRET}"
  "--from-literal=MONGO_URI=${MONGO_URI}"
  "--from-literal=ADMIN_USERNAME=${ADMIN_USERNAME}"
  "--from-literal=ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}"
  "--from-literal=METRICS_BEARER_TOKEN=${METRICS_BEARER_TOKEN}"
  "--from-literal=WEBHOOK_SECRET_ENCRYPTION_KEY=${WEBHOOK_SECRET_ENCRYPTION_KEY}"
  "--from-literal=RECEIPT_SIGNATURE_SECRET=${RECEIPT_SIGNATURE_SECRET}"
  "--from-literal=AUDIT_HMAC_KEY=${AUDIT_HMAC_KEY}"
)

if [[ -n "${SIGNER_MASTER_KEY:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=SIGNER_MASTER_KEY=${SIGNER_MASTER_KEY}")
fi

if [[ -n "${SCHOOL_WALLET_ADDRESS:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=SCHOOL_WALLET_ADDRESS=${SCHOOL_WALLET_ADDRESS}")
fi

if [[ -n "${REDIS_PASSWORD:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=REDIS_PASSWORD=${REDIS_PASSWORD}")
fi

if [[ -n "${BACKUP_NOTIFY_TOKEN:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=BACKUP_NOTIFY_TOKEN=${BACKUP_NOTIFY_TOKEN}")
fi

if [[ -n "${EMAIL_WEBHOOK_SECRET:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=EMAIL_WEBHOOK_SECRET=${EMAIL_WEBHOOK_SECRET}")
fi

if [[ -n "${EMAIL_SNS_TOPIC_ARNS:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=EMAIL_SNS_TOPIC_ARNS=${EMAIL_SNS_TOPIC_ARNS}")
fi

if [[ -n "${EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY=${EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY}")
fi

KUBECTL_ARGS+=(
  "--namespace=${NAMESPACE}"
  "--dry-run=client"
  "-o" "yaml"
)

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[DRY RUN] Would run:"
  echo "  kubectl ${KUBECTL_ARGS[*]} | kubectl apply -f -"
  exit 0
fi

kubectl "${KUBECTL_ARGS[@]}" | kubectl apply --namespace="${NAMESPACE}" -f -

echo ""
echo "Secret provisioned successfully."
echo "Record this run in your change-management or incident log:"
echo "  Secret   : ${SECRET_NAME}"
echo "  Namespace: ${NAMESPACE}"
echo "  Context  : ${CLUSTER_CONTEXT}"
echo "  Operator : ${USER:-unknown}"
echo "  Time     : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
