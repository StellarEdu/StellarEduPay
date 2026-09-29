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
const { getRedisClient, getRedisSubscriber } = require('../config/redisClient');

const CHANNEL = 'school:invalidate';

// Only enabled when REDIS_HOST is set (mirrors sseService / distributedLock).
// The shared subscriber cannot issue commands such as PUBLISH, so publishing
// uses the process-wide command client.
const redisEnabled = Boolean(process.env.REDIS_HOST);

const publisher = redisEnabled ? getRedisClient() : null;
const subscriber = redisEnabled ? getRedisSubscriber() : null;

if (subscriber) {
  subscriber.on('message', onMessage);

  subscriber
    .subscribe(CHANNEL)
    .catch((err) => logger.error('School invalidation subscribe failed', { error: err.message }));
}

function onMessage(channel, message) {
  if (channel !== CHANNEL) return;
  try {
    const { schoolId, slug } = JSON.parse(message);
    dropLocal(schoolId, slug);
  } catch (err) {
    logger.error('Failed to handle invalidation message', { error: err.message, message });
  }
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
 * Release this service's subscription; Redis clients are closed centrally.
 */
async function close() {
  if (!subscriber) return;
  subscriber.removeListener('message', onMessage);
  try {
    await subscriber.unsubscribe(CHANNEL);
  } catch (err) {
    logger.error('Error unsubscribing school invalidation listener', { error: err.message });
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
