'use strict';

/**
 * Reads a token lifetime from an environment variable.
 *
 * Accepts bare seconds ("3600") or a whole number with a unit suffix:
 * s, m, h or d ("30m" -> 1800, "8h" -> 28800, "30d" -> 2592000). Anything else,
 * including an unset or empty variable, returns `fallbackSeconds`.
 *
 * Never uses parseInt on the raw value: parseInt("8h") is 8, which once turned
 * an 8-hour access token into an 8-second one (#1739).
 *
 * @param {string} envName
 * @param {number} fallbackSeconds
 * @returns {number} lifetime in seconds
 */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

function parseTTL(envName, fallbackSeconds) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null) return fallbackSeconds;

  const match = /^(\d+)([smhd]?)$/.exec(String(raw).trim().toLowerCase());
  if (!match) return fallbackSeconds;

  const unit = match[2] || 's';
  return parseInt(match[1], 10) * UNIT_SECONDS[unit];
}

module.exports = { parseTTL };
