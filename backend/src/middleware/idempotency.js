'use strict';

const { deriveIdempotencyKey, fingerprintRequest } = require('../utils/idempotencyKey');
const idempotencyStore = require('../services/idempotencyStore');
const currencyConversionService = require('../services/currencyConversionService');

/**
 * Idempotency middleware.
 *
 * Expects an `Idempotency-Key` header on mutating requests and enforces
 * exactly-once semantics over a TTL window:
 *
 *  - Replay (same key, same body, request already completed) → the cached
 *    response is returned verbatim (same status, same body) EXCEPT for
 *    volatile fields (see `refreshVolatileFields` below), which are
 *    recomputed on every replay.
 *  - Key reuse with a DIFFERENT body → 422. Reusing a key for a different
 *    payload is a client bug; replaying the first response would be wrong and
 *    re-executing would violate idempotency, so we refuse it.
 *  - Concurrent in-flight duplicate (a first request with this key is still
 *    executing) → 409. The caller should retry after the first one finishes,
 *    at which point it replays the cached response.
 *  - Missing/blank header → 400.
 *
 * The canonical key is derived via the shared `deriveIdempotencyKey` util
 * (scoped by request path) and the request body is fingerprinted via
 * `fingerprintRequest`. State lives in the persistent `idempotencyStore`
 * (Mongo, optionally Redis-fronted), so all of the above hold after a restart
 * and across replicas.
 *
 * TTL semantics: records (and therefore replay/reuse protection) live for
 * IDEMPOTENCY_KEY_TTL_SECONDS (default 24h). A client retrying after the TTL
 * expires is treated as a brand-new request. In-flight reservations older than
 * IDEMPOTENCY_IN_FLIGHT_TTL_MS (default 30s) are considered abandoned and may be
 * taken over, so a crashed request never wedges a key.
 *
 * Usage: apply to individual POST routes that must be idempotent.
 */

/**
 * A 24h idempotency TTL is appropriate for replay/reuse protection but far too
 * long to freeze a currency-conversion rate: a cached body embedding
 * `localCurrency` (e.g. the payment verify response) would otherwise replay
 * whatever FX rate happened to be current at the moment of the FIRST call,
 * potentially showing a parent a stale converted amount hours or days later.
 *
 * Rather than giving currency-bearing records their own (still-arbitrary) short
 * TTL, we exclude `localCurrency` from the "frozen" part of the cache entirely:
 * every replay recomputes it fresh from the stored `amount`/`assetCode`, using
 * the currency-conversion service's own (much shorter) rate cache. A refresh
 * failure falls back to the originally cached value rather than breaking the
 * replay.
 */
async function refreshVolatileFields(body) {
  if (!body || typeof body !== 'object') return body;
  const localCurrency = body.localCurrency;
  if (!localCurrency || typeof localCurrency !== 'object' || !localCurrency.currency) {
    return body;
  }
  if (typeof body.amount !== 'number') return body;

  try {
    const fresh = await currencyConversionService.convertToLocalCurrency(
      body.amount,
      body.assetCode || 'XLM',
      localCurrency.currency
    );
    return {
      ...body,
      localCurrency: {
        amount: fresh.available ? fresh.localAmount : null,
        currency: fresh.currency,
        rate: fresh.rate,
        rateTimestamp: fresh.rateTimestamp,
        available: fresh.available,
      },
    };
  } catch (err) {
    const logger = require('../utils/logger').child('Idempotency');
    logger.warn('Failed to refresh currency rate on idempotent replay, serving cached value', {
      error: err.message,
    });
    return body;
  }
}

function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    return res.status(400).json({
      error: 'Idempotency-Key header is required for this request',
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  }

  const scope = req.path;
  const canonicalKey = deriveIdempotencyKey(rawKey, scope);
  const fingerprint = fingerprintRequest(req.body);

  // Decide what to do with an existing record for this key.
  async function resolveExisting(record) {
    if (!record) return null;
    if (record.state === 'completed') {
      if (record.requestFingerprint && record.requestFingerprint !== fingerprint) {
        res.status(422).json({
          error:
            'Idempotency-Key was already used with a different request body',
          code: 'IDEMPOTENCY_KEY_REUSE',
        });
        return 'handled';
      }
      const body = await refreshVolatileFields(record.responseBody);
      res.status(record.responseStatus).json(body);
      return 'handled';
    }
    // in_progress
    res.status(409).json({
      error: 'A request with this Idempotency-Key is already being processed',
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
    return 'handled';
  }

  idempotencyStore
    .getFull(canonicalKey)
    .then((record) => {
      // Fast path: a non-stale existing record fully decides the outcome.
      if (record) {
        const ageMs = Date.now() - record.createdAt.getTime();
        const staleInFlight =
          record.state === 'in_progress' && ageMs >= idempotencyStore.IN_FLIGHT_TTL_MS;
        if (!staleInFlight) {
          return resolveExisting(record);
        }
        // Stale in-flight reservation: fall through to reserve() which takes it over.
      }

      // Atomically claim the key. This is the race-safe arbiter: if two requests
      // reach here at once, exactly one reserves and the other gets the record.
      return idempotencyStore
        .reserve(canonicalKey, { scope, fingerprint })
        .then((reservation) => {
          if (!reservation.reserved) {
            return resolveExisting(reservation.record);
          }

          // We own the reservation. Intercept res.json to persist the outcome.
          const originalJson = res.json.bind(res);
          res.json = function (body) {
            if (res.statusCode < 500) {
              idempotencyStore
                  .complete(canonicalKey, {
                    scope,
                    responseStatus: res.statusCode,
                    responseBody: body,
                    fingerprint,
                  })
                  .catch((err) => {
                    const logger = require('../utils/logger').child('Idempotency');
                    logger.error('Failed to cache response', { error: err.message });
                  });
            } else {
              // 5xx is never cached — release the reservation so the client can retry.
              idempotencyStore.release(canonicalKey).catch(() => logger.debug('[Idempotency] release missed'));
            }
            return originalJson(body);
          };

          next();
        });
    })
    .catch((err) => {
      const logger = require('../utils/logger').child('Idempotency');
      logger.error('store operation failed', { error: err.message });
      // Fail open — let the request through rather than blocking the user.
      next();
    });
}

module.exports = idempotency;
