'use strict';

/**
 * Build information for the running service (#1634).
 *
 * The version comes from backend/package.json, which release-please bumps on
 * every release. The commit SHA and build time are injected at image build
 * time (see backend/Dockerfile build args) and fall back to "unknown" for
 * local runs.
 */

const pkg = require('../../package.json');

const buildInfo = Object.freeze({
  service: 'stellaredupay-backend',
  version: process.env.APP_VERSION || pkg.version,
  commit: process.env.GIT_SHA || 'unknown',
  buildTime: process.env.BUILD_TIME || 'unknown',
  node: process.version,
});

function getBuildInfo() {
  return buildInfo;
}

module.exports = { getBuildInfo };
