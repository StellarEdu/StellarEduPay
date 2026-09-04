'use strict';

/**
 * Parent contact PII encryption utilities — Issue #1480.
 *
 * Student.parentEmail / Student.parentPhone are encrypted at rest using
 * AES-256-GCM, the same pattern already used for payment memos (historical),
 * webhook secrets (webhookSecretEncryption.js), MFA secrets, and Stellar
 * signing keys. The key is derived from STUDENT_PII_ENCRYPTION_KEY (a
 * 64-character hex string / 32 bytes). When the env var is absent, encryption
 * is a no-op so local development without the key continues to work.
 *
 * The encrypted format (base64url) is:
 *   <12-byte IV> + <ciphertext> + <16-byte GCM auth tag>
 * Prefixed with "enc:" so plaintext and encrypted values are distinguishable.
 *
 * A separate deterministic SHA-256 hash of the normalized email is stored in
 * Student.parentEmailHash so exact-match lookups (e.g. opting a student out
 * after their parent email is added to the suppression list) keep working
 * without decrypting every record — the AES-GCM ciphertext itself uses a
 * random IV per value and is not matchable across records.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // bytes
const TAG_LENGTH = 16;      // bytes
const ENC_PREFIX = 'enc:';  // sentinel that distinguishes encrypted values

function _getKey() {
  const hex = process.env.STUDENT_PII_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      '[studentPiiEncryption] STUDENT_PII_ENCRYPTION_KEY must be a 64-character ' +
      'hex string (32 bytes). Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext value. Returns the value unchanged when encryption is
 * disabled or the value is already encrypted (idempotent).
 */
function encryptStudentPii(plaintext) {
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;

  const key = _getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, encrypted, tag]).toString('base64url');
  return `${ENC_PREFIX}${payload}`;
}

/**
 * Decrypt an encrypted value. Returns the value unchanged when encryption is
 * disabled, the value isn't encrypted, or decryption fails.
 */
function decryptStudentPii(value) {
  if (!value) return value;
  if (!value.startsWith(ENC_PREFIX)) return value;

  const key = _getKey();
  if (!key) return value;

  let buf;
  try {
    buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64url');
  } catch {
    return value;
  }
  if (buf.length < IV_LENGTH + 1 + TAG_LENGTH) return value;

  try {
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(buf.length - TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return value;
  }
}

/**
 * Deterministic blind-index hash for exact-match lookups on parentEmail
 * (e.g. cross-tenant suppression-list opt-out). Independent of whether
 * encryption is enabled, so lookups keep working before/after a key is
 * provisioned.
 */
function hashParentEmail(email) {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
  encryptStudentPii,
  decryptStudentPii,
  hashParentEmail,
};
