/**
 * Migration: Remove TTL index from auditLogModel
 *
 * Audit entries must never be hard-deleted before they are archived. The
 * archive-instead-of-delete policy (see services/auditLogCleanupService.js)
 * marks old entries as archived=true so they can be offloaded to cold
 * storage; a MongoDB TTL index would silently delete those same documents at
 * the same age, defeating the policy and breaking hash-chain verification.
 *
 * This migration therefore drops any TTL index on the auditlogs collection
 * and does NOT create a replacement. Retention is controlled by the single
 * AUDIT_LOG_RETENTION_DAYS setting consumed by the cleanup service.
 */

const mongoose = require('mongoose');

const VERSION = '002_add_audit_log_ttl_index';

async function dropTtlIndexes(collection) {
  // getIndexes() throws NamespaceNotFound (code 26) when the collection has
  // never been created (e.g. a fresh database) — that just means there is
  // nothing to drop yet, not a failure.
  let indexes = {};
  try {
    indexes = await collection.getIndexes();
  } catch (error) {
    if (error.code !== 26) throw error;
  }
  for (const [indexName, indexSpec] of Object.entries(indexes)) {
    if (indexSpec.expireAfterSeconds !== undefined) {
      await collection.dropIndex(indexName);
      console.log(`Dropped TTL index: ${indexName}`);
    }
  }
}

async function up() {
  const db = mongoose.connection;
  const collection = db.collection('auditlogs');

  try {
    await dropTtlIndexes(collection);
    console.log(
      'Audit log TTL index removed; entries are archived, never hard-deleted.'
    );
  } catch (error) {
    console.error('Error removing audit log TTL index:', error);
    throw error;
  }
}

async function down() {
  const db = mongoose.connection;
  const collection = db.collection('auditlogs');

  try {
    await dropTtlIndexes(collection);
  } catch (error) {
    console.error('Error dropping TTL index:', error);
    throw error;
  }
}

module.exports = { version: VERSION, up, down };
