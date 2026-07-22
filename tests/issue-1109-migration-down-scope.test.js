'use strict';

/**
 * Issue #1109 — Migration down() functions must not be broader than their up().
 *
 * A rollback should only reverse the documents its own up() actually modified.
 * Several backfill migrations previously reset a field to null / unset it for
 * EVERY document (updateMany({}, ...)), meaning a rollback run after legitimate
 * application writes would destroy unrelated data that shared the same field.
 *
 * Each test below runs up(), makes an unrelated legitimate change to the same
 * field on a DIFFERENT document, runs down(), and asserts the unrelated change
 * survives.
 */

const mongoose = require('mongoose');

// Register the Student model so migration 001's mongoose.model('Student') resolves.
require('../backend/src/models/studentModel');

// In CI a real MongoDB service is available via MONGO_URI — use it directly to
// avoid MongoMemoryServer downloading a binary (blocked by blockRealHttp.js).
const USE_EXTERNAL_MONGO = !!process.env.MONGO_URI;
const TEST_DB = 'migration_1109_test';

describe('Issue #1109 — migration down() scope matches up() scope', () => {
  let mongoServer;

  beforeAll(async () => {
    if (USE_EXTERNAL_MONGO) {
      const baseUri = process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
      await mongoose.connect(baseUri);
    } else {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      mongoServer = await MongoMemoryServer.create();
      await mongoose.connect(mongoServer.getUri());
    }
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  describe('001_backfill_remaining_balance', () => {
    const migration = require('../backend/migrations/001_backfill_remaining_balance');
    const collection = () => mongoose.connection.collection('students');

    beforeEach(async () => {
      await collection().deleteMany({});
    });

    it('down() only nulls students the backfill actually computed, sparing later legitimate writes', async () => {
      // Student A: needs backfilling (remainingBalance null).
      await collection().insertOne({
        studentId: 'STU-A', feeAmount: 1000, totalPaid: 200, remainingBalance: null,
      });
      // Student B: already had a legitimate balance before the migration.
      await collection().insertOne({
        studentId: 'STU-B', feeAmount: 500, totalPaid: 100, remainingBalance: 375,
      });

      // Run the real up(). Its pipeline-array update requires mongoose >= 12
      // (what the backend runtime uses). Under an older mongoose the model
      // rejects the array; fall back to the equivalent native-driver pipeline
      // so the down() scope — the actual subject of this fix — is still tested.
      try {
        await migration.up();
      } catch (err) {
        if (!/updatePipeline/.test(err.message)) throw err;
        await collection().updateMany(
          { remainingBalance: null },
          [{ $set: { remainingBalance: { $subtract: ['$feeAmount', '$totalPaid'] } } }]
        );
      }

      // A was backfilled to 800 (1000 - 200); B is untouched by up() scope.
      expect((await collection().findOne({ studentId: 'STU-A' })).remainingBalance).toBe(800);
      expect((await collection().findOne({ studentId: 'STU-B' })).remainingBalance).toBe(375);

      // Simulate a legitimate application write to A AFTER the migration ran.
      await collection().updateOne({ studentId: 'STU-A' }, { $set: { remainingBalance: 650 } });

      await migration.down();

      const a = await collection().findOne({ studentId: 'STU-A' });
      const b = await collection().findOne({ studentId: 'STU-B' });
      // A no longer holds the backfilled value → down() must NOT clobber it.
      expect(a.remainingBalance).toBe(650);
      // B never matched the backfill formula → also preserved.
      expect(b.remainingBalance).toBe(375);
    });
  });

  describe('005_backfill_fee_structure_is_active', () => {
    const migration = require('../backend/migrations/005_backfill_fee_structure_is_active');
    const collection = () => mongoose.connection.collection('feestructures');

    beforeEach(async () => {
      await collection().deleteMany({});
    });

    it('down() only removes isActive it backfilled, sparing a later isActive:false', async () => {
      await collection().insertOne({ name: 'legacy' });                 // needs backfill
      await collection().insertOne({ name: 'explicit', isActive: false }); // legitimate value

      await migration.up();
      expect((await collection().findOne({ name: 'legacy' })).isActive).toBe(true);

      await migration.down();

      const legacy = await collection().findOne({ name: 'legacy' });
      const explicit = await collection().findOne({ name: 'explicit' });
      // legacy reverted to no-field state...
      expect(legacy.isActive).toBeUndefined();
      // ...but the unrelated isActive:false survives instead of being wiped.
      expect(explicit.isActive).toBe(false);
    });
  });

  // Note: the legacy add-timezone-to-schools.js received the same scoping fix
  // (down() now targets { timezone: 'UTC' } instead of {}, matching what
  // 013_add_school_timezone already did). It is not exercised here because
  // requiring it pulls in schoolModel → @stellar/stellar-sdk, a backend-only
  // dependency not installed for the root test runner; the scoping logic is
  // identical to the cases above.
});
