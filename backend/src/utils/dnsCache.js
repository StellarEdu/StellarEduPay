'use strict';

const dns = require('dns').promises;

/**
 * TTL-aware DNS cache with expiration handling.
 *
 * Caches DNS resolution results with their TTL and re-resolves on expiry.
 * Prevents DNS rebinding attacks by ensuring webhook delivery re-validates
 * the resolved IP against the SSRF deny list when DNS TTL expires.
 */

const DEFAULT_TTL_MS = 60_000; // 1 minute (conservative default)
const MAX_TTL_MS = 3600_000;   // 1 hour (maximum cache lifetime)

class DnsCache {
  constructor() {
    this._cache = new Map(); // hostname -> { ips, expiresAt }
  }

  /**
   * Get cached DNS results if still valid, otherwise return null.
   * @param {string} hostname
   * @returns {string[]|null} array of resolved IPs or null if expired/missing
   */
  get(hostname) {
    const entry = this._cache.get(hostname);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(hostname);
      return null;
    }
    return entry.ips;
  }

  /**
   * Store DNS resolution result with TTL.
   * TTL is clamped to [DEFAULT_TTL_MS, MAX_TTL_MS].
   *
   * @param {string} hostname
   * @param {string[]} ips
   * @param {number} ttlSeconds from DNS response (or DEFAULT_TTL_MS/1000 if unknown)
   */
  set(hostname, ips, ttlSeconds = DEFAULT_TTL_MS / 1000) {
    const ttlMs = Math.min(
      Math.max(ttlSeconds * 1000, DEFAULT_TTL_MS),
      MAX_TTL_MS
    );
    this._cache.set(hostname, {
      ips,
      expiresAt: Date.now() + ttlMs,
    });
  }

  clear() {
    this._cache.clear();
  }

  size() {
    return this._cache.size;
  }
}

const _globalDnsCache = new DnsCache();

/**
 * Resolve a hostname with TTL-aware caching.
 * Returns cached result if fresh, otherwise performs DNS lookup and caches.
 *
 * Note: Node's dns.resolve4/resolve6 don't expose TTL directly.
 * We use DEFAULT_TTL_MS as a conservative default.
 *
 * @param {string} hostname
 * @returns {Promise<string[]>} array of resolved IPs (v4 and v6)
 * @throws {Error} if DNS resolution fails
 */
async function resolveDnsWithCache(hostname) {
  // Check cache first
  const cached = _globalDnsCache.get(hostname);
  if (cached) return cached;

  // Resolve both v4 and v6 in parallel
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);

  const allIps = [...v4, ...v6];
  if (allIps.length === 0) {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  // Cache with default TTL (Node.js doesn't expose actual TTL from DNS response)
  _globalDnsCache.set(hostname, allIps, DEFAULT_TTL_MS / 1000);

  return allIps;
}

/**
 * Clear the DNS cache (for testing).
 */
function clearDnsCache() {
  _globalDnsCache.clear();
}

module.exports = {
  DnsCache,
  resolveDnsWithCache,
  clearDnsCache,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  // For testing
  _globalDnsCache,
};
