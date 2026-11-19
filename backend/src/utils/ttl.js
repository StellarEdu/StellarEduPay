'use strict';

/**
 * Token and session lifetime parsing (#1920).
 *
 * Lifetimes come from environment variables such as JWT_ACCESS_TOKEN_TTL and
 * accept a plain number of seconds ("3600") or a number with a unit suffix:
 * s (seconds), m (minutes), h (hours) or d (days). "8h" and "30d" are valid.
 *
 * A malformed or non-positive value throws. A silent fallback would leave a
 * misconfigured deployment issuing tokens with a lifetime nobody chose.
 */

const MULTIPLIERS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const TTL_PATTERN = /^(\d+)([smhd]?)$/;

/**
 * Convert a TTL string to seconds.
 * @param {string} value e.g. "3600", "8h", "30d"
 * @returns {number} lifetime in seconds
 * @throws {Error} when the value is not a positive integer with an optional unit
 */
function parseTTLValue(value) {
  const match = typeof value === 'string' ? value.trim().match(TTL_PATTERN) : null;
  if (!match) {
    throw new Error(`Invalid TTL "${value}": expected seconds or a number with unit s, m, h or d`);
  }
  const seconds = parseInt(match[1], 10) * MULTIPLIERS[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid TTL "${value}": must be a positive duration`);
  }
  return seconds;
}

/**
 * Read a TTL from the environment.
 * @param {string} envName environment variable to read
 * @param {number} defaultSeconds used when the variable is unset or empty
 * @returns {number} lifetime in seconds
 * @throws {Error} when the variable is set to an invalid value
 */
function parseTTL(envName, defaultSeconds) {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return defaultSeconds;
  try {
    return parseTTLValue(raw);
  } catch (err) {
    throw new Error(`${envName}: ${err.message}`);
  }
}

module.exports = { parseTTL, parseTTLValue };
