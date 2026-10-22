const fs = require('fs');
const path = require('path');
const Migration = require('../models/migrationModel');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

/**
 * Run all pending migrations in version order.
 *
 * Distributed locking strategy
 * -----------------------------
 * The unique index on Migration.version is used as an atomic lock.
 * Before running a migration we attempt to insert the document via
 * findOneAndUpdate with upsert:true and $setOnInsert. MongoDB guarantees
 * that only one writer wins the upsert race:
 *
 *   - Winner  (result === null): document did not exist → we own the lock,
 *     run the migration, then mark it complete.
 *   - Loser   (result !== null): document already existed → another instance
 *     already ran or is running this migration, skip it.
 *
 * If the migration throws, the document remains in the collection with
 * status 'locked'. On the next startup the runner will see the existing
 * document and skip it (safe — a failed migration should be fixed and
 * re-deployed, not silently retried). The lockedAt field lets operators
 * identify stuck locks.
 *
 * @param {Function} [_require] - injectable require for testing
 * @param {object} [_db] - injectable database handle for testing
 */
async function runMigrations(_require = require, _db = null) {
  // Fail loudly rather than silently no-op. The migrations directory is a
  // required part of every deployment (it is copied into the production image
  // by backend/Dockerfile). If it is missing here we are almost certainly in a
  // broken build/deploy where migrations would otherwise be skipped without a
  // trace — that must abort the run so the operator notices, not proceed as if
  // there were nothing to apply.
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `[Migration] Migrations directory not found at "${MIGRATIONS_DIR}". ` +
      'The production image must include the migrations/ directory ' +
      '(see backend/Dockerfile). Refusing to continue.'
    );
  }

  // Get database handle if not injected (normal operation)
  let db = _db;
  if (!db) {
    const databaseConfig = require('../config/database');
    const connection = databaseConfig.getConnection();
    db = connection.db;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  // Validate every migration file before running any of them. A missing or
  // mismatched version would cause the runner to silently skip migrations
  // (multiple files sharing version: undefined collapse to one DB document),
  // so we fail the entire run immediately rather than let that happen.
  const validationErrors = [];
  for (const file of files) {
    const migration = _require(path.join(MIGRATIONS_DIR, file));
    const expectedVersion = path.basename(file, '.js');

    if (!migration.version || typeof migration.version !== 'string' || migration.version.trim() === '') {
      validationErrors.push(
        `  • ${file}: missing or empty "version" export ` +
        `(expected version: '${expectedVersion}')`
      );
    } else if (migration.version !== expectedVersion) {
      validationErrors.push(
        `  • ${file}: version mismatch — ` +
        `exported '${migration.version}' but filename requires '${expectedVersion}'`
      );
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(
      '[Migration] One or more migration files fail the export contract. ' +
      'Every migration must export { version, up, down } where version === basename(file, ".js").\n' +
      validationErrors.join('\n')
    );
  }

  for (const file of files) {
    const migration = _require(path.join(MIGRATIONS_DIR, file));

    // Atomically claim this migration. $setOnInsert only fires on insert,
    // so if the document already exists the operation is a no-op and returns
    // the existing document (new:false). A null result means we inserted it.
    const existing = await Migration.findOneAndUpdate(
      { version: migration.version },
      { $setOnInsert: { version: migration.version, lockedAt: new Date() } },
      { upsert: true, new: false }
    );

    if (existing !== null) {
      // Document already existed — another instance owns or completed this migration.
      continue;
    }

    // We won the lock — run the migration.
    const logger = require('../utils/logger').child('Migration');
    logger.info(`Running: ${migration.version}`);
    try {
      await migration.up(db);
    } catch (err) {
      // Remove the lock document so the migration is not silently skipped on
      // the next run — the operator must fix the migration and redeploy.
      await Migration.deleteOne({ version: migration.version });
      throw err;
    }
    await Migration.findOneAndUpdate(
      { version: migration.version },
      { $set: { appliedAt: new Date() } }
    );
    logger.info(`Applied: ${migration.version}`);
  }
}

/**
 * Roll back the last applied migration.
 *
 * Finds the most recently applied Migration record, loads the corresponding
 * file, calls its down() function, then removes the record so the migration
 * can be re-applied later.
 *
 * @param {Function} [_require] - injectable require for testing
 * @param {object} [_db] - injectable database handle for testing
 */
async function rollback(_require = require, _db = null) {
  const last = await Migration.findOne({ appliedAt: { $exists: true } })
    .sort({ appliedAt: -1 });

  if (!last) {
    const logger = require('../utils/logger').child('Migration');
    logger.info('Nothing to roll back.');
    return;
  }

  // Get database handle if not injected (normal operation)
  let db = _db;
  if (!db) {
    const databaseConfig = require('../config/database');
    const connection = databaseConfig.getConnection();
    db = connection.db;
  }

  // Find the matching file by version string
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'))
    : [];

  const file = files.find(f => {
    const m = _require(path.join(MIGRATIONS_DIR, f));
    return m.version === last.version;
  });

  if (!file) {
    throw new Error(`[Migration] File for version "${last.version}" not found.`);
  }

  const migration = _require(path.join(MIGRATIONS_DIR, file));

  if (typeof migration.down !== 'function') {
    throw new Error(`[Migration] "${last.version}" does not export a down() function.`);
  }

  const logger = require('../utils/logger').child('Migration');
  logger.info(`Rolling back: ${last.version}`);
  await migration.down(db);
  await Migration.deleteOne({ version: last.version });
  logger.info(`Rolled back: ${last.version}`);
}

module.exports = { runMigrations, rollback };
