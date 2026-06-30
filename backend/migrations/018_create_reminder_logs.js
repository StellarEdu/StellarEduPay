'use strict';

/**
 * Migration 018 — Create ReminderLog collection with idempotency indexes
 *
 * Creates the reminderlogs collection with:
 *   - Unique compound index on (schoolId, studentId, windowStart) for
 *     distributed idempotency across multiple replicas
 *   - TTL index on createdAt for automatic cleanup (default: 90 days)
 */

const mongoose = require('mongoose');

async function up() {
  const db = mongoose.connection.db;
  const collectionName = 'reminderlogs';

  const collections = await db.listCollections({ name: collectionName }).toArray();
  if (collections.length === 0) {
    await db.createCollection(collectionName);
    console.log('[Migration 018] Created reminderlogs collection');
  } else {
    console.log('[Migration 018] reminderlogs collection already exists');
  }

  const collection = db.collection(collectionName);

  // Idempotency index: at most one reminder per student per day
  try {
    await collection.createIndex(
      { schoolId: 1, studentId: 1, windowStart: 1 },
      { unique: true, name: 'schoolId_1_studentId_1_windowStart_1' }
    );
    console.log('[Migration 018] Created idempotency index on reminderlogs');
  } catch (err) {
    if (err.code === 85) {
      await collection.dropIndex('schoolId_1_studentId_1_windowStart_1');
      await collection.createIndex(
        { schoolId: 1, studentId: 1, windowStart: 1 },
        { unique: true, name: 'schoolId_1_studentId_1_windowStart_1' }
      );
      console.log('[Migration 018] Recreated idempotency index on reminderlogs');
    } else {
      throw err;
    }
  }

  // TTL index: auto-purge after 90 days
  const TTL_SECONDS = process.env.REMINDER_LOG_TTL_SECONDS
    ? parseInt(process.env.REMINDER_LOG_TTL_SECONDS, 10)
    : 90 * 24 * 60 * 60;

  try {
    await collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: 'createdAt_1_ttl' }
    );
    console.log(`[Migration 018] Created TTL index on reminderlogs (${TTL_SECONDS}s)`);
  } catch (err) {
    if (err.code === 85) {
      await collection.dropIndex('createdAt_1_ttl');
      await collection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: TTL_SECONDS, name: 'createdAt_1_ttl' }
      );
      console.log(`[Migration 018] Recreated TTL index on reminderlogs (${TTL_SECONDS}s)`);
    } else {
      throw err;
    }
  }
}

async function down() {
  const db = mongoose.connection.db;
  try {
    await db.collection('reminderlogs').drop();
    console.log('[Migration 018] Dropped reminderlogs collection');
  } catch (err) {
    if (err.code === 26) {
      console.log('[Migration 018] reminderlogs collection does not exist — skipping');
    } else {
      throw err;
    }
  }
}

module.exports = { up, down };
