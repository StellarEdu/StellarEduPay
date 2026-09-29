'use strict';

/**
 * Migration 018: Add classOptions field to schools (Issue #1337)
 *
 * Makes class/grade names configurable per school to support multi-country deployments.
 * Backfills with Nigerian default: ["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"]
 */

const mongoose = require('mongoose');

const VERSION = '018_add_school_class_options';

async function up() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    { classOptions: { $exists: false } },
    { $set: { classOptions: ['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'] } }
  );
  console.log(`[Migration 018] Added classOptions field to ${result.modifiedCount} schools`);
}

async function down() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    {},
    { $unset: { classOptions: '' } }
  );
  console.log(`[Migration 018] Removed classOptions field from ${result.modifiedCount} schools`);
}

module.exports = { version: VERSION, up, down };
