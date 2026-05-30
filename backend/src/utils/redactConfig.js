'use strict';

/**
 * Redact sensitive fields from a config-like object before logging.
 * Any key matching SENSITIVE_KEYS is replaced with '[REDACTED]'.
 *
 * This module has no external dependencies so it can be required in tests
 * without mocking winston or any other backend-only package.
 */

const SENSITIVE_KEYS = new Set([
  'JWT_SECRET',
  'MEMO_ENCRYPTION_KEY',
  'WEBHOOK_SECRET',
  'MONGO_URI',
  'MONGODB_URI',
  'SMTP_PASS',
  'REDIS_PASSWORD',
]);

/**
 * Return a shallow copy of `cfg` with sensitive values replaced by '[REDACTED]'.
 * Non-object inputs are returned unchanged.
 *
 * @param {object} cfg
 * @returns {object}
 */
function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const safe = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (SENSITIVE_KEYS.has(key)) {
      safe[key] = value !== undefined ? '[REDACTED]' : undefined;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

module.exports = { redactConfig, SENSITIVE_KEYS };
