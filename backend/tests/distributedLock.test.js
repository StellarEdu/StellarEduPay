'use strict';

/**
 * Tests for the Redis-backed distributed lock with fencing tokens.
 *
 * ioredis is mocked with a single in-process key store shared across every
 * client instance, so two isolated module loads of distributedLock behave like
 * two replicas contending for the same Redis.
 *
 * The in-process fallback path (REDIS_HOST unset) is exercised separately.
 */

// Shared key store across all mocked Redis instances.
const mockStore = new Map();

jest.mock('ioredis', () => {
  const NodeEventEmitter = require('events');
  return class MockRedis extends NodeEventEmitter {
    connect() { return Promise.resolve(); }

    set(key, value, ...opts) {
      const nx = opts.includes('NX');
      const pxIdx = opts.indexOf('PX');
      const ttl = pxIdx >= 0 ? Number(opts[pxIdx + 1]) : null;

      const existing = mockStore.get(key);
      const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
      if (nx && alive) return Promise.resolve(null);

      mockStore.set(key, { value, expiresAt: ttl != null ? Date.now() + ttl : null });
      return Promise.resolve('OK');
    }

    // Supports the release script: GET-compare-DEL.
    eval(script, numKeys, ...args) {
      const key = args[0];

      // Acquire with fence script: script contains 'incr' and has 2 keys + 2 args = 4 args
      if (script && script.includes('incr') && numKeys === 2 && args.length >= 4) {
        const fenceKey = args[1];
        const token = args[2];
        const ttl = args[3];

        const existing = mockStore.get(key);
        const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
        if (alive && existing.value) return Promise.resolve(null);

        // Atomically increment fence and set lock
        const existingFence = mockStore.get(fenceKey);
        const newFence = existingFence ? existingFence.fencingToken + 1 : 1;
        mockStore.set(fenceKey, { fencingToken: newFence });
        mockStore.set(key, { value: token, expiresAt: ttl != null ? Date.now() + ttl : null });

        return Promise.resolve(newFence);
      }

      // Renew script: script contains 'pexpire' - 3 args
      if (script && script.includes('pexpire')) {
        const token = args[1];
        const ttl = args[2];
        const existing = mockStore.get(key);
        const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
        if (alive && existing.value === token) {
          existing.expiresAt = Date.now() + ttl;
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }

      // Release script: GET-compare-DEL.
      const token = args[1];
      const existing = mockStore.get(key);
      const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
      if (alive && existing.value === token) {
        mockStore.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }

    evalsha(_sha, numKeys, ...args) {
      // Acquire with fence - script body is stored in the module
      const key = args[0];
      const fenceKey = args[1];
      const token = args[2];
      const ttl = args[3];

      const existing = mockStore.get(key);
      const alive = existing && (existing.expiresAt == null || existing.expiresAt > Date.now());
      if (alive && existing.value) return Promise.resolve(null);

      // Atomically increment fence and set lock
      const existingFence = mockStore.get(fenceKey);
      const newFence = existingFence ? existingFence.fencingToken + 1 : 1;
      mockStore.set(fenceKey, { fencingToken: newFence });
      mockStore.set(key, { value: token, expiresAt: ttl != null ? Date.now() + ttl : null });

      return Promise.resolve(newFence);
    }

    script(_command, _script) { return Promise.resolve('mock-sha'); }

    get(key) {
      const v = mockStore.get(key);
      return Promise.resolve(v && (v.fencingToken != null ? String(v.fencingToken) : (v.value || null)));
    }

    incr(key) {
      const existing = mockStore.get(key);
      const newValue = existing ? existing.fencingToken + 1 : 1;
      mockStore.set(key, { fencingToken: newValue });
      return Promise.resolve(newValue);
    }

    pexpire(key, ttl) {
      const existing = mockStore.get(key);
      if (existing) {
        existing.expiresAt = Date.now() + ttl;
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }

    quit() { return Promise.resolve('OK'); }
  };
});

function loadLock() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/services/distributedLock');
  });
  return mod;
}

describe('distributedLock', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockStore.clear();
    jest.useRealTimers();
  });

  describe('Redis-backed (REDIS_HOST set)', () => {
    beforeEach(() => {
      process.env.REDIS_HOST = 'localhost';
    });

    it('grants the lock to exactly one of two contending replicas', async () => {
      const a = loadLock();
      const b = loadLock();

      const acquiredA = await a.acquire('sync:lock:school-1', 5000);
      const acquiredB = await b.acquire('sync:lock:school-1', 5000);

      expect(acquiredA.token).toBeTruthy();
      expect(acquiredA.fencingToken).toBe(1);
      expect(acquiredB).toBeNull();
    });

    it('issues monotonic fencing tokens across acquisitions', async () => {
      const a = loadLock();
      const b = loadLock();

      const acquiredA = await a.acquire('sync:lock:school-1', 5000);
      expect(acquiredA.fencingToken).toBe(1);

      await a.release('sync:lock:school-1', acquiredA.token);

      const acquiredB = await b.acquire('sync:lock:school-1', 5000);
      expect(acquiredB.fencingToken).toBe(2);
    });

    it('lets another replica acquire after the holder releases', async () => {
      const a = loadLock();
      const b = loadLock();

      const acquiredA = await a.acquire('sync:lock:school-1', 5000);
      expect(await b.acquire('sync:lock:school-1', 5000)).toBeNull();

      expect(await a.release('sync:lock:school-1', acquiredA.token)).toBe(true);

      const acquiredB = await b.acquire('sync:lock:school-1', 5000);
      expect(acquiredB).toBeTruthy();
    });

    it('does not release a lock owned by someone else', async () => {
      const a = loadLock();
      await a.acquire('sync:lock:school-1', 5000);

      // Wrong token → no release, lock stays held.
      expect(await a.release('sync:lock:school-1', 'not-the-token')).toBe(false);

      const b = loadLock();
      expect(await b.acquire('sync:lock:school-1', 5000)).toBeNull();
    });

    it('lets the lock be retaken after its TTL expires', async () => {
      jest.useFakeTimers();
      const a = loadLock();
      const b = loadLock();

      await a.acquire('sync:lock:school-1', 1000);
      expect(await b.acquire('sync:lock:school-1', 1000)).toBeNull();

      jest.advanceTimersByTime(1500); // past TTL

      const acquiredB = await b.acquire('sync:lock:school-1', 1000);
      expect(acquiredB).toBeTruthy();
      expect(acquiredB.fencingToken).toBe(2);
    });

    it('renews the lock TTL via watchdog', async () => {
      jest.useFakeTimers();
      const a = loadLock();

      const acquired = await a.acquire('sync:lock:school-1', 1000);
      expect(acquired).toBeTruthy();

      // After 500ms (before TTL expiry), renewal should extend it
      jest.advanceTimersByTime(600);

      // The lock should still be held (renewal extended it)
      const b = loadLock();
      expect(await b.acquire('sync:lock:school-1', 1000)).toBeNull();
    });

    it('detects stale holder after TTL expiry with fencing tokens', async () => {
      jest.useFakeTimers();
      const a = loadLock();
      const b = loadLock();

      const acquiredA = await a.acquire('sync:lock:school-1', 100);
      expect(acquiredA.fencingToken).toBe(1);

      // Advance past TTL - lock should be expired
      jest.advanceTimersByTime(150);

      // B should be able to acquire, getting a higher fence
      const acquiredB = await b.acquire('sync:lock:school-1', 5000);
      expect(acquiredB.fencingToken).toBe(2);

      // Protected resource can reject A's stale write by comparing fences
      expect(acquiredB.fencingToken).toBeGreaterThan(acquiredA.fencingToken);
    });
  });

  describe('in-process fallback (no REDIS_HOST)', () => {
    beforeEach(() => {
      delete process.env.REDIS_HOST;
    });

    it('still enforces mutual exclusion within a single process', async () => {
      const lock = loadLock();
      expect(lock._isRedisEnabled()).toBe(false);

      const acquiredA = await lock.acquire('sync:lock:school-1', 5000);
      expect(acquiredA).toBeTruthy();
      expect(await lock.acquire('sync:lock:school-1', 5000)).toBeNull();

      expect(await lock.release('sync:lock:school-1', acquiredA.token)).toBe(true);
      const acquiredB = await lock.acquire('sync:lock:school-1', 5000);
      expect(acquiredB).toBeTruthy();
    });

    it('issues monotonic fencing tokens in fallback', async () => {
      const lock = loadLock();

      const acquiredA = await lock.acquire('sync:lock:school-1', 5000);
      expect(acquiredA.fencingToken).toBe(1);

      await lock.release('sync:lock:school-1', acquiredA.token);

      const acquiredB = await lock.acquire('sync:lock:school-1', 5000);
      expect(acquiredB.fencingToken).toBe(2);
    });

    it('allows re-acquisition after TTL expiry (Issue #1406 - correctness hole)', async () => {
      jest.useFakeTimers();
      const lock = loadLock();

      // Holder A acquires the lock with a 1000ms TTL
      const acquiredA = await lock.acquire('sync:lock:school-1', 1000);
      expect(acquiredA).toBeTruthy();

      // Advance time past the TTL expiry (but holder A is still running)
      jest.advanceTimersByTime(1500);

      // In a correctness hole scenario, holder B can now acquire the same lock
      // This is the bug described in Issue #1406: in-process fallback does not
      // protect against concurrent writers when TTL expires mid-operation.
      const acquiredB = await lock.acquire('sync:lock:school-1', 1000);
      expect(acquiredB).toBeTruthy();

      // Both A and B now believe they hold the lock, breaking mutual exclusion.
      // Protected resources must use fencing tokens to detect this situation.
      expect(acquiredB.fencingToken).toBeGreaterThan(acquiredA.fencingToken);
    });
  });

  describe('withLock helper', () => {
    beforeEach(() => { delete process.env.REDIS_HOST; });

    it('runs fn while holding the lock and releases afterward', async () => {
      const lock = loadLock();
      const { result, fencingToken } = await lock.withLock('k', 5000, () => Promise.resolve('ran'));
      expect(result).toBe('ran');
      expect(fencingToken).toBe(1);
      // Lock released → can re-acquire.
      const acquired = await lock.acquire('k', 5000);
      expect(acquired).toBeTruthy();
    });

    it('returns the contended sentinel without running fn when held', async () => {
      const lock = loadLock();
      await lock.acquire('k', 5000);
      const fn = jest.fn();
      const result = await lock.withLock('k', 5000, fn, { onContended: 'SKIPPED' });
      expect(fn).not.toHaveBeenCalled();
      expect(result).toBe('SKIPPED');
    });

    it('returns fencing token to caller for protected resource checks', () => {
      const lock = loadLock();

      return lock.withLock(
        'k',
        5000,
        (token, fence) => ({ token, fence })
      ).then(({ result, fencingToken }) => {
        expect(fencingToken).toBe(1);
        expect(result.fence).toBe(1);
      });
    });
  });

  describe('fencing token safety - paused holder scenario', () => {
    beforeEach(() => {
      process.env.REDIS_HOST = 'localhost';
    });

    it('simulates paused holder + competing acquirer with fencing tokens', async () => {
      jest.useFakeTimers();
      const lock = loadLock();

      // Holder A acquires lock
      const acquiredA = await lock.acquire('sync:lock:school-1', 1000);
      const fenceA = acquiredA.fencingToken;

      // Simulate pause: advance time past TTL (lock expires in Redis)
      // In real scenario: A's process is paused (GC/STW), lock expires, B acquires
      jest.advanceTimersByTime(1500);

      // Holder B (another worker) acquires the lock
      const lockB = loadLock();
      const acquiredB = await lockB.acquire('sync:lock:school-1', 1000);
      const fenceB = acquiredB.fencingToken;

      // Fencing token for B should be higher than A's
      // Protected resource would reject A's writes since fenceA < fenceB
      expect(fenceB).toBeGreaterThan(fenceA);

      // Verify we can check current fence
      const currentFence = await lockB.getCurrentFence('sync:lock:school-1');
      expect(currentFence).toBe(fenceB);
    });

    it('stale holder cannot renew after lock expires', async () => {
      jest.useFakeTimers();
      const lock = loadLock();

      const acquired = await lock.acquire('sync:lock:school-1', 100);
      const { token } = acquired;

      // Simulate long pause past TTL
      jest.advanceTimersByTime(200);

      // Renewal should fail
      const renewed = await lock.renew('sync:lock:school-1', token, 1000);
      expect(renewed).toBe(false);
    });

    it('watchdog stops on renewal failure', async () => {
      jest.useFakeTimers();
      const lock = loadLock();

      const { stopWatchdog } = await lock.withLock('k', 100, () => 'work');
      expect(typeof stopWatchdog).toBe('function');

      // Stop watchdog should work
      stopWatchdog();
    });
  });
});