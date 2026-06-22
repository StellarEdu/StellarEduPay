'use strict';

/**
 * Correlation ID helpers for tracing a payment across the async pipeline:
 * polling -> queue job -> processor -> webhook -> SSE.
 *
 * IDs are derived deterministically from txHash (sha256, truncated) rather
 * than randomly generated. This means any pipeline stage that has the
 * txHash can independently recompute the same correlationId even if an
 * upstream hop forgot to propagate it explicitly — there is no single point
 * of failure for the correlation chain.
 */

const crypto = require('crypto');

const PREFIX = 'corr_';

/**
 * Derive a correlationId from a transaction hash. Deterministic: the same
 * txHash always yields the same correlationId.
 */
function deriveCorrelationId(txHash) {
  if (!txHash) return generateCorrelationId();
  return `${PREFIX}${crypto.createHash('sha256').update(String(txHash)).digest('hex').slice(0, 16)}`;
}

/**
 * Generate a random correlationId for flows that have no txHash yet.
 */
function generateCorrelationId() {
  return `${PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Use an explicit correlationId if one was already propagated, otherwise
 * derive it fresh from txHash. Keeps the chain intact even across hops that
 * only carry txHash.
 */
function resolveCorrelationId(explicitCorrelationId, txHash) {
  return explicitCorrelationId || deriveCorrelationId(txHash);
}

module.exports = { deriveCorrelationId, generateCorrelationId, resolveCorrelationId };
