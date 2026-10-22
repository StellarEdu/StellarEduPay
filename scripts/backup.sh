#!/usr/bin/env bash
# backup.sh — Create a consistent, encrypted, off-site mongodump of the
# StellarEduPay database.
#
# Usage:
#   MONGO_URI=mongodb://localhost:27017/stellaredupay?replicaSet=rs0 \
#   BACKUP_DIR=/backups \
#   BACKUP_AGE_RECIPIENT=age1... \
#   BACKUP_S3_URI=s3://my-bucket/stellaredupay \
#   ./scripts/backup.sh
#
# Environment variables:
#   MONGO_URI                  — MongoDB connection string (required)
#   BACKUP_DIR                 — Directory to store backups (default: ./backups)
#   RETAIN_DAYS                — Days to keep old local backups (default: 7). Off-site
#                                retention is enforced by the bucket's lifecycle /
#                                object-lock policy, not by this script.
#   WEBHOOK_URL                — Optional webhook URL for failure alerts
#   MIN_BACKUP_SIZE            — Minimum expected archive size in bytes (default: 1024)
#   BACKUP_OPLOG               — "true" (default) dumps with --oplog so the archive is a
#                                point-in-time snapshot across every collection. Requires
#                                a replica set; the database is stripped from MONGO_URI
#                                because --oplog only supports full-instance dumps.
#   BACKUP_REQUIRE_ENCRYPTION  — "true" (default) fails the backup when no recipient
#                                public key is configured. Set "false" only for local dev.
#   BACKUP_REQUIRE_OFFSITE     — "true" (default) fails the backup when no off-site target
#                                is configured. Set "false" only for local dev.
#   BACKUP_WORK_DIR            — Scratch directory for the plaintext archive while it is
#                                verified and encrypted (default: $TMPDIR). Keep this off
#                                the backup volume; it is wiped on exit.
#
# Encryption / off-site variables are documented in scripts/lib/backup-common.sh.

set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "$0")/lib/backup-common.sh"

MONGO_URI="${MONGO_URI:?MONGO_URI is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"
WEBHOOK_URL="${WEBHOOK_URL:-}"
MIN_BACKUP_SIZE="${MIN_BACKUP_SIZE:-1024}"
BACKUP_OPLOG="${BACKUP_OPLOG:-true}"
BACKUP_REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-true}"
BACKUP_REQUIRE_OFFSITE="${BACKUP_REQUIRE_OFFSITE:-true}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

# Archives contain student PII and financial records: never world-readable.
umask 077
mkdir -p "${BACKUP_DIR}"
WORK_DIR="$(mktemp -d "${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/stellaredupay-backup.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT
PLAIN_PATH="${WORK_DIR}/${TIMESTAMP}.archive.gz"

# Function to send alert
send_alert() {
  local message="$1"
  echo "[backup] ALERT: ${message}" >&2

  if [[ -n "${WEBHOOK_URL}" ]]; then
    curl -X POST "${WEBHOOK_URL}" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"[StellarEduPay Backup] ${message}\",\"timestamp\":\"${TIMESTAMP}\"}" \
      --max-time 10 \
      --silent \
      --show-error || echo "[backup] Failed to send webhook alert" >&2
  fi
}

# ── Pre-flight: refuse to produce an archive that would violate policy ────────
ENCRYPTION="$(encryption_mode)"
if [[ "${ENCRYPTION}" == "none" ]]; then
  if [[ "${BACKUP_REQUIRE_ENCRYPTION}" == "true" ]]; then
    send_alert "No backup encryption key configured (set BACKUP_AGE_RECIPIENT or BACKUP_GPG_RECIPIENT_FILE, or BACKUP_REQUIRE_ENCRYPTION=false for local dev)"
    exit 1
  fi
  echo "[backup] WARNING: backups are NOT encrypted (BACKUP_REQUIRE_ENCRYPTION=false)" >&2
fi
if ! offsite_configured; then
  if [[ "${BACKUP_REQUIRE_OFFSITE}" == "true" ]]; then
    send_alert "No off-site backup target configured (set BACKUP_S3_URI or BACKUP_RCLONE_REMOTE, or BACKUP_REQUIRE_OFFSITE=false for local dev)"
    exit 1
  fi
  echo "[backup] WARNING: backups are kept on this volume only (BACKUP_REQUIRE_OFFSITE=false)" >&2
fi

# ── Dump ──────────────────────────────────────────────────────────────────────
DUMP_ARGS=(--archive="${PLAIN_PATH}" --gzip)
if [[ "${BACKUP_OPLOG}" == "true" ]]; then
  DUMP_ARGS+=(--uri="$(server_level_uri "${MONGO_URI}")" --oplog)
else
  DUMP_ARGS+=(--uri="${MONGO_URI}")
fi

echo "[backup] Starting backup (oplog=${BACKUP_OPLOG}, encryption=${ENCRYPTION})"

# Capture the real exit status: inside `if ! cmd; then`, $? is the status of
# the negation (always 0), which is why alerts used to say "exit code 0".
dump_rc=0
mongodump "${DUMP_ARGS[@]}" || dump_rc=$?
if [[ "${dump_rc}" -ne 0 ]]; then
  send_alert "mongodump failed with exit code ${dump_rc}"
  exit 1
fi

# Verify backup file exists
if [[ ! -f "${PLAIN_PATH}" ]]; then
  send_alert "Backup archive ${PLAIN_PATH} was not created"
  exit 1
fi

# Verify backup file is non-empty and meets minimum size
BACKUP_SIZE=$(stat -c%s "${PLAIN_PATH}" 2>/dev/null || stat -f%z "${PLAIN_PATH}" 2>/dev/null || echo "0")
if [[ "${BACKUP_SIZE}" -lt "${MIN_BACKUP_SIZE}" ]]; then
  send_alert "Backup archive is too small (${BACKUP_SIZE} bytes, expected at least ${MIN_BACKUP_SIZE})"
  exit 1
fi

# Verify backup integrity with mongorestore --dryRun.
#
# Exit-code-based check: we rely solely on mongorestore's exit status (0 =
# success, non-zero = failure), not on grepping its human-readable log output.
# See issue #1105. The `|| rc=$?` form keeps set -e from aborting the script
# before the status is captured.
echo "[backup] Verifying backup integrity..."
mongorestore_exit=0
mongorestore_output=$(mongorestore --archive="${PLAIN_PATH}" --gzip --dryRun 2>&1) || mongorestore_exit=$?
if [[ "${mongorestore_exit}" -ne 0 ]]; then
  echo "[backup] mongorestore --dryRun output:" >&2
  echo "${mongorestore_output}" >&2
  send_alert "Backup verification failed — mongorestore --dryRun exited with code ${mongorestore_exit}"
  exit 1
fi
echo "[backup] ✓ Backup verified successfully"

# ── Encrypt ───────────────────────────────────────────────────────────────────
case "${ENCRYPTION}" in
  age) FINAL_NAME="${TIMESTAMP}.archive.gz.age" ;;
  gpg) FINAL_NAME="${TIMESTAMP}.archive.gz.gpg" ;;
  *)   FINAL_NAME="${TIMESTAMP}.archive.gz" ;;
esac
STAGED_PATH="${WORK_DIR}/${FINAL_NAME}"

if [[ "${ENCRYPTION}" != "none" ]]; then
  encrypt_rc=0
  encrypt_file "${PLAIN_PATH}" "${STAGED_PATH}" || encrypt_rc=$?
  if [[ "${encrypt_rc}" -ne 0 ]]; then
    send_alert "Backup encryption (${ENCRYPTION}) failed with exit code ${encrypt_rc}"
    exit 1
  fi
  rm -f "${PLAIN_PATH}"
fi

MANIFEST_PATH="${WORK_DIR}/${TIMESTAMP}.manifest"
cat > "${MANIFEST_PATH}" <<EOF
timestamp=${TIMESTAMP}
archive=${FINAL_NAME}
oplog=${BACKUP_OPLOG}
encryption=${ENCRYPTION}
sha256=$(file_sha256 "${STAGED_PATH}")
plaintext_bytes=${BACKUP_SIZE}
EOF

# ── Off-site copy ─────────────────────────────────────────────────────────────
if offsite_configured; then
  upload_rc=0
  upload_offsite "${STAGED_PATH}" "${MANIFEST_PATH}" || upload_rc=$?
  if [[ "${upload_rc}" -ne 0 ]]; then
    send_alert "Off-site upload of ${FINAL_NAME} failed with exit code ${upload_rc}"
    exit 1
  fi
  echo "[backup] ✓ Uploaded ${FINAL_NAME} off-site"
fi

# ── Local copy ────────────────────────────────────────────────────────────────
mv "${STAGED_PATH}" "${BACKUP_DIR}/${FINAL_NAME}"
mv "${MANIFEST_PATH}" "${BACKUP_DIR}/${TIMESTAMP}.manifest"
echo "[backup] Backup created: ${BACKUP_DIR}/${FINAL_NAME} ($(du -sh "${BACKUP_DIR}/${FINAL_NAME}" | cut -f1))"

# Notify the backend so backup_last_success_timestamp_seconds stays current.
# BACKEND_INTERNAL_URL defaults to http://backend:5000 (the service name on the
# backend-db Docker network). BACKUP_NOTIFY_TOKEN must match the value set in
# the backend's environment. If either is unset the notification is skipped and
# a warning is emitted — the backup itself still succeeds.
BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://backend:5000}"
BACKUP_NOTIFY_TOKEN="${BACKUP_NOTIFY_TOKEN:-}"
if [[ -n "${BACKUP_NOTIFY_TOKEN}" ]]; then
  if ! curl -sf -X POST "${BACKEND_INTERNAL_URL}/api/internal/backup-heartbeat" \
      -H "Authorization: Bearer ${BACKUP_NOTIFY_TOKEN}" \
      -H "Content-Type: application/json" \
      --max-time 10 \
      --silent \
      --show-error > /dev/null 2>&1; then
    echo "[backup] WARNING: heartbeat notification to ${BACKEND_INTERNAL_URL} failed (metric may be stale)" >&2
  else
    echo "[backup] Heartbeat sent to ${BACKEND_INTERNAL_URL}"
  fi
else
  echo "[backup] WARNING: BACKUP_NOTIFY_TOKEN is not set — backup_last_success_timestamp_seconds will not be updated" >&2
fi

# Remove local backups older than RETAIN_DAYS
PRUNED=$(find "${BACKUP_DIR}" -maxdepth 1 -type f \
  \( -name "*.gz" -o -name "*.gz.age" -o -name "*.gz.gpg" -o -name "*.manifest" \) \
  -mtime "+${RETAIN_DAYS}" -delete -print | wc -l)
if [[ "${PRUNED}" -gt 0 ]]; then
  echo "[backup] Pruned ${PRUNED} local file(s) older than ${RETAIN_DAYS} days"
fi

echo "[backup] Backup complete"
