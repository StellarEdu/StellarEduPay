'use strict';

/**
 * Migration 033 — backfill the default school for legacy single-school data.
 *
 * This is the versioned replacement for the old ad-hoc
 * scripts/migrate-default-school.js. It is intentionally safe to re-run and
 * does not hard-fail when SCHOOL_WALLET_ADDRESS is absent, because pre-
 * multi-school deployments may not need the default-school bootstrap at all.
 *
 * Behavior:
 *   - Ensure a `schools` document exists with `schoolId === 'SCH-DEFAULT'` when
 *     `SCHOOL_WALLET_ADDRESS` is present.
 *   - Backfill `schoolId` onto existing `students`, `payments`,
 *     `feeStructures`, `paymentIntents`, and `pendingVerifications` records that
 *     are missing it.
 *
 * Rollback:
 *   down() is intentionally a no-op for data safety. Deleting the default school
 *   or mass-unsetting schoolId values would corrupt production-like data and is
 *   not appropriate as a generic rollback.
 */

const VERSION = '033_backfill_default_school';
const DEFAULT_SCHOOL_ID = 'SCH-DEFAULT';

async function up(db) {
  const schoolWalletAddress = process.env.SCHOOL_WALLET_ADDRESS;
  const schoolCollection = db.collection('schools');

  if (schoolWalletAddress) {
    const stellarNetwork = process.env.STELLAR_NETWORK || 'testnet';
    const school = await schoolCollection.findOneAndUpdate(
      { schoolId: DEFAULT_SCHOOL_ID },
      {
        $set: {
          schoolId: DEFAULT_SCHOOL_ID,
          name: 'Default School',
          slug: 'default',
          stellarAddress: schoolWalletAddress,
          network: stellarNetwork,
          isActive: true,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      }
    );

    if (school && school.value) {
      console.log(`[Migration 033] Ensured default school exists: ${school.value.schoolId}`);
    } else if (school) {
      console.log(`[Migration 033] Ensured default school exists: ${school.schoolId}`);
    }
  } else {
    console.log('[Migration 033] SCHOOL_WALLET_ADDRESS is unset; default-school bootstrap is skipped (no-op).');
  }

  const collections = [
    'students',
    'payments',
    'feeStructures',
    'paymentIntents',
    'pendingVerifications',
  ];

  for (const collectionName of collections) {
    const collection = db.collection(collectionName);
    const result = await collection.updateMany(
      { schoolId: { $exists: false } },
      { $set: { schoolId: DEFAULT_SCHOOL_ID } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[Migration 033] Backfilled ${result.modifiedCount} ${collectionName} document(s) to ${DEFAULT_SCHOOL_ID}`);
    } else {
      console.log(`[Migration 033] No ${collectionName} documents missing schoolId were found.`);
    }
  }
}

async function down() {
  // Intentionally a no-op. Removing the default school or mass-unsetting
  // schoolId values would be destructive for a live deployment and is not a
  // safe generic rollback path.
  console.log('[Migration 033] down() is intentionally a no-op; default-school backfill is preserved.');
}

module.exports = { version: VERSION, up, down };
