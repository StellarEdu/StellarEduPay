'use strict';

const NodeCache = require('node-cache');

// stdTTL: default TTL in seconds (0 = no expiry)
// checkperiod: how often (seconds) to check for expired keys
const cache = new NodeCache({ stdTTL: 0, checkperiod: 60, useClones: false });

const TTL = {
  ACCEPTED_ASSETS: 3600, // static config — 1 hour
  FEES: 300,             // fee structures change rarely — 5 min
  STUDENTS: 60,          // student list — 1 min
  STUDENT: 60,           // single student — 1 min
  SCHOOL: 300,           // school lookup — 5 min
  BALANCE: 30,           // balance aggregation — 30 sec
  PAYMENTS: 30,          // payment list — 30 sec
  OVERPAYMENTS: 30,
  SUSPICIOUS: 30,
  PENDING: 30,
  REPORT: 300,           // report aggregation — 5 min (short for data freshness)
  REPORT_ASYNC: 3600,   // async report artifacts — 1 hour before cleanup
};

// Cache key builders
const KEYS = {
  acceptedAssets: () => 'accepted_assets',
  feesAll: () => 'fees:all',
  feeByClass: (className) => `fees:${className}`,
  studentsAll: () => 'students:all',
  student: (studentId) => `student:${studentId}`,
  school: (schoolIdOrSlug) => `school:${schoolIdOrSlug}`,
  balance: (studentId) => `balance:${studentId}`,
  payments: (studentId) => `payments:${studentId}`,
  overpayments: () => 'overpayments',
  suspicious: () => 'suspicious',
  pending: () => 'pending',
  report: (schoolId, startDate, endDate, dataVersion = '') => `report:${schoolId}:${startDate || ''}:${endDate || ''}:v${dataVersion || 'latest'}`,
};

/**
 * Get from cache. Returns undefined on miss.
 */
function get(key) {
  return cache.get(key);
}

/**
 * Set a value in the cache with the given TTL.
 */
function set(key, value, ttl) {
  cache.set(key, value, ttl);
}

/**
 * Delete one or more keys from the cache.
 */
function del(...keys) {
  cache.del(keys);
}

/**
 * Delete all keys matching a prefix.
 */
function delByPrefix(prefix) {
  const allKeys = cache.keys();
  const toDelete = allKeys.filter((k) => k.startsWith(prefix));
  if (toDelete.length > 0) cache.del(toDelete);
}

/**
 * Get all cache keys.
 */
function keys() {
  return cache.keys();
}

module.exports = { get, set, del, delByPrefix, KEYS, TTL, keys };
