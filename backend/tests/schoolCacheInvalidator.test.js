'use strict';

/**
 * Tests for the cross-replica school-cache invalidator.
 *
 * Covers the multi-replica guarantee (an invalidate() on one replica drops the
 * cached doc on another within the pub/sub round-trip), that both the schoolId
 * and slug keys are cleared, the synchronous local drop on the emitting replica,
 * and the single-process (no-Redis) fallback.
 *
 * ioredis is mocked with an in-process pub/sub bus shared across all client
 * instances, so two isolated module loads behave like two replicas talking to
 * the same Redis. Each replica also gets its OWN node-cache instance (the cache
 * module is re-required inside isolateModules), mirroring per-process caches.
 */

const EventEmitter = require('events');

// Shared bus across all mocked Redis instances. The `mock` prefix lets the
// jest.mock factory (hoisted above imports) reference it.
const mockBus = new EventEmitter();
mockBus.setMaxListeners(0);

jest.mock('ioredis', () => {
  const NodeEventEmitter = require('events');
  return class MockRedis extends NodeEventEmitter {
    constructor() {
      super();
      this._channels = new Set();
      this._onPublish = (channel, message) => {
        if (this._channels.has(channel)) this.emit('message', channel, message);
      };
      mockBus.on('publish', this._onPublish);
    }
    connect() { return Promise.resolve(); }
    async subscribe(ch) { this._channels.add(ch); }
    async unsubscribe(ch) { this._channels.delete(ch); }
    async publish(ch, msg) { mockBus.emit('publish', ch, msg); return 1; }
    async quit() { mockBus.off('publish', this._onPublish); return 'OK'; }
  };
});

// Load a "replica": a fresh invalidator module bound to its own fresh cache
// instance. Returns both so tests can seed/inspect that replica's cache.
function loadReplica() {
  let invalidator;
  let cache;
  jest.isolateModules(() => {
    cache = require('../src/cache');
    invalidator = require('../src/services/schoolCacheInvalidator');
  });
  return { invalidator, cache };
}

function seed(cache, school) {
  if (school.schoolId) cache.set(cache.KEYS.school(school.schoolId), school, 300);
  if (school.slug) cache.set(cache.KEYS.school(school.slug), school, 300);
}

// Let the publish->message->drop chain settle (publish().catch is async).
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('schoolCacheInvalidator', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockBus.removeAllListeners('publish');
  });

  describe('cross-replica invalidation (Redis pub/sub)', () => {
    beforeEach(() => {
      process.env.REDIS_HOST = 'localhost';
    });

    it('drops a school cached on replica B when replica A invalidates it', async () => {
      const a = loadReplica();
      const b = loadReplica();

      const school = { schoolId: 'SCH-1', slug: 'lincoln-high', stellarAddress: 'GOLD' };
      seed(a.cache, school);
      seed(b.cache, school);
      expect(b.cache.get(b.cache.KEYS.school('SCH-1'))).toBeDefined();

      a.invalidator.invalidate(school);
      await flush();

      // Cleared on the remote replica (via pub/sub) under both keys...
      expect(b.cache.get(b.cache.KEYS.school('SCH-1'))).toBeUndefined();
      expect(b.cache.get(b.cache.KEYS.school('lincoln-high'))).toBeUndefined();
      // ...and on the emitting replica too.
      expect(a.cache.get(a.cache.KEYS.school('SCH-1'))).toBeUndefined();
      expect(a.cache.get(a.cache.KEYS.school('lincoln-high'))).toBeUndefined();

      await a.invalidator.close();
      await b.invalidator.close();
    });

    it('drops the emitting replica copy synchronously, before the pub/sub round-trip', () => {
      const a = loadReplica();
      const school = { schoolId: 'SCH-2', slug: 'maple-academy' };
      seed(a.cache, school);

      a.invalidator.invalidate(school);

      // No flush() — the local drop must be synchronous so the mutating request
      // never serves its own stale entry on the next read.
      expect(a.cache.get(a.cache.KEYS.school('SCH-2'))).toBeUndefined();
      expect(a.cache.get(a.cache.KEYS.school('maple-academy'))).toBeUndefined();
    });

    it('does not touch an unrelated school still cached on the remote replica', async () => {
      const a = loadReplica();
      const b = loadReplica();

      const target = { schoolId: 'SCH-3', slug: 'oak-prep' };
      const bystander = { schoolId: 'SCH-9', slug: 'pine-college' };
      seed(b.cache, target);
      seed(b.cache, bystander);

      a.invalidator.invalidate(target);
      await flush();

      expect(b.cache.get(b.cache.KEYS.school('SCH-3'))).toBeUndefined();
      expect(b.cache.get(b.cache.KEYS.school('SCH-9'))).toBeDefined();
      expect(b.cache.get(b.cache.KEYS.school('pine-college'))).toBeDefined();

      await a.invalidator.close();
      await b.invalidator.close();
    });

    it('invalidates by slug alone when no schoolId is present', async () => {
      const a = loadReplica();
      const b = loadReplica();

      b.cache.set(b.cache.KEYS.school('slug-only'), { slug: 'slug-only' }, 300);

      a.invalidator.invalidate({ slug: 'slug-only' });
      await flush();

      expect(b.cache.get(b.cache.KEYS.school('slug-only'))).toBeUndefined();

      await a.invalidator.close();
      await b.invalidator.close();
    });

    it('reports Redis as enabled when REDIS_HOST is set', () => {
      const a = loadReplica();
      expect(a.invalidator._isRedisEnabled()).toBe(true);
    });
  });

  describe('single-process fallback (no Redis)', () => {
    beforeEach(() => {
      delete process.env.REDIS_HOST;
    });

    it('drops the local copy under both keys without Redis', () => {
      const a = loadReplica();
      expect(a.invalidator._isRedisEnabled()).toBe(false);

      const school = { schoolId: 'SCH-4', slug: 'birch-school' };
      seed(a.cache, school);

      a.invalidator.invalidate(school);

      expect(a.cache.get(a.cache.KEYS.school('SCH-4'))).toBeUndefined();
      expect(a.cache.get(a.cache.KEYS.school('birch-school'))).toBeUndefined();
    });

    it('is a no-op for null / empty input', () => {
      const a = loadReplica();
      expect(() => a.invalidator.invalidate(null)).not.toThrow();
      expect(() => a.invalidator.invalidate({})).not.toThrow();
    });
  });
});
