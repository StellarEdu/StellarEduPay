'use strict';

/**
 * Migration 036: remove Migration tracking documents with a missing or null
 * version field.
 *
 * Background (issue #1731)
 * -------------------------
 * Two migration files (032_add_audit_log_seq_index.js and
 * 035_add_payment_op_index.js) shipped without a `version` export. The runner
 * uses `Migration.version` as an upsert key:
 *
 *   findOneAndUpdate({ version: migration.version }, …, { upsert: true })
 *
 * When `migration.version` is `undefined` the filter becomes
 * `{ version: undefined }`, which MongoDB treats as `{ version: null }` and
 * matches documents where the field is absent or null. The first versionless
 * migration upserts such a document; the second finds it via the same filter,
 * sees `existing !== null`, and skips without running. 035_add_payment_op_index
 * was therefore never applied on any environment that migrated with the old
 * runner, leaving the legacy global unique txHash index in place and breaking
 * multi-operation transaction support.
 *
 * What this migration does
 * -------------------------
 * Deletes every document in the `migrations` collection whose `version` field
 * is absent, null, or an empty string. With those sentinel records gone, the
 * runner will re-attempt 032 and 035 on the next deploy — both are idempotent
 * (createIndex with the same name is a no-op if the index already exists), so
 * re-running 032 is harmless; 035 will now execute properly and backfill
 * opIndex + replace the legacy index.
 *
 * Rollback
 * ---------
 * The down() function is intentionally a no-op. The removed documents were
 * themselves artefacts of a bug and contained no useful information. Recreating
 * them would just re-introduce the silent-skip behaviour.
 */

const VERSION = '036_remove_versionless_migration_docs';

module.exports = {
  version: VERSION,

  async up(db) {
    const result = await db.collection('migrations').deleteMany({
      $or: [
        { version: { $exists: false } },
        { version: null },
        { version: '' },
      ],
    });

    if (result.deletedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[Migration 036] Removed ${result.deletedCount} versionless Migration ` +
        'document(s). Affected migrations will re-run on the next deploy.'
      );
    } else {
      // eslint-disable-next-line no-console
      console.log('[Migration 036] No versionless Migration documents found — nothing to remove.');
    }
  },

  async down(_db) {
    // Intentional no-op. The deleted documents were bug artefacts; there is
    // nothing meaningful to restore.
  },
};
