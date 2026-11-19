'use strict';

/**
 * Parse a duration from an environment variable into seconds.
 *
 * Accepts a plain number of seconds ("3600") or a number with a unit suffix:
 *   s = seconds, m = minutes, h = hours, d = days   ("8h", "30d", "15m")
 *
 * Falls back to `defaultSeconds` when the variable is unset, empty or invalid,
 * so a bad value can never produce a zero or negative token lifetime.
 *
 * @param {string} envName         Environment variable name
 * @param {number} defaultSeconds  Fallback value in seconds
 * @returns {number} Duration in seconds
 */
function parseTTL(envName, defaultSeconds) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null) return defaultSeconds;

  const match = String(raw).trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!match) return defaultSeconds;

  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return defaultSeconds;

  const multipliers = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[match[2].toLowerCase()];
}

module.exports = { parseTTL };
