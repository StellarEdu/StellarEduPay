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
#
# Usage:
#   MONGO_URI=mongodb://localhost:27017/stellaredupay \
#   ./scripts/test-backup-recovery.sh

set -euo pipefail

MONGO_URI="${MONGO_URI:?MONGO_URI is required}"
DB_NAME="${DB_NAME:-stellaredupay}"
TEST_BACKUP_DIR="$(mktemp -d)"
BACKUP_FILE="${TEST_BACKUP_DIR}/test-backup.gz"

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

echo "=== [1/4] Fingerprinting database before backup ==="
BEFORE_COUNT="$(count_documents)"
index_manifest > "${TEST_BACKUP_DIR}/indexes-before.txt"
BEFORE_CONTENT="$(content_fingerprint)"
echo "    Documents:   ${BEFORE_COUNT}"
echo "    Indexes:     $(wc -l < "${TEST_BACKUP_DIR}/indexes-before.txt")"
echo "    Content sha: ${BEFORE_CONTENT}"

echo "=== [2/4] Running backup ==="
MONGO_URI="${MONGO_URI}" BACKUP_DIR="${TEST_BACKUP_DIR}" \
  bash "$(dirname "$0")/backup.sh"

if [[ ! -f "${BACKUP_FILE}" ]]; then
  # backup.sh names the file with a timestamp — find it
  BACKUP_FILE=$(ls -t "${TEST_BACKUP_DIR}"/*.gz | head -1)
fi
echo "    Archive: ${BACKUP_FILE} ($(du -sh "${BACKUP_FILE}" | cut -f1))"

echo "=== [3/4] Running restore (drop + reimport) ==="
MONGO_URI="${MONGO_URI}" BACKUP_FILE="${BACKUP_FILE}" DROP="true" \
  bash "$(dirname "$0")/restore.sh"

echo "=== [4/4] Verifying restored database against pre-backup fingerprint ==="
AFTER_COUNT="$(count_documents)"
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

echo ""
if [[ "${FAILED}" -eq 0 ]]; then
  echo "✅  PASS — document count, indexes, and field-level content all match."
  echo "    The backup is safely restorable."
  exit 0
else
  echo "❌  FAIL — the restored database does not faithfully match the source." >&2
  exit 1
fi
