'use strict';

const logger = require('./logger').child('StellarRetry');
const { withSpan } = require('../tracing');

const MAX_ATTEMPTS = parseInt(process.env.STELLAR_CALL_RETRY_ATTEMPTS, 10) || 3;
const BASE_DELAY   = parseInt(process.env.STELLAR_CALL_RETRY_DELAY_MS, 10) || 1000;
const MAX_DELAY    = 10000;

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

function getStatus(err) {
  return err.response?.status || err.response?.statusCode || err.status || err.statusCode;
}

function isTransient(err) {
  const s = getStatus(err);
  return NETWORK_CODES.has(err.code) || /timeout|network|socket hang up/i.test(err.message || '') || s === 429 || (s >= 500 && s < 600);
}

function classifyHorizonError(err, context = '') {
  const s = getStatus(err);
  // originalError is attached to every classified error so the raw
  // Horizon/axios failure — status, message, Horizon `extras`/result_codes —
  // is never fully discarded, even though the classified .status/.code/.message
  // are deliberately normalized for callers that branch on error type.
  if (s === 404) return Object.assign(new Error(`${context || 'Transaction'} not found on the Stellar network`), { code: 'NOT_FOUND', status: 404, originalError: err });
  if (s === 429 || (s >= 500 && s < 600) || NETWORK_CODES.has(err.code) || /timeout|network|socket hang up/i.test(err.message || ''))
    return Object.assign(new Error('Stellar Horizon is temporarily unavailable. Please retry shortly.'), { code: 'HORIZON_UNAVAILABLE', status: 503, originalError: err });
  if (err.code && err.status) return err;
  return Object.assign(new Error(err.message || 'Unexpected Stellar network error'), { code: 'STELLAR_NETWORK_ERROR', status: 502, originalError: err });
}

// Design decision: classifyHorizonError is applied HERE, inside
// withStellarRetry, for every caller — not left to each call site to
// remember. This was chosen after finding call sites had already drifted:
// some wrapped the result in classifyHorizonError themselves (stellarService's
// parseIncomingTransaction — and did so with a stale, unimported reference to
// classifyHorizonError, throwing a raw ReferenceError instead), while others
// (stellarService's verifyTransaction) documented classified error codes
// (NOT_FOUND, HORIZON_UNAVAILABLE) in their JSDoc but never actually produced
// them. Centralizing the classification here makes it structurally
// impossible for a call site to forget it, and every withStellarRetry call
// site in stellarService.js now relies on this rather than classifying
// itself. classifyHorizonError() is idempotent on an already-classified error
// (see its `err.code && err.status` passthrough), so this is safe even if a
// caller further up the stack also classifies defensively.
async function withStellarRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const baseDelay   = opts.baseDelay   || BASE_DELAY;
  const label       = opts.label       || 'StellarCall';
  const context     = opts.context     || label;

  // #1636: one span for the whole retry loop; each retry is a span event, and
  // the horizon.call child spans (horizonFailoverClient) show the endpoints.
  return withSpan(`stellar.${label}`, {
    'stellar.operation': label,
    'stellar.context': context,
    'stellar.tx_hash': opts.txHash,
    'stellar.max_attempts': maxAttempts,
  }, async (span) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      span.setAttribute('stellar.attempts', attempt);
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || attempt === maxAttempts) throw classifyHorizonError(err, context);
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), MAX_DELAY);
        const wait  = delay + Math.floor(Math.random() * delay * 0.3);
        span.addEvent('stellar.retry', { attempt, wait_ms: wait, error: err.message });
        logger.warn(`${label} attempt ${attempt}/${maxAttempts} failed — retrying in ${wait}ms`, { error: err.message });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  });
}

module.exports = { withStellarRetry, isTransient, classifyHorizonError };
