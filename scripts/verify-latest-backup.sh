#!/usr/bin/env bash
# verify-latest-backup.sh — Weekly backup integrity verification (issue #1343).
#
# Restores the most recent nightly backup archive into a temporary MongoDB
# instance (never into production) and confirms the document count matches
# what was live in production, so a corrupted backup is caught long before
# an actual disaster-recovery event.
#
# Environment variables:
#   BACKUP_DIR            — Directory containing backup.sh's .gz archives (required)
#   PROD_MONGO_URI         — Production connection string, read-only, for the
#                            comparison count (required)
#   TEMP_MONGO_URI         — Connection string for the disposable verification
#                            instance to restore into (required)
#   DB_NAME                — Database name inside the archive (default: stellaredupay)
#   BACKEND_INTERNAL_URL   — Backend base URL for the success heartbeat
#                            (default: http://backend:5000)
#   BACKUP_NOTIFY_TOKEN    — Bearer token for the heartbeat endpoint

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
PROD_MONGO_URI="${PROD_MONGO_URI:?PROD_MONGO_URI is required}"
TEMP_MONGO_URI="${TEMP_MONGO_URI:?TEMP_MONGO_URI is required}"
DB_NAME="${DB_NAME:-stellaredupay}"
BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://backend:5000}"
BACKUP_NOTIFY_TOKEN="${BACKUP_NOTIFY_TOKEN:-}"

LATEST_BACKUP="$(ls -t "${BACKUP_DIR}"/*.gz 2>/dev/null | head -1 || true)"
if [[ -z "${LATEST_BACKUP}" ]]; then
  echo "[verify-backup] ERROR: No backup archives found in ${BACKUP_DIR}" >&2
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

echo "[verify-backup] Counting documents in production (read-only)..."
PROD_COUNT="$(count_documents "${PROD_MONGO_URI}")"
echo "    Production documents: ${PROD_COUNT}"

echo "[verify-backup] Restoring latest backup into temporary instance..."
mongorestore --uri="${TEMP_MONGO_URI}" --archive="${LATEST_BACKUP}" --gzip --drop

RESTORED_COUNT="$(count_documents "${TEMP_MONGO_URI}")"
echo "    Restored documents:   ${RESTORED_COUNT}"

if [[ "${PROD_COUNT}" != "${RESTORED_COUNT}" ]]; then
  echo "❌  Document count mismatch: production=${PROD_COUNT}, restored=${RESTORED_COUNT}." >&2
  echo "    Backup ${LATEST_BACKUP} may be corrupt or stale." >&2
  exit 1
fi

echo "✅  PASS — restored document count matches production (${RESTORED_COUNT})."

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
