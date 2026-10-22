#!/usr/bin/env bash
# backup-common.sh — Shared helpers for backup.sh, restore.sh and the restore
# verification scripts (issue #1630). Source this file; do not execute it.
#
# Archive naming:
#   <TIMESTAMP>.archive.gz          plaintext gzip'd mongodump archive (legacy / dev only)
#   <TIMESTAMP>.archive.gz.age      age-encrypted archive
#   <TIMESTAMP>.archive.gz.gpg      GPG-encrypted archive
#   <TIMESTAMP>.manifest            key=value sidecar (oplog, encryption, sha256, ...)
# Legacy archives named <TIMESTAMP>.gz are still recognised by every reader.
#
# Encryption (public-key only — the decryption key never lives next to the
# backups or inside the cluster that produces them):
#   BACKUP_AGE_RECIPIENT        age public key ("age1...")
#   BACKUP_AGE_RECIPIENTS_FILE  file containing one or more age public keys
#   BACKUP_GPG_RECIPIENT_FILE   file containing an exported GPG public key
# Decryption (restore / verification only):
#   BACKUP_AGE_IDENTITY_FILE    age private identity file
#   BACKUP_GPG_PRIVATE_KEY_FILE armoured GPG private key, imported into a
#                               throw-away GNUPGHOME for the duration of the call
#
# Off-site storage:
#   BACKUP_S3_URI               e.g. s3://bucket/stellaredupay (uses the aws CLI;
#                               set AWS_* / BACKUP_S3_ENDPOINT_URL as needed)
#   BACKUP_RCLONE_REMOTE        e.g. offsite:stellaredupay-backups (uses rclone)

# Every archive extension readers should consider, newest naming first.
BACKUP_ARCHIVE_GLOBS=("*.archive.gz.age" "*.archive.gz.gpg" "*.archive.gz" "*.gz")

# log <tag> <message>
_bc_log() { echo "[$1] $2" >&2; }

# encryption_mode → prints "age", "gpg" or "none" based on configured recipients.
encryption_mode() {
  if [[ -n "${BACKUP_AGE_RECIPIENT:-}" || -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]]; then
    echo "age"
  elif [[ -n "${BACKUP_GPG_RECIPIENT_FILE:-}" ]]; then
    echo "gpg"
  else
    echo "none"
  fi
}

# encrypt_file <plaintext> <output> — encrypt with the configured public key.
encrypt_file() {
  local in="$1" out="$2"
  case "$(encryption_mode)" in
    age)
      command -v age >/dev/null 2>&1 || { _bc_log backup "age is not installed"; return 1; }
      local args=()
      [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && args+=(-r "${BACKUP_AGE_RECIPIENT}")
      [[ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]] && args+=(-R "${BACKUP_AGE_RECIPIENTS_FILE}")
      age "${args[@]}" -o "${out}" "${in}"
      ;;
    gpg)
      command -v gpg >/dev/null 2>&1 || { _bc_log backup "gpg is not installed"; return 1; }
      local gnupg_home rc=0
      gnupg_home="$(mktemp -d)"
      GNUPGHOME="${gnupg_home}" gpg --batch --yes --quiet --trust-model always \
        --recipient-file "${BACKUP_GPG_RECIPIENT_FILE}" \
        --output "${out}" --encrypt "${in}" || rc=$?
      rm -rf "${gnupg_home}"
      return "${rc}"
      ;;
    *)
      _bc_log backup "encrypt_file called with no recipient configured"
      return 1
      ;;
  esac
}

# decrypt_file <input> <output> — decrypt (or copy, for plaintext archives).
decrypt_file() {
  local in="$1" out="$2"
  case "${in}" in
    *.age)
      command -v age >/dev/null 2>&1 || { _bc_log restore "age is not installed"; return 1; }
      [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]] || { _bc_log restore "BACKUP_AGE_IDENTITY_FILE is required to decrypt ${in}"; return 1; }
      age -d -i "${BACKUP_AGE_IDENTITY_FILE}" -o "${out}" "${in}"
      ;;
    *.gpg)
      command -v gpg >/dev/null 2>&1 || { _bc_log restore "gpg is not installed"; return 1; }
      if [[ -n "${BACKUP_GPG_PRIVATE_KEY_FILE:-}" ]]; then
        local gnupg_home rc=0
        gnupg_home="$(mktemp -d)"
        GNUPGHOME="${gnupg_home}" gpg --batch --quiet --import "${BACKUP_GPG_PRIVATE_KEY_FILE}" || rc=$?
        if [[ "${rc}" -eq 0 ]]; then
          GNUPGHOME="${gnupg_home}" gpg --batch --yes --quiet --output "${out}" --decrypt "${in}" || rc=$?
        fi
        rm -rf "${gnupg_home}"
        return "${rc}"
      fi
      gpg --batch --yes --quiet --output "${out}" --decrypt "${in}"
      ;;
    *)
      cp "${in}" "${out}"
      ;;
  esac
}

# file_sha256 <file>
file_sha256() {
  sha256sum "$1" | cut -d' ' -f1
}

# manifest_path <archive> → sidecar manifest path for an archive.
manifest_path() {
  local base
  base="$(basename "$1")"
  base="${base%%.*}"
  echo "$(dirname "$1")/${base}.manifest"
}

# manifest_get <archive> <key> → value from the archive's manifest (empty if absent).
manifest_get() {
  local manifest
  manifest="$(manifest_path "$1")"
  [[ -f "${manifest}" ]] || return 0
  grep -E "^$2=" "${manifest}" | tail -1 | cut -d= -f2-
}

# server_level_uri <uri> — strip the database path from a MongoDB URI.
# mongodump --oplog only works for full-instance dumps; a database in the URI
# path implies --db and makes mongodump reject --oplog.
server_level_uri() {
  local uri="$1"
  if [[ "${uri}" =~ ^(mongodb(\+srv)?://[^/?]+)(/[^?]*)?(\?.*)?$ ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[4]}"
  else
    echo "${uri}"
  fi
}

# latest_local_archive <dir> → newest archive in a directory (any supported naming).
latest_local_archive() {
  local dir="$1" pattern files=()
  for pattern in "${BACKUP_ARCHIVE_GLOBS[@]}"; do
    for f in "${dir}"/${pattern}; do
      [[ -f "${f}" ]] && files+=("${f}")
    done
  done
  [[ "${#files[@]}" -gt 0 ]] || return 0
  ls -t "${files[@]}" | head -1
}

# offsite_configured → exit 0 when at least one off-site target is configured.
offsite_configured() {
  [[ -n "${BACKUP_S3_URI:-}" || -n "${BACKUP_RCLONE_REMOTE:-}" ]]
}

_aws() {
  if [[ -n "${BACKUP_S3_ENDPOINT_URL:-}" ]]; then
    aws --endpoint-url "${BACKUP_S3_ENDPOINT_URL}" "$@"
  else
    aws "$@"
  fi
}

# upload_offsite <file>... — copy files to every configured off-site target and
# confirm each object exists afterwards.
upload_offsite() {
  local f name
  if [[ -n "${BACKUP_S3_URI:-}" ]]; then
    command -v aws >/dev/null 2>&1 || { _bc_log backup "aws CLI is not installed"; return 1; }
    for f in "$@"; do
      name="$(basename "${f}")"
      _aws s3 cp --only-show-errors "${f}" "${BACKUP_S3_URI%/}/${name}" || return 1
      _aws s3 ls "${BACKUP_S3_URI%/}/${name}" >/dev/null || { _bc_log backup "uploaded object ${name} not found in ${BACKUP_S3_URI}"; return 1; }
    done
  fi
  if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
    command -v rclone >/dev/null 2>&1 || { _bc_log backup "rclone is not installed"; return 1; }
    for f in "$@"; do
      name="$(basename "${f}")"
      rclone copyto "${f}" "${BACKUP_RCLONE_REMOTE%/}/${name}" || return 1
      rclone lsf "${BACKUP_RCLONE_REMOTE%/}/${name}" | grep -q . || { _bc_log backup "uploaded object ${name} not found in ${BACKUP_RCLONE_REMOTE}"; return 1; }
    done
  fi
}

# fetch_latest_offsite <dest_dir> → downloads the newest archive (+ manifest)
# from the first configured off-site target and prints the local archive path.
fetch_latest_offsite() {
  local dest="$1" name
  if [[ -n "${BACKUP_S3_URI:-}" ]]; then
    command -v aws >/dev/null 2>&1 || { _bc_log restore "aws CLI is not installed"; return 1; }
    # Timestamped names sort lexically in chronological order.
    name="$(_aws s3 ls "${BACKUP_S3_URI%/}/" | awk '{print $4}' | grep -E '\.archive\.gz(\.age|\.gpg)?$' | sort | tail -1)"
    [[ -n "${name}" ]] || { _bc_log restore "no archives found in ${BACKUP_S3_URI}"; return 1; }
    _aws s3 cp --only-show-errors "${BACKUP_S3_URI%/}/${name}" "${dest}/${name}" >&2 || return 1
    _aws s3 cp --only-show-errors "${BACKUP_S3_URI%/}/${name%%.*}.manifest" "${dest}/${name%%.*}.manifest" >&2 || true
  elif [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
    command -v rclone >/dev/null 2>&1 || { _bc_log restore "rclone is not installed"; return 1; }
    name="$(rclone lsf "${BACKUP_RCLONE_REMOTE%/}/" | grep -E '\.archive\.gz(\.age|\.gpg)?$' | sort | tail -1)"
    [[ -n "${name}" ]] || { _bc_log restore "no archives found in ${BACKUP_RCLONE_REMOTE}"; return 1; }
    rclone copyto "${BACKUP_RCLONE_REMOTE%/}/${name}" "${dest}/${name}" >&2 || return 1
    rclone copyto "${BACKUP_RCLONE_REMOTE%/}/${name%%.*}.manifest" "${dest}/${name%%.*}.manifest" >&2 || true
  else
    _bc_log restore "no off-site target configured"
    return 1
  fi
  echo "${dest}/${name}"
}

# verify_manifest_checksum <archive> — compare the archive against the sha256
# recorded at backup time (no-op when the manifest is absent).
verify_manifest_checksum() {
  local expected actual
  expected="$(manifest_get "$1" sha256)"
  [[ -n "${expected}" ]] || return 0
  actual="$(file_sha256 "$1")"
  if [[ "${expected}" != "${actual}" ]]; then
    _bc_log restore "checksum mismatch for $1 (manifest=${expected}, actual=${actual})"
    return 1
  fi
}
