'use strict';

/**
 * Persistent idempotency store — the single source of truth for idempotency
 * decisions across the app.
 *
 * Backing: MongoDB (`idempotencyKeyModel`) is authoritative and durable, so a
 * replayed request is recognized as a duplicate even after a process restart or
 * on a different replica. An OPTIONAL Redis layer sits in front as a
 * read-through cache to avoid a Mongo round-trip on the hot path; it is never
 * the source of truth. When REDIS_HOST is unset, the store degrades to
 * Mongo-only, which is fully correct (just one extra query per lookup).
 *
 * All keys passed in must already be the canonical key produced by
 * `utils/idempotencyKey.deriveIdempotencyKey`.
 */

const IdempotencyKey = require('../models/idempotencyKeyModel');
const logger = require('../utils/logger').child('IdempotencyStore');

const TTL_SECONDS = IdempotencyKey.TTL_SECONDS;
const REDIS_PREFIX = 'idem:';

// Application schema version derived from package.json version
const APP_SCHEMA_VERSION = require('../../package.json').version;

// How long an `in_progress` reservation is honored before it is considered
// abandoned (e.g. the owning process crashed mid-request). After this window a
// new request may take over the reservation and re-execute, rather than being
// stuck behind a dead in-flight record until the 24h TTL purges it.
const IN_FLIGHT_TTL_MS = parseInt(
  process.env.IDEMPOTENCY_IN_FLIGHT_TTL_MS || '30000',
  10
);

const redisEnabled = Boolean(process.env.REDIS_HOST);

let redis = null;
if (redisEnabled) {
  const Redis = require('ioredis');
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => logger.error('Redis idempotency client error', { error: err.message }));
  redis.connect().catch((err) =>
    logger.error('Redis idempotency client connect failed', { error: err.message })
  );
}

async function redisGet(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(REDIS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('Redis idempotency read failed, falling back to Mongo', { error: err.message });
    return null;
  }
}

async function redisSet(key, record) {
  if (!redis) return;
  try {
    await redis.set(REDIS_PREFIX + key, JSON.stringify(record), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn('Redis idempotency write failed (non-fatal)', { error: err.message });
  }
}

/**
 * Look up a previously stored idempotency record by canonical key.
 * Checks Redis first (if enabled), then Mongo; populates Redis on a Mongo hit.
 *
 * @param {string} key canonical idempotency key
 * @returns {Promise<{responseStatus:number, responseBody:*, scope:string}|null>}
 */
async function get(key) {
  if (!key) return null;

  const cached = await redisGet(key);
  if (cached) {
    // Check if cached version matches current schema version
    if (cached.schemaVersion && cached.schemaVersion !== APP_SCHEMA_VERSION) {
      logger.info('Evicting stale cached response due to schema version mismatch', { key, cached: cached.schemaVersion, current: APP_SCHEMA_VERSION });
      // Evict stale entry by deleting from both Redis and Mongo
      try {
        await IdempotencyKey.deleteOne({ key });
      } catch (err) {
        logger.warn('Failed to evict stale idempotency record', { error: err.message });
      }
      return null;
    }
    return cached;
  }

  const record = await IdempotencyKey.findOne({ key }).lean();
  if (!record) return null;

  // Check if stored version matches current schema version
  if (record.schemaVersion && record.schemaVersion !== APP_SCHEMA_VERSION) {
    logger.info('Evicting stale stored response due to schema version mismatch', { key, stored: record.schemaVersion, current: APP_SCHEMA_VERSION });
    // Evict stale entry
    try {
      await IdempotencyKey.deleteOne({ key });
    } catch (err) {
      logger.warn('Failed to evict stale idempotency record', { error: err.message });
    }
    return null;
  }

  const result = {
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    scope: record.scope || '',
    schemaVersion: record.schemaVersion,
  };

  // Read-through: warm Redis for subsequent lookups.
  await redisSet(key, result);
  return result;
}

/**
 * Persist an idempotency record. Mongo is written first (source of truth),
 * then Redis is warmed. A duplicate-key race (another request won) is treated
 * as success — the stored result is equivalent.
 *
 * @param {string} key canonical idempotency key
 * @param {{responseStatus:number, responseBody:*, scope?:string}} record
 * @returns {Promise<void>}
 */
async function set(key, record) {
  if (!key) return;

  const doc = {
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    scope: record.scope || '',
    schemaVersion: APP_SCHEMA_VERSION,
  };

  try {
    await IdempotencyKey.create({ key, ...doc });
  } catch (err) {
    if (err.code !== 11000) {
      logger.error('Failed to persist idempotency record', { error: err.message });
      throw err;
    }
    // Duplicate key — another request already persisted this result. Fine.
  }

  await redisSet(key, doc);
}

/**
 * Read the FULL record for a canonical key, including lifecycle state, request
 * fingerprint, and createdAt. Unlike `get()` (which returns only the cached
 * response and is kept response-shaped for the payment processor), this is what
 * the HTTP idempotency middleware uses to make 200/409/422 decisions.
 *
 * @param {string} key canonical idempotency key
 * @returns {Promise<{state:string, requestFingerprint:string|null, responseStatus:number|null, responseBody:*, scope:string, createdAt:Date}|null>}
 */
async function getFull(key) {
  if (!key) return null;

  // Redis only ever caches completed results (warmed by set()/complete()), so a
  // hit is authoritative for the completed case and avoids a Mongo round-trip.
  const cached = await redisGet(key);
  if (cached && cached.state === 'completed') {
    // Check if cached version matches current schema version
    if (cached.schemaVersion && cached.schemaVersion !== APP_SCHEMA_VERSION) {
      logger.info('Evicting stale cached entry due to schema version mismatch', { key, cached: cached.schemaVersion, current: APP_SCHEMA_VERSION });
      try {
        await IdempotencyKey.deleteOne({ key });
      } catch (err) {
        logger.warn('Failed to evict stale idempotency record', { error: err.message });
      }
      return null;
    }
    return {
      state: 'completed',
      requestFingerprint: cached.requestFingerprint || null,
      responseStatus: cached.responseStatus,
      responseBody: cached.responseBody,
      scope: cached.scope || '',
      createdAt: cached.createdAt ? new Date(cached.createdAt) : new Date(),
    };
  }

  const record = await IdempotencyKey.findOne({ key }).lean();
  if (!record) return null;

  // Check if stored version matches current schema version
  if (record.schemaVersion && record.schemaVersion !== APP_SCHEMA_VERSION) {
    logger.info('Evicting stale stored entry due to schema version mismatch', { key, stored: record.schemaVersion, current: APP_SCHEMA_VERSION });
    try {
      await IdempotencyKey.deleteOne({ key });
    } catch (err) {
      logger.warn('Failed to evict stale idempotency record', { error: err.message });
    }
    return null;
  }

  return {
    state: record.state || 'completed',
    requestFingerprint: record.requestFingerprint || null,
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    scope: record.scope || '',
    createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
  };
}

/**
 * Atomically claim a key for an in-flight request. The unique index on `key`
 * makes this a compare-and-set: exactly one concurrent request wins.
 *
 *  - { reserved: true }                 — caller owns the reservation; proceed.
 *  - { reserved: false, record }        — another request already holds/holds-the
 *                                         result for this key; caller should 409
 *                                         (in_progress) or replay/422 (completed).
 *
 * A stale in_progress reservation (older than IN_FLIGHT_TTL_MS) is taken over
 * atomically so a crashed request never wedges the key.
 *
 * @param {string} key canonical idempotency key
 * @param {{scope?:string, fingerprint?:string|null}} opts
 */
async function reserve(key, { scope = '', fingerprint = null } = {}) {
  if (!key) return { reserved: false, record: null };

  try {
    await IdempotencyKey.create({
      key,
      scope,
      state: 'in_progress',
      requestFingerprint: fingerprint,
      responseStatus: null,
      responseBody: null,
    });
    return { reserved: true };
  } catch (err) {
    if (err.code !== 11000) {
      logger.error('Failed to reserve idempotency key', { error: err.message });
      throw err;
    }
  }

  // Key already exists — inspect it.
  const existing = await getFull(key);
  if (!existing) {
    // Raced with a TTL purge between create and read; one more attempt.
    try {
      await IdempotencyKey.create({
        key,
        scope,
        state: 'in_progress',
        requestFingerprint: fingerprint,
        responseStatus: null,
        responseBody: null,
      });
      return { reserved: true };
    } catch (_) {
      return { reserved: false, record: await getFull(key) };
    }
  }

  if (existing.state === 'in_progress') {
    const age = Date.now() - existing.createdAt.getTime();
    if (age >= IN_FLIGHT_TTL_MS) {
      // Stale reservation — take it over atomically. The `state: in_progress`
      // guard ensures we don't clobber a record that just completed.
      const taken = await IdempotencyKey.findOneAndUpdate(
        { key, state: 'in_progress' },
        { $set: { scope, requestFingerprint: fingerprint, createdAt: new Date() } },
        { new: true }
      );
      if (taken) return { reserved: true };
      return { reserved: false, record: await getFull(key) };
    }
  }

  return { reserved: false, record: existing };
}

/**
 * Finalize a previously reserved key with the request's response, flipping it to
 * `completed`. Upserts so it is also correct if no reservation existed.
 *
 * @param {string} key canonical idempotency key
 * @param {{scope?:string, responseStatus:number, responseBody:*, fingerprint?:string|null}} record
 */
async function complete(key, record) {
  if (!key) return;

  const doc = {
    scope: record.scope || '',
    state: 'completed',
    requestFingerprint: record.fingerprint || null,
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    schemaVersion: APP_SCHEMA_VERSION,
  };

  await IdempotencyKey.findOneAndUpdate(
    { key },
    { $set: doc, $setOnInsert: { key, createdAt: new Date() } },
    { upsert: true }
  );

  await redisSet(key, doc);
}

/**
 * Release a reservation without storing a result, so the client may retry.
 * Used when a request fails with a 5xx (which is never cached). Only deletes a
 * record still in `in_progress` — never a completed one.
 *
 * @param {string} key canonical idempotency key
 */
async function release(key) {
  if (!key) return;
  try {
    await IdempotencyKey.deleteOne({ key, state: 'in_progress' });
  } catch (err) {
    logger.warn('Failed to release idempotency reservation', { error: err.message });
  }
}

module.exports = { get, set, getFull, reserve, complete, release, redisEnabled, IN_FLIGHT_TTL_MS };
