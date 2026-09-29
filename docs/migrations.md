# Database migrations

All schema and data changes must go through numbered migrations in
[`backend/migrations/`](../backend/migrations) and the versioned runner in
[`backend/src/services/migrationRunner.js`](../backend/src/services/migrationRunner.js).
No ad-hoc `scripts/migrate-*.js` files are allowed in the repo root `scripts/`
folder.

## Policy

- Any schema change, index change, or data backfill must be added as a numbered
  migration under `backend/migrations/`.
- The migration runner is the only supported execution path for deploy-time or
  local database changes.
- Ad-hoc `scripts/migrate-*.js` files are forbidden. They bypass the runner,
  are not tracked in the `migrations` collection, and are explicitly rejected by
  `scripts/validate-migrations.js`.
- Migration files must export `{ version, up, down }`, where `up()` applies the
  change and `down()` either reverses it or documents a deliberate no-op when
  destruction would be unsafe.

## How migrations run

The canonical entrypoint is the backend CLI used by Docker/Kubernetes and by the
backend package script:

```bash
cd backend
npm run migrate
npm run migrate:rollback
```

The repo-root CLI delegates to the same backend script so this still works:

```bash
node scripts/migrate.js
node scripts/migrate.js rollback
```

`runMigrations()` claims each migration atomically using the unique index on
`Migration.version` as a distributed lock. This makes it safe to run
concurrently from multiple instances: only one instance applies a given
migration and the rest skip it. If a migration throws, its lock document is
removed and the process exits non-zero so rollout is blocked.

## How to add a migration

1. Create a file in `backend/migrations/` named `NNN_description.js`.
2. Use the next available three-digit number after the highest migration.
3. Export a `version` string matching the filename prefix and define `up(db)` and
   `down(db)`.
4. Keep each migration idempotent and safe to re-run. Prefer `createIndex` and
   `updateMany({ $or: [...] })` patterns that are no-op when the data is already
   in the expected state.
5. Add a clear comment describing the migration purpose, prerequisites, and any
   intentional no-op rollback behavior.

Example shape:

```js
'use strict';

const VERSION = '032_example_migration';

async function up(db) {
  const collection = db.collection('example');
  await collection.createIndex({ someField: 1 }, { background: true });
}

async function down(db) {
  const collection = db.collection('example');
  await collection.dropIndex('someField_1');
}

module.exports = { version: VERSION, up, down };
```

## Deployment flow

Migrations run automatically in the supported deploy paths before the app starts:

| Topology | Mechanism |
| --- | --- |
| Kubernetes | `backend/scripts/migrate.js` runs in an initContainer before the app container becomes ready. |
| Docker Compose | `docker-compose.yml` runs `npm run migrate && npm start` before the backend starts. |
| Local development | Run `node scripts/migrate.js` or `cd backend && npm run migrate` after pulling migration changes. |

## Validation

Run the repo validation check before or after changes:

```bash
node scripts/validate-migrations.js
```

This script rejects any forbidden root-level `scripts/migrate-*.js` file and
also checks the numbered migration layout for obvious numbering and dangling
reference issues.

## Current migration policy

The project keeps data changes in the runner and forbids hand-written ad-hoc
migration scripts. The migration layer is the only supported place for schema
fixes, index repairs, and backfills such as default-school bootstrapping and
payment uniqueness alignment.
