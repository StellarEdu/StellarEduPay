'use strict';

/**
 * Parse a token TTL from an environment variable.
 *
 * Accepts plain seconds ("3600") or a number with a unit suffix ("8h", "30d",
 * "15m", "45s"). Missing or malformed values fall back to `defaultSeconds`.
 *
 * `sessionStore` required this module but it was never created, so loading
 * sessionStore (and therefore tokenService and mfaController) threw
 * "Cannot find module '../utils/ttl'". The logic matches the original
 * definition that lived in authController (#595).
 *
 * @param {string} envVar          Environment variable name to read.
 * @param {number} defaultSeconds  Value used when the variable is unset or invalid.
 * @returns {number} TTL in seconds.
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
