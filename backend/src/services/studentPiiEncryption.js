'use strict';

/**
 * Parent contact PII encryption utilities — Issue #1480.
 *
 * Student.parentEmail / Student.parentPhone are encrypted at rest using
 * AES-256-GCM, the same pattern already used for payment memos (historical),
 * webhook secrets (webhookSecretEncryption.js), MFA secrets, and Stellar
 * signing keys. The key is derived from STUDENT_PII_ENCRYPTION_KEY (a
 * 64-character hex string / 32 bytes). When the env var is absent, encryption
 * is a no-op only when ALLOW_PLAINTEXT_PII=true is set outside production;
 * in production a missing key is a hard error (see config/index.js).
 *
 * Rotation: STUDENT_PII_ENCRYPTION_KEY_PREVIOUS may hold the previous key.
 * Decryption falls back to it when the current key fails, mirroring
 * webhookSecretEncryption.js.
 *
 * The encrypted format (hex) is:
 *   Hex is used rather than base64url because parentEmail has a lowercase
 *   setter in studentModel.js, which would corrupt any uppercase base64url
 *   characters and make the ciphertext undecryptable (#1787).
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

function _parseKey(hex, name) {
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `[studentPiiEncryption] ${name} must be a 64-character ` +
      'hex string (32 bytes). Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function _getKey() {
  return _parseKey(process.env.STUDENT_PII_ENCRYPTION_KEY, 'STUDENT_PII_ENCRYPTION_KEY');
}

function _getPreviousKey() {
  return _parseKey(
    process.env.STUDENT_PII_ENCRYPTION_KEY_PREVIOUS,
    'STUDENT_PII_ENCRYPTION_KEY_PREVIOUS'
  );
}

/**
 * Whether PII encryption is active. In production a missing key is an error
 * (unless ALLOW_PLAINTEXT_PII=true is explicitly set); outside production a
 * missing key simply disables encryption.
 */
function isEncryptionEnabled() {
  const key = _getKey();
  if (key) return true;
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PLAINTEXT_PII !== 'true') {
    throw new Error(
      '[studentPiiEncryption] STUDENT_PII_ENCRYPTION_KEY is required in production. ' +
      'Set ALLOW_PLAINTEXT_PII=true only for non-production use.'
    );
  }
  return false;
}

/**
 * Encrypt a plaintext value. Returns the value unchanged when encryption is
 * disabled or the value is already encrypted (idempotent).
 */
function encryptStudentPii(plaintext) {
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;

  const key = _getKey();
  if (!key) {
    isEncryptionEnabled(); // throws in production without an explicit escape hatch
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, encrypted, tag]).toString('hex');
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
  if (!key) {
    isEncryptionEnabled(); // throws in production without an explicit escape hatch
    return value;
  }

  let buf;
  try {
    buf = Buffer.from(value.slice(ENC_PREFIX.length), 'hex');
  } catch {
    return value;
  }
  if (buf.length < IV_LENGTH + 1 + TAG_LENGTH) return value;

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

  const keys = [key];
  const previousKey = _getPreviousKey();
  if (previousKey) keys.push(previousKey);

  for (const candidate of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, candidate, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // try the next key (e.g. previous key during rotation)
    }
  }

  return value;
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
  isEncryptionEnabled,
};
