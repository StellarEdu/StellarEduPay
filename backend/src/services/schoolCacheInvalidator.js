'use strict';

/**
 * Cross-replica invalidation for the school-context cache.
 *
 * `schoolContext` middleware caches the lean School doc in the process-local
 * node-cache with a 5-minute TTL. On a multi-replica deployment that TTL means
 * a mutation (rotating the Stellar address, deactivating the school, changing
 * accepted asset) is not reflected on replicas that already cached the doc for
 * up to 5 minutes — a deactivated school keeps being served, and a rotated
 * wallet keeps matching payments to the old address.
 *
 * To fix this without giving up the fast in-memory read path, every School
 * write publishes an invalidation message on a Redis pub/sub channel:
 *
 *   invalidate(school) -> PUBLISH school:invalidate {schoolId, slug}   (any replica)
 *   each replica's subscriber receives the message -> deletes the matching
 *   `school:<id>` / `school:<slug>` keys from its own node-cache.
 *
 * The emitting replica also drops its own copy synchronously (deletion is
 * idempotent, so the echo it receives from its own publish is harmless). This
 * guarantees the mutating request never serves its own stale entry on the next
 * read, even before the pub/sub round-trip completes.
 *
 * When REDIS_HOST is not configured the service degrades to single-process
 * mode: invalidate() drops the local copy only, which is correct for a single
 * replica (there are no other caches to clear).
 */

const cache = require('../cache');
const logger = require('../utils/logger').child('SchoolCacheInvalidator');

const CHANNEL = 'school:invalidate';

// Only enabled when REDIS_HOST is set (mirrors sseService / distributedLock).
// A subscriber connection cannot issue regular commands such as PUBLISH, so two
// dedicated connections are required.
const redisEnabled = Boolean(process.env.REDIS_HOST);

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
};

let publisher = null;
let subscriber = null;

if (redisEnabled) {
  const Redis = require('ioredis');
  publisher = new Redis(redisConfig);
  subscriber = new Redis(redisConfig);

  for (const [name, conn] of [['publisher', publisher], ['subscriber', subscriber]]) {
    conn.on('error', (err) => logger.error(`Redis ${name} error`, { error: err.message }));
    conn.connect().catch((err) =>
      logger.error(`Redis ${name} connect failed`, { error: err.message })
    );
  }

  subscriber.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const { schoolId, slug } = JSON.parse(message);
      dropLocal(schoolId, slug);
    } catch (err) {
      logger.error('Failed to handle invalidation message', { error: err.message, message });
    }
  });

  subscriber
    .subscribe(CHANNEL)
    .catch((err) => logger.error('School invalidation subscribe failed', { error: err.message }));
}

/**
 * Delete this replica's cached entries for a school. The middleware caches the
 * same doc under both its schoolId and its slug (whichever header was used to
 * resolve it), so both keys must be cleared.
 */
function dropLocal(schoolId, slug) {
  const keys = [];
  if (schoolId) keys.push(cache.KEYS.school(schoolId));
  if (slug) keys.push(cache.KEYS.school(slug));
  if (keys.length) cache.del(...keys);
}

/**
 * Invalidate a school across every replica after a write.
 *
 * @param {{schoolId?: string, slug?: string}} school The mutated school (the
 *   doc returned by the write is fine — only schoolId and slug are read).
 */
function invalidate(school) {
  if (!school) return;
  const schoolId = school.schoolId;
  const slug = school.slug;
  if (!schoolId && !slug) return;

  // Always drop on this replica immediately so the mutating request never
  // serves its own stale entry — independent of the pub/sub round-trip.
  dropLocal(schoolId, slug);

  if (publisher) {
    publisher
      .publish(CHANNEL, JSON.stringify({ schoolId, slug }))
      .catch((err) =>
        logger.error('School invalidation publish failed', { error: err.message, schoolId, slug })
      );
  }
}

/**
 * Close Redis connections during graceful shutdown.
 */
async function close() {
  try {
    if (subscriber) await subscriber.quit();
    if (publisher) await publisher.quit();
  } catch (err) {
    logger.error('Error closing school invalidation Redis connections', { error: err.message });
  }
}

module.exports = {
  invalidate,
  close,
  CHANNEL,
  // Exposed for testing
  _dropLocal: dropLocal,
  _isRedisEnabled: () => Boolean(publisher),
};
