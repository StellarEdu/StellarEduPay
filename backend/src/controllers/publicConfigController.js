'use strict';

const config = require('../config');

/**
 * GET /api/public-config
 *
 * Returns non-sensitive runtime configuration values for the frontend.
 * This endpoint is intentionally unauthenticated so the frontend can read
 * it before the user logs in (e.g. to show the TestnetBanner).
 *
 * Only fields that are safe to expose publicly are included here.
 * Never include secrets, internal hostnames, or credentials.
 *
 * Issue #1583: Moving NEXT_PUBLIC_STELLAR_NETWORK out of the build-time bundle
 * so the same frontend image works for both testnet and mainnet, configured at
 * runtime. The frontend reads this endpoint at startup and uses the returned
 * `stellarNetwork` value instead of the baked-in env var.
 */
function getPublicConfig(req, res) {
  res.json({
    stellarNetwork: config.STELLAR_NETWORK,
    // The frontend may use this to validate it is talking to the correct backend.
    apiVersion: process.env.npm_package_version || null,
  });
}

module.exports = { getPublicConfig };
