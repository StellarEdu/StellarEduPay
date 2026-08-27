'use strict';

/**
 * Migration 026 — Add text index on auditLogs.details
 * Issue #1342: Audit log page has no free-text search over event details.
 *
 * Creates a MongoDB text index on the `details` field so admins can search
 * audit events by free text against the JSON details payload.
 */

const mongoose = require('mongoose');

const VERSION = '026_add_audit_log_details_text_index';

async function up() {
  const db = mongoose.connection.db;
  const collection = db.collection('auditlogs');

  try {
    await collection.createIndex(
      { details: 'text' },
      { name: 'details_text' }
    );
    console.log('✓ Created text index on auditlogs: { details: "text" }');
  } catch (err) {
    if (err.code === 85) {
      await collection.dropIndex('details_text');
      await collection.createIndex(
        { details: 'text' },
        { name: 'details_text' }
      );
      console.log('✓ Recreated text index on auditlogs: { details: "text" }');
    } else {
      throw err;
    }
  }
}

async function down() {
  const db = mongoose.connection.db;
  const collection = db.collection('auditlogs');

  try {
    await collection.dropIndex('details_text');
    console.log('✓ Dropped text index on auditlogs: { details: "text" }');
  } catch (err) {
    if (err.code === 27) {
      console.log('✓ Index does not exist, skipping drop');
    } else {
      throw err;
    }
  }
}

module.exports = { version: VERSION, up, down };
