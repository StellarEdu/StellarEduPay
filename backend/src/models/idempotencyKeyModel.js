'use strict';

const mongoose = require('mongoose');

// TTL in seconds for idempotency key records.
// Configurable via IDEMPOTENCY_KEY_TTL_SECONDS (default: 86400 = 24 hours).
// MongoDB's TTL index will automatically delete documents after this period.
const TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS || '86400', 10);

/**
 * Persistent idempotency store — the single source of truth for whether a
 * logical request has already been processed. Keyed by the canonical key
 * produced by `utils/idempotencyKey.deriveIdempotencyKey`, which already folds
 * the operation scope into the hash, so the canonical `key` alone is unique.
 *
 * Records survive process restarts and are shared across replicas, so a request
 * replayed after a deploy (or hitting a second replica) is still recognized as
 * a duplicate.
 *
 * TTL index automatically purges records after IDEMPOTENCY_KEY_TTL_SECONDS.
 */
const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  // Informational namespace for the canonical key (e.g. a request path or
  // 'payment-processor'). The scope is already baked into `key`; this is kept
  // for debuggability and is not part of the lookup.
  scope: { type: String, default: '' },
  // Lifecycle of the record:
  //   in_progress — a request is currently executing under this key. A concurrent
  //                 duplicate that finds an in_progress record is rejected with 409
  //                 (rather than double-executing) until the first request finishes.
  //   completed   — the request finished and `responseStatus`/`responseBody` hold the
  //                 cached result to replay.
  // Defaults to 'completed' so records written directly via the store's set()
  // (e.g. the payment processor) behave exactly as before.
  state: { type: String, enum: ['in_progress', 'completed'], default: 'completed' },
  // sha256 fingerprint of the canonicalized request body. Used to detect the
  // same key being replayed with a *different* body (answered with 422). Null
  // for records written without a body fingerprint (back-compat).
  requestFingerprint: { type: String, default: null },
  // Not required: an in_progress reservation has no response yet.
  responseStatus: { type: Number, default: null },
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  // Schema version of the cached response. When the application version changes
  // (e.g. a migration adds a required field to the response), a stale response
  // with a different schemaVersion is evicted and the request is reprocessed.
  // Derived from the application package.json version.
  schemaVersion: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: TTL_SECONDS },
});

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
module.exports.TTL_SECONDS = TTL_SECONDS;
