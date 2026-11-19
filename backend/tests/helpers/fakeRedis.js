'use strict';

/**
 * In-process fake of the subset of the ioredis client API used by the token
 * store (get/set EX/del/exists/sadd/srem/smembers/expire). Honours TTLs.
 * Used by unit and flow tests that must not depend on a running Redis.
 */
function makeFakeRedis() {
  const kv = new Map();   // key -> { v, exp }
  const sets = new Map(); // key -> { m: Set, exp }
  const live = (e) => Boolean(e) && (e.exp === undefined || e.exp > Date.now());
  return {
    status: 'ready',
    async get(k) { const e = kv.get(k); if (!live(e)) { kv.delete(k); return null; } return e.v; },
    async set(k, v, mode, ttl) {
      if (mode !== 'EX') throw new Error('fakeRedis only supports SET ... EX');
      kv.set(k, { v: String(v), exp: Date.now() + ttl * 1000 });
      return 'OK';
    },
    async del(k) {
      const a = kv.delete(k); const b = sets.delete(k); return a || b ? 1 : 0;
    },
    async exists(k) {
      const e = kv.get(k); const s = sets.get(k);
      return (live(e) || live(s)) ? 1 : 0;
    },
    async sadd(k, m) {
      let s = sets.get(k);
      if (!live(s)) { s = { m: new Set(), exp: undefined }; sets.set(k, s); }
      const before = s.m.size; s.m.add(String(m)); return s.m.size - before;
    },
    async srem(k, m) {
      const s = sets.get(k); if (!live(s)) return 0; return s.m.delete(String(m)) ? 1 : 0;
    },
    async smembers(k) {
      const s = sets.get(k); return live(s) ? Array.from(s.m) : [];
    },
    async expire(k, ttl) {
      const e = kv.get(k) || sets.get(k);
      if (!live(e)) return 0;
      e.exp = Date.now() + ttl * 1000; return 1;
    },
  };
}

module.exports = { makeFakeRedis };
