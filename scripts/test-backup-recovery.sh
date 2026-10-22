#!/usr/bin/env bash
# test-backup-recovery.sh — Smoke-test the full backup → restore cycle.
#
# Requires: mongodump, mongorestore, mongosh (or mongo) on PATH.
# Spins up nothing — runs against an already-running MongoDB instance.
#
# What this verifies (a matching document count alone is NOT enough for a
# financial application — see issue #1107):
#   1. Document count per the whole database matches before vs after.
#   2. Every index present before the backup is present after the restore
#      (name + key spec), so uniqueness/performance guarantees survive.
#   3. A full field-level content fingerprint matches before vs after, so a
#      dropped/garbled/swapped field or a corrupted subset of documents is
#      caught even when the total count is unchanged.
#   4. The seed step actually inserted a realistic fixture (issue #1734): a
#      metadata-only archive is caught before the backup is even taken.
#
# Usage:
#   MONGO_URI=mongodb://localhost:27017/stellaredupay \
#   ./scripts/test-backup-recovery.sh

set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "$0")/lib/backup-common.sh"

MONGO_URI="${MONGO_URI:?MONGO_URI is required}"
DB_NAME="${DB_NAME:-stellaredupay}"
TEST_BACKUP_DIR="$(mktemp -d)"
BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://localhost:5000}"
BACKUP_NOTIFY_TOKEN="${BACKUP_NOTIFY_TOKEN:-}"
# Minimum number of documents the seed fixture must produce. A healthy dump of
# this fixture is well above backup.sh's MIN_BACKUP_SIZE floor; a metadata-only
# archive (378 bytes) means the seed wrote nothing or the wrong database.
MIN_SEED_DOCUMENTS="${MIN_SEED_DOCUMENTS:-100}"

cleanup() { rm -rf "${TEST_BACKUP_DIR}"; }
trap cleanup EXIT

# Total document count across every collection in the database.
count_documents() {
  mongosh --quiet --eval \
    "db.getSiblingDB('${DB_NAME}').getCollectionNames()
       .reduce((n,c) => n + db.getSiblingDB('${DB_NAME}').getCollection(c).countDocuments(), 0)" \
    "${MONGO_URI}" 2>/dev/null || echo "0"
}

# Emit one stable line per index as "collection|indexName|keySpec", sorted.
# Used to detect any index that fails to come back after a restore.
index_manifest() {
  mongosh --quiet --eval "
    const database = db.getSiblingDB('${DB_NAME}');
    const lines = [];
    database.getCollectionNames().forEach(function (name) {
      database.getCollection(name).getIndexes().forEach(function (idx) {
        lines.push(name + '|' + idx.name + '|' + EJSON.stringify(idx.key));
      });
    });
    lines.sort().forEach(function (l) { print(l); });
  " "${MONGO_URI}" 2>/dev/null
}

# Per-collection document counts as "collection|count", sorted by name.
collection_counts() {
  mongosh --quiet --eval "
    const database = db.getSiblingDB('${DB_NAME}');
    database.getCollectionNames().sort().forEach(function (name) {
      print(name + '|' + database.getCollection(name).countDocuments());
    });
  " "${MONGO_URI}" 2>/dev/null
}

# Full field-level content fingerprint: canonical extended JSON of every
# document (sorted by _id, within collections sorted by name), hashed. Any
# changed/dropped/swapped field value flips the hash — no sampling gaps.
content_fingerprint() {
  mongosh --quiet --eval "
    const database = db.getSiblingDB('${DB_NAME}');
    database.getCollectionNames().sort().forEach(function (name) {
      print('### ' + name);
      database.getCollection(name).find().sort({ _id: 1 }).forEach(function (doc) {
        print(EJSON.stringify(doc, { relaxed: false }));
      });
    });
  " "${MONGO_URI}" 2>/dev/null | sha256sum | cut -d' ' -f1
}

echo "=== [0/4] Seeding realistic fixture and asserting document counts ==="
# Seed via the shared fixture script so the dump is large enough to clear
# backup.sh's MIN_BACKUP_SIZE floor (issue #1734). The seed script must target
# the same database/URI we back up below.
if [[ -f "$(dirname "$0")/seed-test-data.js" ]]; then
  MONGO_URI="${MONGO_URI}" DB_NAME="${DB_NAME}" \
    mongosh --quiet "${MONGO_URI}" "$(dirname "$0")/seed-test-data.js" >/dev/null
else
  echo "    WARNING: seed-test-data.js not found — relying on pre-seeded data" >&2
fi

SEED_COUNT="$(count_documents)"
echo "    Seeded documents: ${SEED_COUNT} (minimum ${MIN_SEED_DOCUMENTS})"
if [[ "${SEED_COUNT}" -lt "${MIN_SEED_DOCUMENTS}" ]]; then
  echo "❌  Seed step inserted only ${SEED_COUNT} documents (expected >= ${MIN_SEED_DOCUMENTS})." >&2
  echo "    The seed wrote nothing or targeted the wrong database/URI (${MONGO_URI})." >&2
  exit 1
fi

echo "=== [1/4] Fingerprinting database before backup ==="
BEFORE_COUNT="$(count_documents)"
collection_counts > "${TEST_BACKUP_DIR}/counts-before.txt"
index_manifest > "${TEST_BACKUP_DIR}/indexes-before.txt"
BEFORE_CONTENT="$(content_fingerprint)"
echo "    Documents:   ${BEFORE_COUNT}"
echo "    Indexes:     $(wc -l < "${TEST_BACKUP_DIR}/indexes-before.txt")"
echo "    Content sha: ${BEFORE_CONTENT}"

echo "=== [2/4] Running backup ==="
# This is a local round-trip smoke test, so encryption / off-site upload are
# exercised only when their keys/targets are supplied (#1630). Provide
# BACKUP_AGE_RECIPIENT + BACKUP_AGE_IDENTITY_FILE to cover the encrypted path.
MONGO_URI="${MONGO_URI}" BACKUP_DIR="${TEST_BACKUP_DIR}" \
BACKUP_REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-false}" \
BACKUP_REQUIRE_OFFSITE="${BACKUP_REQUIRE_OFFSITE:-false}" \
  bash "$(dirname "$0")/backup.sh"

# backup.sh names the archive with a timestamp and encryption suffix — find it
BACKUP_FILE="$(latest_local_archive "${TEST_BACKUP_DIR}")"
if [[ -z "${BACKUP_FILE}" ]]; then
  echo "❌  backup.sh did not produce an archive in ${TEST_BACKUP_DIR}" >&2
  exit 1
fi
echo "    Archive: ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))"

echo "=== [3/4] Running restore (drop + reimport) ==="
MONGO_URI="${MONGO_URI}" BACKUP_FILE="${BACKUP_FILE}" DROP="true" \
  bash "$(dirname "$0")/restore.sh" --yes

echo "=== [4/4] Verifying restored database against pre-backup fingerprint ==="
AFTER_COUNT="$(count_documents)"
collection_counts > "${TEST_BACKUP_DIR}/counts-after.txt"
index_manifest > "${TEST_BACKUP_DIR}/indexes-after.txt"
AFTER_CONTENT="$(content_fingerprint)"
echo "    Documents:   ${AFTER_COUNT}"
echo "    Indexes:     $(wc -l < "${TEST_BACKUP_DIR}/indexes-after.txt")"
echo "    Content sha: ${AFTER_CONTENT}"

FAILED=0

# Check 1 — document count.
if [[ "${BEFORE_COUNT}" != "${AFTER_COUNT}" ]]; then
  echo "❌  Document count mismatch: before=${BEFORE_COUNT}, after=${AFTER_COUNT}." >&2
  FAILED=1
fi

# Check 2 — every index present before must be present after. Lines in the
# before-manifest that are absent from the after-manifest are missing indexes.
MISSING_INDEXES="$(comm -23 \
  "${TEST_BACKUP_DIR}/indexes-before.txt" \
  "${TEST_BACKUP_DIR}/indexes-after.txt")"
if [[ -n "${MISSING_INDEXES}" ]]; then
  echo "❌  Restore is missing indexes present in the source:" >&2
  echo "${MISSING_INDEXES}" | sed 's/^/      - /' >&2
  FAILED=1
fi

# Check 3 — field-level content fingerprint.
if [[ "${BEFORE_CONTENT}" != "${AFTER_CONTENT}" ]]; then
  echo "❌  Field-level content mismatch: a document field was dropped, garbled," >&2
  echo "    or swapped during the round trip (content hash differs)." >&2
  FAILED=1
fi

# Check 4 — per-collection counts must match exactly.
if ! diff -q "${TEST_BACKUP_DIR}/counts-before.txt" "${TEST_BACKUP_DIR}/counts-after.txt" >/dev/null; then
  echo "❌  Per-collection document counts differ after restore:" >&2
  diff "${TEST_BACKUP_DIR}/counts-before.txt" "${TEST_BACKUP_DIR}/counts-after.txt" \
    | sed 's/^/      /' >&2
  FAILED=1
fi

# Summary table of per-collection counts (before vs after).
echo ""
echo "    Per-collection counts (before | after):"
while IFS='|' read -r coll before_n; do
  after_n="$(grep -F "${coll}|" "${TEST_BACKUP_DIR}/counts-after.txt" | cut -d'|' -f2 || echo '?')"
  printf '      %-40s %8s | %8s\n' "${coll}" "${before_n}" "${after_n}"
done < "${TEST_BACKUP_DIR}/counts-before.txt"

echo ""
if [[ "${FAILED}" -eq 0 ]]; then
  echo "✅  PASS — document count, indexes, and field-level content all match."
  echo "    The backup is safely restorable."
  if [[ -n "${BACKUP_NOTIFY_TOKEN}" ]]; then
    if ! curl -sf -X POST "${BACKEND_INTERNAL_URL}/api/internal/backup-restore-test-heartbeat" \
        -H "Authorization: Bearer ${BACKUP_NOTIFY_TOKEN}" >/dev/null; then
      echo "    WARNING: restore-test heartbeat to ${BACKEND_INTERNAL_URL} failed (metric may be stale)" >&2
    else
      echo "    Restore-test heartbeat sent to ${BACKEND_INTERNAL_URL}"
    fi
  else
    echo "    WARNING: BACKUP_NOTIFY_TOKEN is not set — last_backup_restore_test_age_seconds will not be updated" >&2
  fi
  exit 0
else
  echo "❌  FAIL — the restored database does not faithfully match the source." >&2
  exit 1
fi
