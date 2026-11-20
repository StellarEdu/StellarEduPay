#!/usr/bin/env node
'use strict';

/**
 * Migration CLI (container / deploy entrypoint)
 *
 * Unlike the repo-root scripts/migrate.js (which reaches up into backend/ and
 * is meant for local development from a full checkout), this script lives
 * inside the backend/ tree so it is present in the production Docker image and
 * can be invoked as the deploy-time migration step:
 *
 *   node scripts/migrate.js           # run all pending migrations
 *   node scripts/migrate.js rollback  # roll back the last applied migration
 *   node scripts/migrate.js check     # read-only schema-version check (no writes)
 *
 * In Kubernetes the write commands run once per release in the migration Job
 * (deploy/k8s/backend-migrate-job.yaml). The backend Deployment only runs
 * `check`, so pod restarts and HPA scale-outs never apply migrations.
 *
 * It reuses the application's own database connection configuration so pool,
 * timeout and write-concern behaviour matches the running service exactly.
 *
 * Only database settings are required here. The migration step deliberately
 * does not load the global config (which validates JWT_SECRET and
 * RECEIPT_SIGNATURE_SECRET) so schema migrations never depend on auth or
 * receipt secrets.
 */

require('dotenv').config();

if (!process.env.MONGO_URI) {
  console.error(
    '[migrate] Missing required configuration. The migration step needs:\n' +
    '  - MONGO_URI  (MongoDB connection string)\n' +
    'Set it in the environment (or via the Kubernetes Secret referenced by the ' +
    'migration Job) and re-run `node scripts/migrate.js`.',
  );
  process.exit(1);
}

const db = require('../src/config/database');
const { runMigrations, rollback, checkSchemaVersion } = require('../src/services/migrationRunner');

async function main() {
  await db.connect();

  const command = process.argv[2];
  if (command === 'rollback') {
    await rollback();
  } else if (command === 'check') {
    // Read-only: verify the migration Job already applied this image's schema.
    const result = await checkSchemaVersion();
    if (!result.ok) {
      console.error(
        '[migrate] Schema is behind this image. Pending migrations:\n' +
        result.pending.map(v => `  - ${v}`).join('\n') +
        '\nRun the migration Job (kubectl apply -f deploy/k8s/backend-migrate-job.yaml) ' +
        'before rolling out the backend Deployment.'
      );
      await db.disconnect();
      process.exit(1);
    }
    console.log(`[migrate] Schema up to date (${result.applied.length} migrations applied).`);
  } else {
    await runMigrations();
  }

  await db.disconnect();
}

main().catch(err => {
  if (err instanceof ReferenceError) {
    console.error(
      '[migrate] Migration runner crashed with a ReferenceError — this is a ' +
      'code defect in migrationRunner.js, not an operational migration ' +
      'failure against the database:', err,
    );
  } else {
    console.error('[migrate] Migration run failed:', err);
  }
  process.exit(1);
});
