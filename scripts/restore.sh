#!/usr/bin/env bash
# restore.sh — Restore a StellarEduPay database from a compressed mongodump archive.
#
# Usage:
#   MONGO_URI=mongodb://localhost:27017/stellaredupay \
#   BACKUP_FILE=./backups/20260326T120000Z.gz \
#   ./scripts/restore.sh [--dry-run] [--yes]
#
# Environment variables:
#   MONGO_URI    — MongoDB connection string (required)
#   BACKUP_FILE  — Path to the backup archive (required). Plaintext (.gz /
#                  .archive.gz) and encrypted (.archive.gz.age / .archive.gz.gpg)
#                  archives are accepted; encrypted ones need
#                  BACKUP_AGE_IDENTITY_FILE or BACKUP_GPG_PRIVATE_KEY_FILE
#                  (see scripts/lib/backup-common.sh).
#   OPLOG_REPLAY — "auto" (default) replays the oplog when the archive's
#                  manifest says it was taken with --oplog; "true"/"false" force it.
#   NS_INCLUDE   — Optional namespace filter passed to mongorestore --nsInclude
#                  (e.g. "stellaredupay.*"). Point-in-time archives are full-instance
#                  dumps, so this restricts what is restored.
#   DROP         — Set to "true" to drop existing collections before restore (default: false)
#   DRY_RUN      — Set to "true" to print the target database URI and mongorestore
#                  commands that would be executed, without mutating the database.
#
# Flags:
#   --dry-run    — Equivalent to DRY_RUN=true
#   --yes / -y   — Skip interactive confirmation when DROP=true
#   --drop       — Equivalent to DROP=true (convenience flag)

set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "$0")/lib/backup-common.sh"

# ── Parse flags ───────────────────────────────────────────────────────────────
SKIP_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --yes|-y)   SKIP_CONFIRM=true ;;
    --drop)     DROP=true ;;
    -*)
      echo "[restore] ERROR: Unknown flag: $arg" >&2
      echo "[restore] Usage: $0 [--dry-run] [--yes|-y] [--drop]" >&2
      exit 1
      ;;
  esac
done

# ── Environment defaults ──────────────────────────────────────────────────────
MONGO_URI="${MONGO_URI:?MONGO_URI is required}"
BACKUP_FILE="${BACKUP_FILE:?BACKUP_FILE is required}"
DROP="${DROP:-false}"       # safe default: do NOT drop collections
DRY_RUN="${DRY_RUN:-false}"
OPLOG_REPLAY="${OPLOG_REPLAY:-auto}"
NS_INCLUDE="${NS_INCLUDE:-}"

# ── Validate backup file ──────────────────────────────────────────────────────
if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "[restore] ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

# ── Build mongorestore arguments ──────────────────────────────────────────────
# Archives taken with --oplog are full-instance dumps; restoring them through a
# URI that names a database would make mongorestore treat it as --db, so the
# database path is stripped (use NS_INCLUDE to narrow what is restored).
RESTORE_URI="${MONGO_URI}"
if [[ "$(manifest_get "${BACKUP_FILE}" oplog)" == "true" ]]; then
  RESTORE_URI="$(server_level_uri "${MONGO_URI}")"
  [[ "${OPLOG_REPLAY}" == "auto" ]] && OPLOG_REPLAY=true
fi
[[ "${OPLOG_REPLAY}" == "auto" ]] && OPLOG_REPLAY=false
EXTRA_ARGS=()
[[ "${OPLOG_REPLAY}" == "true" ]] && EXTRA_ARGS+=(--oplogReplay)
[[ -n "${NS_INCLUDE}" ]] && EXTRA_ARGS+=(--nsInclude="${NS_INCLUDE}")
[[ "${DROP}" == "true" ]] && EXTRA_ARGS+=(--drop)

# ── Dry-run mode ──────────────────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[restore] DRY-RUN mode — no data will be written."
  echo "[restore] Target database URI : ${MONGO_URI}"
  echo "[restore] Backup archive      : ${BACKUP_FILE}"
  echo "[restore] DROP collections    : ${DROP}"
  echo "[restore] Oplog replay        : ${OPLOG_REPLAY}"
  echo ""
  echo "[restore] Would execute:"
  case "${BACKUP_FILE}" in
    *.age|*.gpg) echo "  (decrypt ${BACKUP_FILE} to a private temp file)" ;;
  esac
  echo "  mongorestore --uri=\"${RESTORE_URI}\" --archive=<archive> --gzip ${EXTRA_ARGS[*]:-}"
  echo "[restore] Dry-run complete — no changes made."
  exit 0
fi

# ── Interactive confirmation when DROP=true ───────────────────────────────────
if [[ "${DROP}" == "true" ]]; then
  if [[ "${SKIP_CONFIRM}" != "true" ]]; then
    echo ""
    echo "WARNING: You are about to DROP existing collections on ${MONGO_URI}."
    echo "         This will permanently delete all data in those collections before"
    echo "         restoring from: ${BACKUP_FILE}"
    echo ""
    read -r -p "Are you sure? [y/N] " CONFIRM
    case "$CONFIRM" in
      y|Y) ;;
      *)
        echo "[restore] Restore aborted by operator."
        exit 1
        ;;
    esac
  fi
fi

# ── Verify and decrypt ────────────────────────────────────────────────────────
verify_manifest_checksum "${BACKUP_FILE}"

ARCHIVE="${BACKUP_FILE}"
case "${BACKUP_FILE}" in
  *.age|*.gpg)
    umask 077
    WORK_DIR="$(mktemp -d "${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/stellaredupay-restore.XXXXXX")"
    trap 'rm -rf "${WORK_DIR}"' EXIT
    ARCHIVE="${WORK_DIR}/archive.gz"
    echo "[restore] Decrypting ${BACKUP_FILE}"
    decrypt_file "${BACKUP_FILE}" "${ARCHIVE}"
    ;;
esac

# ── Execute restore ───────────────────────────────────────────────────────────
echo "[restore] Restoring from ${BACKUP_FILE} into ${MONGO_URI} (drop=${DROP}, oplogReplay=${OPLOG_REPLAY})"
mongorestore --uri="${RESTORE_URI}" --archive="${ARCHIVE}" --gzip "${EXTRA_ARGS[@]}"
echo "[restore] Restore complete"
