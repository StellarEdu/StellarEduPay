'use strict';

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Resolve a TTL from an environment variable, in seconds.
 *
 * Accepts a plain integer number of seconds ("28800") or an integer with a unit
 * suffix ("8h", "30d", "15m", "45s"). An unset or unparseable value falls back
 * to `defaultSeconds`.
 *
 * Units must be parsed explicitly: parseInt("8h") is 8, not 28800 (#1739).
 *
 * @param {string} envName
 * @param {number} defaultSeconds
 * @returns {number}
 */
function parseTTL(envName, defaultSeconds) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null) return defaultSeconds;

  const match = /^\s*(\d+)\s*([smhd]?)\s*$/i.exec(String(raw));
  if (!match) return defaultSeconds;

  const unit = (match[2] || 's').toLowerCase();
  const seconds = parseInt(match[1], 10) * UNIT_SECONDS[unit];
  return seconds > 0 ? seconds : defaultSeconds;
}

module.exports = { parseTTL };
