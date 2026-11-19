'use strict';

/**
 * Parse a TTL setting from the environment.
 *
 * Accepts a bare number of seconds ("3600") or a number with a unit suffix
 * ("15m", "8h", "30d"). Anything else falls back to `defaultSeconds`.
 *
 * @param {string} envVar          Name of the environment variable to read.
 * @param {number} defaultSeconds  Value used when the variable is unset or invalid.
 * @returns {number} TTL in seconds.
 */
function parseTTL(envVar, defaultSeconds) {
  const val = process.env[envVar];
  if (!val) return defaultSeconds;
  const match = val.match(/^(\d+)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const n = parseInt(match[1], 10);
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, '': 1 };
  return n * (multipliers[match[2]] ?? 1);
}

module.exports = { parseTTL };
