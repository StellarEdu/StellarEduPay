'use strict';

/**
 * Contract tests for the refresh-token / session store (issue #1921).
 *
 * The same suite runs against every backend:
 *   - memory   : process-local adapter
 *   - redis-fake: Redis-protocol fake, always available in CI
 *   - redis-real: a real Redis, only when REDIS_TEST_URL is set (CI service container)
 */

const { createTokenStore, makeMemoryAdapter } = require('../src/services/sessionStore');

const { makeFakeRedis } = require('./helpers/fakeRedis');

// Adapter over the fake, mirroring src/services/sessionStore.js makeRedisAdapter.
function adapterFor(client) {
  return {
    get: (k) => client.get(k),
    set: (k, v, ttl) => client.set(k, v, 'EX', ttl),
    del: (k) => client.del(k),
    exists: (k) => client.exists(k),
    sadd: (k, m) => client.sadd(k, m),
    srem: (k, m) => client.srem(k, m),
    smembers: (k) => client.smembers(k),
    expire: (k, ttl) => client.expire(k, ttl),
  };
}

const backends = [
  { name: 'memory', make: () => createTokenStore(makeMemoryAdapter(), 'memory') },
  { name: 'redis-fake', make: () => createTokenStore(adapterFor(makeFakeRedis()), 'redis') },
];

if (process.env.REDIS_TEST_URL) {
  backends.push({
    name: 'redis-real',
    make: () => {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_TEST_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
      const store = createTokenStore(adapterFor(client), 'redis');
      store.__client = client; // closed by teardown
      return store;
    },
    teardown: async (store) => {
      // Best-effort cleanup of keys written by the suite.
      const client = store.__client;
      if (client) await client.quit();
    },
  });
}

const TTL = 3600;

describe.each(backends)('token/session store contract: $name', ({ make, teardown }) => {
  let store;
  let uniq = 0;
  const id = (p) => `${p}-${Date.now()}-${++uniq}`;

  beforeEach(() => { store = make(); });
  afterEach(async () => { if (teardown) await teardown(store); });

  test('stores and returns refresh-token metadata', async () => {
    const t = id('tok');
    await store.setToken(t, TTL, { familyId: 'f1', sessionId: 's1', userId: 'u1', role: 'user' });
    expect(await store.getToken(t)).toEqual({ familyId: 'f1', sessionId: 's1', userId: 'u1', role: 'user' });
    await store.delToken(t);
    expect(await store.getToken(t)).toBeNull();
  });

  test('returns null for unknown tokens', async () => {
    expect(await store.getToken(id('nope'))).toBeNull();
    expect(await store.getConsumedFamily(id('nope'))).toBeNull();
  });

  test('reuse detection: a consumed token remembers its family', async () => {
    const t = id('old');
    await store.setToken(t, TTL, { familyId: 'fam-A', userId: 'u1' });
    await store.markConsumed(t, 'fam-A', 300);
    await store.delToken(t);
    expect(await store.getToken(t)).toBeNull();
    expect(await store.getConsumedFamily(t)).toBe('fam-A');
  });

  test('revokeFamily marks the family revoked and isFamilyRevoked reports it', async () => {
    const fam = id('fam');
    expect(await store.isFamilyRevoked(fam)).toBe(false);
    await store.revokeFamily(fam, TTL);
    expect(await store.isFamilyRevoked(fam)).toBe(true);
  });

  test('sessions: set, get, list per user, delete', async () => {
    const user = id('user');
    const sidA = id('sA');
    const sidB = id('sB');
    await store.setSession(sidA, { userId: user, familyId: 'fa', deviceInfo: {} }, TTL);
    await store.setSession(sidB, { userId: user, familyId: 'fb', deviceInfo: {} }, TTL);

    expect((await store.getSession(sidA)).familyId).toBe('fa');

    const listed = await store.listUserSessions(user);
    expect(listed.map((s) => s.sessionId).sort()).toEqual([sidA, sidB].sort());

    expect(await store.delSession(sidA)).toBe(true);
    expect(await store.getSession(sidA)).toBeNull();
    expect((await store.listUserSessions(user)).map((s) => s.sessionId)).toEqual([sidB]);
  });

  test('listUserSessions does not leak other users\' sessions', async () => {
    const u1 = id('u1');
    const u2 = id('u2');
    await store.setSession(id('x'), { userId: u1 }, TTL);
    await store.setSession(id('y'), { userId: u2 }, TTL);
    expect(await store.listUserSessions(u1)).toHaveLength(1);
    expect(await store.listUserSessions(u2)).toHaveLength(1);
    expect(await store.listUserSessions(id('nobody'))).toEqual([]);
  });

  test('revokeAllUserTokens revokes every family and session for that user only', async () => {
    const user = id('victim');
    const other = id('bystander');
    const famA = id('famA');
    const famB = id('famB');
    const tokA = id('tA');
    const tokOther = id('tO');

    await store.setToken(tokA, TTL, { familyId: famA, userId: user });
    await store.setToken(id('tB'), TTL, { familyId: famB, userId: user });
    await store.setToken(tokOther, TTL, { familyId: id('famO'), userId: other });
    await store.setSession(id('s'), { userId: user, familyId: famA }, TTL);

    const result = await store.revokeAllUserTokens(user, TTL);
    expect(result).toEqual({ families: 2, sessions: 1 });

    expect(await store.isFamilyRevoked(famA)).toBe(true);
    expect(await store.isFamilyRevoked(famB)).toBe(true);
    expect(await store.listUserSessions(user)).toEqual([]);

    // The other user's family is untouched.
    const otherFam = (await store.getToken(tokOther)).familyId;
    expect(await store.isFamilyRevoked(otherFam)).toBe(false);
  });
});

describe('two replicas sharing one Redis', () => {
  test('a token issued by replica A is accepted by B, and revoking on A is seen by B', async () => {
    const shared = makeFakeRedis();
    const replicaA = createTokenStore(adapterFor(shared), 'redis');
    const replicaB = createTokenStore(adapterFor(shared), 'redis');

    const token = 'rt-cross-replica';
    await replicaA.setToken(token, TTL, { familyId: 'fam-x', userId: 'u-9', sessionId: 's-9' });

    expect((await replicaB.getToken(token)).familyId).toBe('fam-x');

    await replicaA.revokeAllUserTokens('u-9', TTL);
    expect(await replicaB.isFamilyRevoked('fam-x')).toBe(true);
  });

  test('a memory store is process-local (documents the single-node limitation)', async () => {
    const a = createTokenStore(makeMemoryAdapter(), 'memory');
    const b = createTokenStore(makeMemoryAdapter(), 'memory');
    await a.setToken('only-on-a', TTL, { familyId: 'f' });
    expect(await b.getToken('only-on-a')).toBeNull();
  });
});

describe('entries expire', () => {
  test('memory adapter drops entries after their TTL', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const store = createTokenStore(makeMemoryAdapter(), 'memory');
      await store.setToken('short', 1, { familyId: 'f' });
      expect(await store.getToken('short')).not.toBeNull();
      jest.advanceTimersByTime(2000);
      expect(await store.getToken('short')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
