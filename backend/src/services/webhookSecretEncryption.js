'use strict';

/**
 * Webhook secret encryption utilities — Issue #75.
 *
 * School webhookSecret values are encrypted at rest using AES-256-GCM.
 * The encryption key is derived from WEBHOOK_SECRET_ENCRYPTION_KEY (a
 * 64-character hex string / 32 bytes). When the env var is absent the
 * functions fall back to no-op mode so the application starts cleanly in
 * development without the key set.
 *
 * The encrypted format (base64url) is:
 *   <12-byte IV> + <ciphertext> + <16-byte GCM auth tag>
 *
 * Prefixed with "enc:" so plaintext and encrypted values are distinguishable
 * at a glance (and for graceful migration).
 *
 * Key rotation: generate a new key, run migration 017 to re-encrypt, then
 * swap the env var. Decryption falls back to the old key if the new one
 * produces an auth-tag failure (planned — not yet implemented).
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // bytes
const TAG_LENGTH = 16;      // bytes
const ENC_PREFIX = 'enc:';  // sentinel that distinguishes encrypted values

function _getKey() {
  const hex = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      '[webhookSecretEncryption] WEBHOOK_SECRET_ENCRYPTION_KEY must be a ' +
      '64-character hex string (32 bytes). Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Returns true when webhook secret encryption is active.
 */
function isEncryptionEnabled() {
  return !!process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
}

/**
 * Encrypt a plaintext webhook secret.
 * Returns the encrypted value prefixed with "enc:", or the original value
 * unchanged when encryption is disabled.
 *
 * Idempotent: if the value is already encrypted (starts with "enc:"), it is
 * returned unchanged.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptWebhookSecret(plaintext) {
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext; // already encrypted

  const key = _getKey();
  if (!key) return plaintext; // encryption disabled — no-op

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, encrypted, tag]).toString('base64url');
  return `${ENC_PREFIX}${payload}`;
}

/**
 * Decrypt an encrypted webhook secret.
 * Returns the plaintext value, or the original value unchanged when:
 *   - encryption is disabled
 *   - the value does not carry the "enc:" prefix (already plaintext)
 *   - decryption fails (auth tag mismatch / wrong key) — value returned as-is
 *
 * @param {string} value
 * @returns {string}
 */
function decryptWebhookSecret(value) {
  if (!value) return value;
  if (!value.startsWith(ENC_PREFIX)) return value; // plaintext — passthrough

  const key = _getKey();
  if (!key) return value; // encryption disabled — return as-is

  let buf;
  try {
    buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64url');
  } catch {
    return value; // malformed — return as-is
  }

  if (buf.length < IV_LENGTH + 1 + TAG_LENGTH) return value; // too short

  try {
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(buf.length - TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Auth tag mismatch or wrong key — return as-is so the caller can handle it
    return value;
  }
}

/**
 * Returns true if a value is encrypted (carries the "enc:" prefix).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

module.exports = {
  encryptWebhookSecret,
  decryptWebhookSecret,
  isEncryptionEnabled,
  isEncrypted,
};
