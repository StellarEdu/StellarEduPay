'use strict';

/**
 * Parse a TTL setting such as "900", "15m", "8h" or "30d" into seconds.
 *
 * Falls back to `defaultSeconds` when the env var is unset or malformed.
 * Plain numbers are treated as seconds.
 *
 * @param {string} envVar - name of the environment variable to read
 * @param {number} defaultSeconds - value returned when the variable is unusable
 * @returns {number}
 */
function parseTTL(envVar, defaultSeconds) {
  const val = process.env[envVar];
  if (!val) return defaultSeconds;
  const match = val.match(/^(\d+)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, '': 1 };
  return n * (multipliers[unit] ?? 1);
}

module.exports = { parseTTL };
