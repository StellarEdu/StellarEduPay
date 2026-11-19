'use strict';

/**
 * File-based secrets (`<NAME>_FILE`) — issue #1829.
 *
 * Docker Swarm / Compose `secrets:`, Kubernetes projected Secret volumes and
 * the official Postgres/Mongo images all deliver credentials as files. For every
 * key in SECRET_ENV_KEYS the process also accepts `<KEY>_FILE=/path/to/file`:
 *
 *   - the file is read at boot, trailing CR/LF is trimmed, and the value is
 *     written to process.env[KEY] before any other module reads it;
 *   - setting both `<KEY>` and `<KEY>_FILE` is a hard error, so a stale env var
 *     can never silently shadow a rotated file;
 *   - an empty or unreadable file is a hard error (fail closed).
 *
 * Resolution is idempotent: the first call does the work and later calls are
 * no-ops, so it is safe to call from both the app entry point and the config
 * module.
 */

const fs = require('fs');

const FILE_SUFFIX = '_FILE';

// Every secret the process reads from the environment. Keep in sync with
// docs/secrets.md and utils/redactConfig.js (which redacts the *_FILE paths).
const SECRET_ENV_KEYS = Object.freeze([
  'JWT_SECRET',
  'RECEIPT_SIGNATURE_SECRET',
  'ADMIN_PASSWORD',
  'ADMIN_PASSWORD_HASH',
  'STUDENT_PII_ENCRYPTION_KEY',
  'STUDENT_PII_ENCRYPTION_KEY_PREVIOUS',
  'WEBHOOK_SECRET_ENCRYPTION_KEY',
  'AUDIT_HMAC_KEY',
  'METRICS_BEARER_TOKEN',
  'SMTP_PASS',
  'SENDGRID_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'ANCHOR_PLATFORM_KEYPAIR',
  'REDIS_PASSWORD',
  'MONGO_URI',
]);

let resolved = false;

/**
 * Read a secret file and return its contents with trailing newlines removed.
 * Throws a descriptive error for empty or unreadable files.
 */
function readSecretFile(name, filePath, readFile = fs.readFileSync) {
  let raw;
  try {
    raw = readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[Secrets] ${name}_FILE could not be read (${err.code || err.message}).`);
  }
  const value = raw.replace(/\r?\n$/, '').trim();
  if (value.length === 0) {
    throw new Error(`[Secrets] ${name}_FILE points to an empty file.`);
  }
  return value;
}

/**
 * Resolve `<KEY>_FILE` references into `env[KEY]`.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {(path: string, enc: string) => string} [readFile=fs.readFileSync]
 * @returns {string[]} names of the keys that were populated from files
 */
function resolveFileSecrets(env = process.env, readFile = fs.readFileSync) {
  const isDefaultTarget = env === process.env && readFile === fs.readFileSync;
  if (isDefaultTarget && resolved) return [];

  const populated = [];
  for (const name of SECRET_ENV_KEYS) {
    const fileVar = `${name}${FILE_SUFFIX}`;
    const filePath = env[fileVar];
    if (filePath === undefined || filePath === '') continue;

    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(
        `[Secrets] Both ${name} and ${fileVar} are set. Provide only one of them.`,
      );
    }

    env[name] = readSecretFile(name, filePath, readFile);
    populated.push(name);
  }

  if (isDefaultTarget) resolved = true;
  return populated;
}

/** Test-only: forget the idempotency guard so a fresh process state can be simulated. */
function _resetForTests() {
  resolved = false;
}

module.exports = {
  SECRET_ENV_KEYS,
  FILE_SUFFIX,
  resolveFileSecrets,
  _resetForTests,
};
