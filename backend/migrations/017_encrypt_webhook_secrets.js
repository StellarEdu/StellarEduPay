'use strict';

/**
 * Migration 017 — Encrypt existing plaintext webhookSecret values on School documents.
 *
 * Issue #75: queueWebhookRetry was storing signing secrets plaintext on
 * WebhookRetry documents. That field has been removed in this fix. Additionally,
 * the School.webhookSecret field was also stored as plaintext in MongoDB.
 *
 * This migration re-encrypts every school's webhookSecret using AES-256-GCM
 * via the WEBHOOK_SECRET_ENCRYPTION_KEY env var. It is idempotent: values
 * already encrypted (prefixed with "enc:") are skipped.
 *
 * Prerequisites:
 *   Set WEBHOOK_SECRET_ENCRYPTION_KEY to a 64-char hex string before running.
 *   If the key is not set, the migration is a no-op (logged as skipped).
 *
 * Rollback:
 *   The down() function strips the "enc:" prefix and re-decrypts all values
 *   back to plaintext. Only run down() if you are reverting the feature entirely.
 *
 * Also removes the 'secret' field from any WebhookRetry documents that still
 * have it persisted, replacing the sensitivity of that data with nothing.
 */

const crypto = require('crypto');

const VERSION = '017_encrypt_webhook_secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENC_PREFIX = 'enc:';

function _getKey() {
  const hex = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      '[Migration 017] WEBHOOK_SECRET_ENCRYPTION_KEY must be a 64-character hex string.'
    );
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

async function up() {
  const mongoose = require('mongoose');

  // ── 1. Encrypt School.webhookSecret values ──────────────────────────────
  const key = _getKey();
  if (!key) {
    console.log('[Migration 017] WEBHOOK_SECRET_ENCRYPTION_KEY is not set. Skipping encryption.');
    console.log('[Migration 017] Set the key and re-run to encrypt secrets at rest.');
  } else {
    const schools = mongoose.connection.collection('schools');
    const cursor = schools.find({ webhookSecret: { $exists: true, $ne: null } });
    let encrypted = 0;
    let skipped = 0;

    for await (const school of cursor) {
      if (typeof school.webhookSecret === 'string' && school.webhookSecret.startsWith(ENC_PREFIX)) {
        skipped++;
        continue; // already encrypted
      }
      const encryptedSecret = _encrypt(school.webhookSecret, key);
      await schools.updateOne(
        { _id: school._id },
        { $set: { webhookSecret: encryptedSecret } }
      );
      encrypted++;
    }

    console.log(
      `[Migration 017] School secrets: ${encrypted} encrypted, ${skipped} already encrypted.`
    );
  }

  // ── 2. Remove plaintext 'secret' field from WebhookRetry documents ────────
  const retries = mongoose.connection.collection('webhookretries');
  const removeResult = await retries.updateMany(
    { secret: { $exists: true } },
    { $unset: { secret: '' } }
  );
  if (removeResult.modifiedCount > 0) {
    console.log(
      `[Migration 017] Removed plaintext 'secret' field from ${removeResult.modifiedCount} WebhookRetry document(s).`
    );
  } else {
    console.log('[Migration 017] No WebhookRetry documents had a plaintext secret field.');
  }

  console.log('[Migration 017] Migration complete.');
}

async function down() {
  const mongoose = require('mongoose');
  const key = _getKey();

  if (!key) {
    console.log('[Migration 017] WEBHOOK_SECRET_ENCRYPTION_KEY is not set. Cannot decrypt.');
    return;
  }

  const schools = mongoose.connection.collection('schools');
  const cursor = schools.find({ webhookSecret: { $exists: true, $ne: null } });
  let decrypted = 0;

  for await (const school of cursor) {
    if (typeof school.webhookSecret !== 'string' || !school.webhookSecret.startsWith(ENC_PREFIX)) {
      continue; // already plaintext
    }
    const plaintext = _decrypt(school.webhookSecret, key);
    await schools.updateOne(
      { _id: school._id },
      { $set: { webhookSecret: plaintext } }
    );
    decrypted++;
  }

  console.log(`[Migration 017] Rolled back. Decrypted ${decrypted} school webhook secret(s).`);
}

module.exports = { version: VERSION, up, down };
