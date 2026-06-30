'use strict';

/**
 * Shared retry contract (Issue #81).
 *
 * The two retry backends — the Redis/BullMQ backend (bullMQRetryService) and the
 * MongoDB fallback (retryService) — must classify failures identically so a
 * transaction that is retryable in dev is retryable in prod and vice versa.
 *
 * This module is the single source of truth for that classification. Both
 * backends import it; the shared contract test (tests/retryBackendContract.test.js)
 * asserts they agree.
 *
 * Guarantee differences that CANNOT be unified (durability, ordering, rate-limit
 * scope) are documented in docs/retry-backends.md, not here.
 */

// Errors that will never succeed on retry — fail straight to the dead-letter
// queue rather than wasting attempts.
const PERMANENT_ERROR_CODES = [
  'TX_FAILED',
  'MISSING_MEMO',
  'INVALID_DESTINATION',
  'UNSUPPORTED_ASSET',
  'DUPLICATE_TX',
  'INVALID_TRANSACTION_HASH',
  'TRANSACTION_NOT_FOUND',
];

// Errors that are worth retrying with backoff (network/transient).
const TRANSIENT_ERROR_CODES = [
  'STELLAR_NETWORK_ERROR',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'NETWORK_ERROR',
  'SOCKET_TIMEOUT',
  'REQUEST_TIMEOUT',
  'HORIZON_UNAVAILABLE',
];

const TRANSIENT_MESSAGE_PATTERNS = [
  /network/i,
  /timeout/i,
  /connection/i,
  /unavailable/i,
  /temporary/i,
];

/**
 * Classify an error for the retry decision.
 * @param {{code?: string, message?: string}} error
 * @returns {'permanent'|'transient'|'unknown'}
 */
function classifyError(error) {
  if (!error) return 'unknown';
  const code = error.code || '';
  const message = error.message || '';

  if (PERMANENT_ERROR_CODES.includes(code)) return 'permanent';
  if (TRANSIENT_ERROR_CODES.includes(code)) return 'transient';
  if (TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(message))) return 'transient';
  return 'unknown';
}

/** Permanent errors must NOT be retried. */
function isPermanent(error) {
  return classifyError(error) === 'permanent';
}

module.exports = {
  PERMANENT_ERROR_CODES,
  TRANSIENT_ERROR_CODES,
  classifyError,
  isPermanent,
};
