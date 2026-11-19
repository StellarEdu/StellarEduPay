'use strict';

/**
 * Brute-force protection state for authentication (#1950).
 *
 * Two kinds of short-lived block:
 *  - credential: one presented token from one IP. Blocking this pair leaves other
 *    clients behind the same NAT (schools, offices, carrier NAT) untouched.
 *  - ip: a backstop for the whole IP, with a much higher threshold.
 *
 * Failures that say nothing about guessing (expired, revoked, tenant mismatch)
 * are not counted; callers pass countTowardsBlock: false for those.
 *
 * Block records hold only hashIp(ip), so admin listings and alerts never show a
 * raw address. Keys use the raw IP because Redis counters must match across
 * replicas and hashIp() uses a per-process secret.
 */

const crypto = require('crypto');
const net = require('net');
const { get, set, del, keys } = require('../cache');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { hashIp } = require('../utils/piiRedaction');
const { authIpBlocksTotal } = require('../metrics');
const { sendAdminAlert } = require('./alertService');
const logger = require('../utils/logger').child('AuthIpBlocks');

const FAIL_WINDOW = 300;                 // 5 minutes (seconds)
const CREDENTIAL_FAIL_THRESHOLD = 5;     // failures from one token on one IP
const IP_FAIL_THRESHOLD = 100;           // backstop for the whole IP
const BLOCK_TTL = 900;                   // 15 minutes (seconds)

const BLOCK_PREFIXES = ['ip_blocked:', 'ip_cred_blocked:'];

// ── Trusted networks ──────────────────────────────────────────────────────────
// TRUSTED_NETWORKS is a comma-separated CIDR list (e.g. "10.0.0.0/8,192.0.2.5").
// Clients inside these ranges are never blocked. Parsed lazily so a changed
// env value takes effect without a restart in tests.

let _trustedRaw = null;
let _trustedList = null;

function getTrustedList() {
  const raw = process.env.TRUSTED_NETWORKS || '';
  if (raw === _trustedRaw && _trustedList) return _trustedList;

  const list = new net.BlockList();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, prefixText] = entry.split('/');
    const family = net.isIPv6(address) ? 'ipv6' : net.isIPv4(address) ? 'ipv4' : null;
    const maxPrefix = family === 'ipv6' ? 128 : 32;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      logger.warn('Ignoring invalid TRUSTED_NETWORKS entry', { entry });
      continue;
    }
    list.addSubnet(address, prefix, family);
  }

  _trustedRaw = raw;
  _trustedList = list;
  return list;
}

function isTrustedIp(ip) {
  if (!ip || ip === 'unknown') return false;
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = net.isIPv6(bare) ? 'ipv6' : net.isIPv4(bare) ? 'ipv4' : null;
  if (!family) return false;
  return getTrustedList().check(bare, family);
}

// ── Keys ──────────────────────────────────────────────────────────────────────

function credentialFingerprint(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function failKeyFor(kind, ip, fingerprint) {
  return kind === 'ip' ? `ip_auth_fail:${ip}` : `ip_cred_fail:${ip}:${fingerprint}`;
}

function blockKeyFor(kind, ip, fingerprint) {
  return kind === 'ip' ? `ip_blocked:${ip}` : `ip_cred_blocked:${ip}:${fingerprint}`;
}

// ── Storage (Redis when ready, in-process cache otherwise) ───────────────────

function readyRedis() {
  const redis = getRedisClient();
  return redis && isRedisReady() ? redis : null;
}

async function isKeyBlocked(key) {
  const redis = readyRedis();
  if (redis) {
    try {
      return (await redis.exists(key)) === 1;
    } catch (err) {
      logger.debug('Redis block check failed; using local cache', { error: err.message });
    }
  }
  return Boolean(get(key));
}

async function incrementFailure(key) {
  const redis = readyRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, FAIL_WINDOW);
      return count;
    } catch (err) {
      logger.warn('Redis error tracking auth failure; using local cache', { error: err.message });
    }
  }
  const count = (get(key) || 0) + 1;
  set(key, count, FAIL_WINDOW);
  return count;
}

async function applyBlock(kind, ip, fingerprint, ipHash) {
  const key = blockKeyFor(kind, ip, fingerprint);
  const record = {
    kind,
    ipHash,
    blockedAt: new Date().toISOString(),
    // Internal only: lets a clear also reset the failure counter. Never returned.
    failKey: failKeyFor(kind, ip, fingerprint),
  };

  const redis = readyRedis();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(record), 'EX', BLOCK_TTL);
    } catch (err) {
      logger.warn('Redis error recording auth block; using local cache', { error: err.message });
    }
  }
  set(key, record, BLOCK_TTL);

  authIpBlocksTotal.inc({ kind });
  await sendAdminAlert(`Auth ${kind} block applied for IP ${ipHash}`, { ipHash, kind });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the block that applies to this request, or null.
 * Trusted networks are never blocked.
 *
 * @param {{ ip: string, token: string|null }} request
 * @returns {Promise<{ kind: 'ip' | 'credential' } | null>}
 */
async function findActiveBlock({ ip, token }) {
  if (isTrustedIp(ip)) return null;

  if (await isKeyBlocked(blockKeyFor('ip', ip))) return { kind: 'ip' };

  const fingerprint = credentialFingerprint(token);
  if (fingerprint && await isKeyBlocked(blockKeyFor('credential', ip, fingerprint))) {
    return { kind: 'credential' };
  }
  return null;
}

/**
 * Count one counted authentication failure and apply any block it triggers.
 * Trusted networks are never counted.
 *
 * @param {{ ip: string, token: string|null }} failure
 */
async function recordAuthFailure({ ip, token }) {
  if (isTrustedIp(ip)) return;

  const ipHash = hashIp(ip);

  const ipCount = await incrementFailure(failKeyFor('ip', ip));
  if (ipCount >= IP_FAIL_THRESHOLD && !(await isKeyBlocked(blockKeyFor('ip', ip)))) {
    await applyBlock('ip', ip, null, ipHash);
  }

  const fingerprint = credentialFingerprint(token);
  if (fingerprint) {
    const credentialCount = await incrementFailure(failKeyFor('credential', ip, fingerprint));
    if (
      credentialCount >= CREDENTIAL_FAIL_THRESHOLD &&
      !(await isKeyBlocked(blockKeyFor('credential', ip, fingerprint)))
    ) {
      await applyBlock('credential', ip, fingerprint, ipHash);
    }
  }
}

/**
 * Find every active block record, from Redis when ready, else the local cache.
 * @returns {Promise<Array<{ key: string, record: object }>>}
 */
async function loadBlockRecords() {
  const found = [];
  const redis = readyRedis();

  if (redis) {
    try {
      for (const pattern of BLOCK_PREFIXES.map((p) => `${p}*`)) {
        let cursor = '0';
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
          cursor = next;
          for (const key of batch) {
            const raw = await redis.get(key);
            const record = raw ? JSON.parse(raw) : null;
            if (record) found.push({ key, record });
          }
        } while (cursor !== '0');
      }
      return found;
    } catch (err) {
      logger.warn('Redis error listing auth blocks; using local cache', { error: err.message });
      found.length = 0;
    }
  }

  for (const key of keys()) {
    if (BLOCK_PREFIXES.some((p) => key.startsWith(p))) {
      const record = get(key);
      if (record && typeof record === 'object') found.push({ key, record });
    }
  }
  return found;
}

/**
 * Admin view of active blocks. Contains no raw IPs and no internal keys.
 * @returns {Promise<Array<{ ipHash: string, kind: string, blockedAt: string }>>}
 */
async function listAuthIpBlocks() {
  const entries = await loadBlockRecords();
  return entries.map(({ record }) => ({
    ipHash: record.ipHash,
    kind: record.kind,
    blockedAt: record.blockedAt,
  }));
}

/**
 * Remove every active block for one hashed IP, and reset the counters behind them.
 * @param {string} ipHash
 * @returns {Promise<number>} number of block records removed
 */
async function clearAuthIpBlocksForIp(ipHash) {
  const matches = (await loadBlockRecords()).filter(({ record }) => record.ipHash === ipHash);

  for (const { key, record } of matches) {
    const toDelete = [key, record.failKey].filter(Boolean);
    const redis = readyRedis();
    if (redis) {
      try {
        await redis.del(...toDelete);
      } catch (err) {
        logger.warn('Redis error clearing auth block; local cache cleared', { error: err.message });
      }
    }
    del(...toDelete);
  }
  return matches.length;
}

module.exports = {
  findActiveBlock,
  recordAuthFailure,
  listAuthIpBlocks,
  clearAuthIpBlocksForIp,
  BLOCK_TTL,
};
