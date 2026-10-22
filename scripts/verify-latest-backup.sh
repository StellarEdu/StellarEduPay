#!/usr/bin/env bash
# verify-latest-backup.sh — Weekly backup integrity verification (issue #1343).
#
# Restores the most recent nightly backup archive into a temporary MongoDB
# instance (never into production) and confirms the document count matches
# what was live in production, so a corrupted backup is caught long before
# an actual disaster-recovery event.
#
# Encrypted and point-in-time (--oplog) archives produced by backup.sh are
# decrypted and replayed through restore.sh (issue #1630).
#
# Environment variables:
#   BACKUP_DIR            — Directory containing backup.sh's archives (required
#                            unless VERIFY_SOURCE=offsite)
#   VERIFY_SOURCE          — "local" verifies the newest archive in BACKUP_DIR;
#                            "offsite" downloads the newest archive from
#                            BACKUP_S3_URI / BACKUP_RCLONE_REMOTE, proving the
#                            off-site copy is restorable. Default: "offsite" when
#                            an off-site target is configured, otherwise "local".
#   PROD_MONGO_URI         — Production connection string, read-only, for the
#                            comparison count (optional; the comparison is
#                            skipped when unset)
#   TEMP_MONGO_URI         — Connection string for the disposable verification
#                            instance to restore into (required)
#   DB_NAME                — Database name inside the archive (default: stellaredupay)
#   BACKEND_INTERNAL_URL   — Backend base URL for the success heartbeat
#                            (default: http://backend:5000)
#   BACKUP_NOTIFY_TOKEN    — Bearer token for the heartbeat endpoint

set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "$0")/lib/backup-common.sh"

PROD_MONGO_URI="${PROD_MONGO_URI:-}"
TEMP_MONGO_URI="${TEMP_MONGO_URI:?TEMP_MONGO_URI is required}"
DB_NAME="${DB_NAME:-stellaredupay}"
BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://backend:5000}"
BACKUP_NOTIFY_TOKEN="${BACKUP_NOTIFY_TOKEN:-}"
if offsite_configured; then
  VERIFY_SOURCE="${VERIFY_SOURCE:-offsite}"
else
  VERIFY_SOURCE="${VERIFY_SOURCE:-local}"
fi

umask 077
DOWNLOAD_DIR="$(mktemp -d "${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/stellaredupay-verify.XXXXXX")"
trap 'rm -rf "${DOWNLOAD_DIR}"' EXIT

if [[ "${VERIFY_SOURCE}" == "offsite" ]]; then
  echo "[verify-backup] Fetching newest off-site archive..."
  LATEST_BACKUP="$(fetch_latest_offsite "${DOWNLOAD_DIR}")"
else
  BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
  LATEST_BACKUP="$(latest_local_archive "${BACKUP_DIR}")"
fi
if [[ -z "${LATEST_BACKUP}" ]]; then
  echo "[verify-backup] ERROR: No backup archives found (source=${VERIFY_SOURCE})" >&2
  exit 1
fi
echo "[verify-backup] Verifying latest backup: ${LATEST_BACKUP}"

count_documents() {
  local uri="$1"
  mongosh --quiet --eval \
    "db.getSiblingDB('${DB_NAME}').getCollectionNames()
       .reduce((n,c) => n + db.getSiblingDB('${DB_NAME}').getCollection(c).countDocuments(), 0)" \
    "${uri}" 2>/dev/null || echo "0"
}

echo "[verify-backup] Restoring latest backup into temporary instance..."
MONGO_URI="${TEMP_MONGO_URI}" BACKUP_FILE="${LATEST_BACKUP}" DROP=true \
  bash "$(dirname "$0")/restore.sh" --yes

RESTORED_COUNT="$(count_documents "${TEMP_MONGO_URI}")"
echo "    Restored documents:   ${RESTORED_COUNT}"

if [[ "${RESTORED_COUNT}" == "0" ]]; then
  echo "❌  Restored database ${DB_NAME} is empty — backup ${LATEST_BACKUP} is unusable." >&2
  exit 1
fi

if [[ -n "${PROD_MONGO_URI}" ]]; then
  echo "[verify-backup] Counting documents in production (read-only)..."
  PROD_COUNT="$(count_documents "${PROD_MONGO_URI}")"
  echo "    Production documents: ${PROD_COUNT}"
  if [[ "${PROD_COUNT}" != "${RESTORED_COUNT}" ]]; then
    echo "❌  Document count mismatch: production=${PROD_COUNT}, restored=${RESTORED_COUNT}." >&2
    echo "    Backup ${LATEST_BACKUP} may be corrupt or stale." >&2
    exit 1
  fi
  echo "✅  PASS — restored document count matches production (${RESTORED_COUNT})."
else
  echo "✅  PASS — backup restored (${RESTORED_COUNT} documents)."
fi

if [[ -n "${BACKUP_NOTIFY_TOKEN}" ]]; then
  if ! curl -sf -X POST "${BACKEND_INTERNAL_URL}/api/internal/backup-verification-heartbeat" \
      -H "Authorization: Bearer ${BACKUP_NOTIFY_TOKEN}" >/dev/null; then
    echo "    WARNING: verification heartbeat to ${BACKEND_INTERNAL_URL} failed (metric may be stale)" >&2
  else
    echo "    Verification heartbeat sent to ${BACKEND_INTERNAL_URL}"
  fi
else
  echo "    WARNING: BACKUP_NOTIFY_TOKEN is not set — last_backup_verification_age_seconds will not be updated" >&2
fi

exit 0
