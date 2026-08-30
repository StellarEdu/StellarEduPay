'use strict';

/**
 * Signer Key Manager — issue #844
 *
 * Provides encrypted storage and retrieval of Stellar secret keys for school
 * wallets. Secret keys are NEVER stored in plaintext — every value written to
 * the database (or any other store) is AES-256-GCM encrypted under a master
 * key that lives exclusively in the environment.
 *
 * Threat model
 * ────────────
 *  • Database compromise → encrypted blobs only; master key is not in the DB.
 *  • Env compromise       → attacker can decrypt; rotate SIGNER_MASTER_KEY and
 *                           call re-encrypt() to migrate all records.
 *  • Memory disclosure    → secret key is held in memory only while a Keypair
 *                           is actively needed; it is not cached.
 *
 * Wire format (stored in schoolModel.encryptedSigningKey)
 * ────────────────────────────────────────────────────────
 *   base64( <12-byte IV> || <ciphertext> || <16-byte GCM auth tag> )
 *   Ciphertext = AES-256-GCM( masterKey, IV, plaintext=secretKey )
 *
 * Environment variables
 * ─────────────────────
 *   SIGNER_MASTER_KEY   64-char hex string (32 bytes). Used directly when
 *                       SIGNER_KEY_SOURCE is unset or 'env'. Generate with:
 *                         node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 *   SIGNER_KEY_SOURCE   'env' (default) | 'aws_secrets_manager' | 'http'
 *                       Selects where initializeMasterKey() fetches the key
 *                       from. Plain env vars expose key material in process
 *                       listings, `docker inspect`, and Kubernetes Secret
 *                       manifests — a dedicated secrets manager avoids that
 *                       and adds rotation + access auditing (issue #1386).
 *
 *   SIGNER_MASTER_KEY_SECRET_ID   Required when SIGNER_KEY_SOURCE=aws_secrets_manager.
 *                                 The AWS Secrets Manager secret name or ARN.
 *                                 The secret value may be the raw 64-char hex
 *                                 string, or JSON like {"SIGNER_MASTER_KEY":"<hex>"}.
 *   AWS_REGION                    Region for the Secrets Manager client
 *                                 (falls back to the SDK's default provider chain).
 *
 *   SIGNER_MASTER_KEY_HTTP_URL    Required when SIGNER_KEY_SOURCE=http. A
 *                                 generic secrets-provider endpoint (e.g. a
 *                                 Vault or GCP Secret Manager proxy) returning
 *                                 either the raw hex string or JSON like
 *                                 {"SIGNER_MASTER_KEY":"<hex>"} / {"key":"<hex>"}.
 *   SIGNER_MASTER_KEY_HTTP_TOKEN  Optional bearer token sent as
 *                                 `Authorization: Bearer <token>`.
 *
 * Usage
 * ─────
 *   const { initializeMasterKey, encryptSecretKey, decryptSecretKey, getKeypair } = require('./signerKeyManager');
 *
 *   // Once at server startup, before any signing operation:
 *   await initializeMasterKey();
 *
 *   // When onboarding a school:
 *   const blob = encryptSecretKey('SXXXXX...your-stellar-secret...');
 *   await School.updateOne({ schoolId }, { encryptedSigningKey: blob });
 *
 *   // When submitting a transaction on behalf of a school:
 *   const keypair = getKeypair(school.encryptedSigningKey);
 *   const mgr = new StellarTransactionManager({ signingKeypair: keypair });
 */

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_LENGTH = 64; // 32 bytes
const HTTP_FETCH_TIMEOUT_MS = 5000;

// Populated by initializeMasterKey() when SIGNER_KEY_SOURCE names a secrets
// provider. Held in memory only — never written back to process.env or disk —
// and takes precedence over SIGNER_MASTER_KEY so callers that never invoke
// initializeMasterKey() keep working exactly as before (env-var default).
let _cachedMasterKeyHex = null;

function _validateHex(hex, label) {
  if (typeof hex !== 'string' || hex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`[signerKeyManager] ${label} must be a ${KEY_HEX_LENGTH}-character hex string (32 bytes).`);
  }
}

// ── Master key loading ────────────────────────────────────────────────────────

/**
 * Load and validate the master encryption key — from the in-memory cache
 * populated by initializeMasterKey() when a secrets provider is configured,
 * or from SIGNER_MASTER_KEY otherwise. Throws a clear error rather than
 * silently returning null — a missing key means any operation requiring
 * signing is impossible and should fail loudly.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function getMasterKey() {
  const hex = _cachedMasterKeyHex || process.env.SIGNER_MASTER_KEY;
  if (!hex) {
    throw new Error(
      '[signerKeyManager] No signing master key available. Set SIGNER_MASTER_KEY directly, ' +
      'or configure SIGNER_KEY_SOURCE + call initializeMasterKey() at startup. ' +
      'Generate a key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  _validateHex(hex, _cachedMasterKeyHex ? 'The resolved signing master key' : 'SIGNER_MASTER_KEY');
  return Buffer.from(hex, 'hex');
}

/**
 * Fetch the master key from the configured secrets provider and cache it in
 * memory for getMasterKey() to use. Call once at server startup, before any
 * signing operation. A no-op when SIGNER_KEY_SOURCE is unset or 'env' — in
 * that case getMasterKey() reads SIGNER_MASTER_KEY directly, as before.
 *
 * Throws on misconfiguration or a provider error so a broken secrets source
 * fails loudly at boot rather than on the first payment signing attempt.
 *
 * @returns {Promise<void>}
 */
async function initializeMasterKey() {
  const source = (process.env.SIGNER_KEY_SOURCE || 'env').toLowerCase();

  if (source === 'env') {
    return;
  }

  if (source === 'aws_secrets_manager') {
    const secretId = process.env.SIGNER_MASTER_KEY_SECRET_ID;
    if (!secretId) {
      throw new Error('[signerKeyManager] SIGNER_MASTER_KEY_SECRET_ID is required when SIGNER_KEY_SOURCE=aws_secrets_manager.');
    }
    // Required lazily so deployments that don't use AWS never need the
    // package installed or its credential chain configured.
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {});
    let response;
    try {
      response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    } catch (err) {
      throw new Error(`[signerKeyManager] Failed to fetch secret "${secretId}" from AWS Secrets Manager: ${err.message}`);
    }
    _cachedMasterKeyHex = _extractHexFromRaw(response.SecretString);
  } else if (source === 'http') {
    const url = process.env.SIGNER_MASTER_KEY_HTTP_URL;
    if (!url) {
      throw new Error('[signerKeyManager] SIGNER_MASTER_KEY_HTTP_URL is required when SIGNER_KEY_SOURCE=http.');
    }
    const headers = {};
    if (process.env.SIGNER_MASTER_KEY_HTTP_TOKEN) {
      headers.Authorization = `Bearer ${process.env.SIGNER_MASTER_KEY_HTTP_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
    let raw;
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      raw = await resp.text();
    } catch (err) {
      throw new Error(`[signerKeyManager] Failed to fetch signing key from ${url}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
    _cachedMasterKeyHex = _extractHexFromRaw(raw);
  } else {
    throw new Error(`[signerKeyManager] Unknown SIGNER_KEY_SOURCE "${source}". Use 'env', 'aws_secrets_manager', or 'http'.`);
  }

  _validateHex(_cachedMasterKeyHex, `The key returned by SIGNER_KEY_SOURCE=${source}`);
}

/**
 * A secrets provider may return the hex key as a bare string or wrapped in
 * JSON (e.g. {"SIGNER_MASTER_KEY": "<hex>"} or {"key": "<hex>"}).
 */
function _extractHexFromRaw(raw) {
  const trimmed = (raw || '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return String(parsed.SIGNER_MASTER_KEY || parsed.key || '').trim();
    }
  } catch {
    // Not JSON — treat the whole response as the raw hex value.
  }
  return trimmed;
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt a Stellar secret key for safe storage.
 *
 * @param {string} secretKey  Stellar secret key (S...).
 * @returns {string}          base64-encoded encrypted blob.
 * @throws {Error} if secretKey is not a valid Stellar secret key.
 */
function encryptSecretKey(secretKey) {
  if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
    throw new Error('[signerKeyManager] Provided value is not a valid Stellar secret key.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

  const ciphertext = Buffer.concat([
    cipher.update(secretKey, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Layout: IV || ciphertext || tag
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

/**
 * Decrypt an encrypted secret key blob produced by encryptSecretKey().
 *
 * @param {string} encryptedBlob  base64-encoded encrypted blob from the database.
 * @returns {string}              Plaintext Stellar secret key (S...).
 * @throws {Error} on decryption failure (wrong key, tampered ciphertext).
 */
function decryptSecretKey(encryptedBlob) {
  if (!encryptedBlob || typeof encryptedBlob !== 'string') {
    throw new Error('[signerKeyManager] encryptedBlob must be a non-empty string.');
  }

  let buf;
  try {
    buf = Buffer.from(encryptedBlob, 'base64');
  } catch {
    throw new Error('[signerKeyManager] encryptedBlob is not valid base64.');
  }

  // Minimum length: IV (12) + 1 byte ciphertext + tag (16)
  const minLength = IV_BYTES + 1 + TAG_BYTES;
  if (buf.length < minLength) {
    throw new Error(
      `[signerKeyManager] encryptedBlob is too short (${buf.length} bytes, expected ≥ ${minLength}).`,
    );
  }

  const key = getMasterKey();
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  let secretKey;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    secretKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    throw new Error(
      '[signerKeyManager] Decryption failed — wrong master key or tampered ciphertext.',
    );
  }

  if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
    throw new Error(
      '[signerKeyManager] Decrypted value is not a valid Stellar secret key. ' +
      'The master key may be wrong or the blob may be corrupted.',
    );
  }

  return secretKey;
}

// ── Keypair access ────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted blob and return a Stellar Keypair ready for signing.
 * The returned Keypair holds the secret key in memory; callers should discard
 * the reference as soon as signing is complete.
 *
 * @param {string} encryptedBlob  Encrypted secret key from the DB.
 * @returns {import('@stellar/stellar-sdk').Keypair}
 */
function getKeypair(encryptedBlob) {
  const secretKey = decryptSecretKey(encryptedBlob);
  return Keypair.fromSecret(secretKey);
}

// ── Re-encryption (key rotation) ─────────────────────────────────────────────

/**
 * Re-encrypt a blob using the current SIGNER_MASTER_KEY after a key rotation.
 *
 * During rotation:
 *  1. Set SIGNER_MASTER_KEY_OLD=<old key> and SIGNER_MASTER_KEY=<new key>.
 *  2. Call reEncryptSecretKey(blob) for each school's encryptedSigningKey.
 *  3. Persist the returned new blob.
 *  4. Remove SIGNER_MASTER_KEY_OLD once all records are migrated.
 *
 * @param {string} oldEncryptedBlob  Blob encrypted under the OLD key.
 * @returns {string}                 Blob encrypted under the CURRENT key.
 */
function reEncryptSecretKey(oldEncryptedBlob) {
  const oldKeyHex = process.env.SIGNER_MASTER_KEY_OLD;
  if (!oldKeyHex) {
    throw new Error(
      '[signerKeyManager] SIGNER_MASTER_KEY_OLD must be set for key rotation. ' +
      'Set it to the previous SIGNER_MASTER_KEY value.',
    );
  }
  if (oldKeyHex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(oldKeyHex)) {
    throw new Error(
      `[signerKeyManager] SIGNER_MASTER_KEY_OLD must be a ${KEY_HEX_LENGTH}-character hex string.`,
    );
  }

  // Temporarily override to decrypt with old key. Also clears the secrets-
  // manager cache so getMasterKey() falls through to the env var below —
  // otherwise a cached key would take precedence and this override would be
  // silently ignored (see getMasterKey()).
  const originalEnv = process.env.SIGNER_MASTER_KEY;
  const originalCache = _cachedMasterKeyHex;
  process.env.SIGNER_MASTER_KEY = oldKeyHex;
  _cachedMasterKeyHex = null;
  let secretKey;
  try {
    secretKey = decryptSecretKey(oldEncryptedBlob);
  } finally {
    process.env.SIGNER_MASTER_KEY = originalEnv;
    _cachedMasterKeyHex = originalCache;
  }

  return encryptSecretKey(secretKey);
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Returns true when a master key is available — either resolved from a
 * secrets provider via initializeMasterKey(), or present in SIGNER_MASTER_KEY.
 * Use this for health checks — avoids throwing.
 *
 * @returns {boolean}
 */
function isMasterKeyConfigured() {
  const hex = _cachedMasterKeyHex || process.env.SIGNER_MASTER_KEY;
  return (
    typeof hex === 'string' &&
    hex.length === KEY_HEX_LENGTH &&
    /^[0-9a-fA-F]+$/.test(hex)
  );
}

module.exports = {
  initializeMasterKey,
  encryptSecretKey,
  decryptSecretKey,
  getKeypair,
  reEncryptSecretKey,
  isMasterKeyConfigured,
};
