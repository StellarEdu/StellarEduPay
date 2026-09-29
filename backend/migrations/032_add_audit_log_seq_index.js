'use strict';

/**
 * Migration 032: add per-school sequence to audit logs and a unique index
 * on { schoolId, seq } so concurrent appends can be serialised.
 *
 * The audit hash chain previously linked entries by reading the latest entry
 * (findOne sorted by _id) and inserting a new one. That read/insert pair is
 * not atomic, so two concurrent writes for the same school could both read
 * the same prevHash and fork the chain. A monotonic per-school `seq` counter
 * (allocated with findOneAndUpdate + $inc) plus a unique index lets the
 * service detect and retry duplicate-key conflicts instead of forking.
 */

module.exports = {
  async up(db) {
    const collection = db.collection('auditlogs');

    // Backfill `seq` for existing entries, ordered by _id within each school.
    // ObjectId ordering is the best available approximation of insertion
    // order for legacy rows; new rows get their seq from the counter below.
    const schools = await collection.distinct('schoolId');

    for (const schoolId of schools) {
      const cursor = collection
        .find({ schoolId, seq: { $exists: false } })
        .sort({ _id: 1 });

      let seq = 0;
      // eslint-disable-next-line no-await-in-loop
      while (await cursor.hasNext()) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await cursor.next();
        seq += 1;
        // eslint-disable-next-line no-await-in-loop
        await collection.updateOne(
          { _id: doc._id },
          { $set: { seq } }
        );
      }

      // Seed the per-school counter so the next append continues the chain.
      // eslint-disable-next-line no-await-in-loop
      await db.collection('auditcounters').updateOne(
        { schoolId },
        { $set: { seq } },
        { upsert: true }
      );
    }

    // Unique index enforces the invariant that (schoolId, seq) is a total
    // order per school; duplicate-key errors are the signal used to retry.
    await collection.createIndex(
      { schoolId: 1, seq: 1 },
      { unique: true, name: 'schoolId_1_seq_1' }
    );
  },

  async down(db) {
    const collection = db.collection('auditlogs');

    try {
      await collection.dropIndex('schoolId_1_seq_1');
    } catch (err) {
      // Index may not exist; ignore.
    }

    await collection.updateMany(
      { seq: { $exists: true } },
      { $unset: { seq: '' } }
    );

    try {
      await db.collection('auditcounters').drop();
    } catch (err) {
      // Collection may not exist; ignore.
    }
  },
};
