'use strict';

/**
 * Migration 029 — Encrypt existing plaintext Student.parentEmail /
 * Student.parentPhone values and backfill Student.parentEmailHash.
 *
 * Issue #1480: parent contact PII was stored in plaintext, unlike every
 * other sensitive field in the schema (payment memos, webhook secrets, MFA
 * secrets, Stellar signing keys). This migration re-encrypts every student's
 * parentEmail/parentPhone using AES-256-GCM via the STUDENT_PII_ENCRYPTION_KEY
 * env var, following the same pattern as migration 021 (webhook secrets).
 * It also populates parentEmailHash, a deterministic blind-index hash used
 * for exact-match lookups (e.g. suppression-list opt-out) that the random-IV
 * ciphertext can no longer support directly.
 *
 * It is idempotent: values already encrypted (prefixed with "enc:") are
 * skipped, and parentEmailHash is (re)computed from the plaintext each run.
 *
 * Prerequisites:
 *   Set STUDENT_PII_ENCRYPTION_KEY to a 64-char hex string before running.
 *   If the key is not set, the migration only backfills parentEmailHash
 *   (which doesn't depend on the key) and skips encryption.
 *
 * Rollback:
 *   down() strips the "enc:" prefix and re-decrypts all values back to
 *   plaintext. Only run it if you are reverting the feature entirely.
 */

const crypto = require('crypto');

const VERSION = '029_encrypt_student_pii';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:';

function _getKey() {
  const hex = process.env.STUDENT_PII_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('[Migration 029] STUDENT_PII_ENCRYPTION_KEY must be a 64-character hex string.');
  }
  return Buffer.from(hex, 'hex');
}

function _encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${Buffer.concat([iv, encrypted, tag]).toString('base64url')}`;
}

function _decrypt(value, key) {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64url');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function _hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

async function up() {
  const mongoose = require('mongoose');
  const key = _getKey();
  if (!key) {
    console.log('[Migration 029] STUDENT_PII_ENCRYPTION_KEY is not set. Only backfilling parentEmailHash.');
  }

  const students = mongoose.connection.collection('students');
  const cursor = students.find({ $or: [{ parentEmail: { $ne: null } }, { parentPhone: { $ne: null } }] });

  let updated = 0;
  let skipped = 0;

  for await (const student of cursor) {
    const set = {};

    if (typeof student.parentEmail === 'string' && student.parentEmail.length > 0) {
      const isEncrypted = student.parentEmail.startsWith(ENC_PREFIX);
      const plaintext = isEncrypted && key ? _decrypt(student.parentEmail, key) : student.parentEmail;
      set.parentEmailHash = _hashEmail(plaintext);
      if (key && !isEncrypted) set.parentEmail = _encrypt(student.parentEmail, key);
    }

    if (typeof student.parentPhone === 'string' && student.parentPhone.length > 0) {
      const isEncrypted = student.parentPhone.startsWith(ENC_PREFIX);
      if (key && !isEncrypted) set.parentPhone = _encrypt(student.parentPhone, key);
    }

    if (Object.keys(set).length > 0) {
      await students.updateOne({ _id: student._id }, { $set: set });
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`[Migration 029] Students updated: ${updated}, skipped (already encrypted / no PII): ${skipped}.`);
}

async function down() {
  const mongoose = require('mongoose');
  const key = _getKey();
  if (!key) {
    console.log('[Migration 029] STUDENT_PII_ENCRYPTION_KEY is not set. Cannot decrypt.');
    return;
  }

  const students = mongoose.connection.collection('students');
  const cursor = students.find({ $or: [{ parentEmail: { $ne: null } }, { parentPhone: { $ne: null } }] });

  let decrypted = 0;
  for await (const student of cursor) {
    const set = {};
    if (typeof student.parentEmail === 'string' && student.parentEmail.startsWith(ENC_PREFIX)) {
      set.parentEmail = _decrypt(student.parentEmail, key);
    }
    if (typeof student.parentPhone === 'string' && student.parentPhone.startsWith(ENC_PREFIX)) {
      set.parentPhone = _decrypt(student.parentPhone, key);
    }
    if (Object.keys(set).length > 0) {
      await students.updateOne({ _id: student._id }, { $set: set, $unset: { parentEmailHash: '' } });
      decrypted++;
    }
  }

  console.log(`[Migration 029] Rolled back. Decrypted ${decrypted} student record(s).`);
}

module.exports = { version: VERSION, up, down };
