#!/usr/bin/env node
'use strict';

/**
 * Thin delegate for local development.
 *
 * The canonical migration CLI lives in backend/scripts/migrate.js because it is
 * included in the production image and used by Docker/Kubernetes deploy flows.
 * The repo-root script exists only to preserve the existing local workflow and
 * to forward to the backend entrypoint without duplicating logic.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const backendScript = path.join(__dirname, '../backend/scripts/migrate.js');
const result = spawnSync(process.execPath, [backendScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('[migrate] Failed to launch backend migration CLI:', result.error);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
