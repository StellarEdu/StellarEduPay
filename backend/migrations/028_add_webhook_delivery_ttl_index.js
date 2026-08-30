'use strict';

/**
 * Migration 028 — Add TTL index on webhookdeliveries.createdAt
 *
 * webhookDeliveryModel declares a TTL index on createdAt, but Mongoose only
 * creates schema indexes on collections it creates. Any deployment whose
 * webhookdeliveries collection predates that declaration never got the index,
 * so the collection has been growing without bound there — one document per
 * delivery attempt, per endpoint, per school.
 *
 * Retention comes from WEBHOOK_DELIVERY_RETENTION_DAYS (default 90). The older
 * WEBHOOK_DELIVERY_TTL_SECONDS still takes precedence when set, so a
 * deployment that already configured it keeps the retention it chose.
 */

const mongoose = require('mongoose');
const { resolveTtlSeconds } = require('../src/models/webhookDeliveryModel');

const VERSION = '028_add_webhook_delivery_ttl_index';
const COLLECTION = 'webhookdeliveries';

/**
 * Existing indexes on a collection, tolerating one that has never been created
 * (NamespaceNotFound, code 26).
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<Array<object>>}
 */
async function existingIndexes(collection) {
  return collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });
}

/**
 * Drops any TTL index on createdAt, so a changed retention actually takes
 * effect — MongoDB will not alter expireAfterSeconds on an existing index.
 * @param {import('mongodb').Collection} collection
 * @param {string} label - Log prefix
 */
async function dropCreatedAtTtl(collection, label) {
  for (const idx of await existingIndexes(collection)) {
    if (idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined) {
      await collection.dropIndex(idx.name);
      console.log(`[028] ${label} existing TTL index: ${idx.name}`);
    }
  }
}

async function up() {
  const collection = mongoose.connection.collection(COLLECTION);
  const ttlSeconds = resolveTtlSeconds();

  await dropCreatedAtTtl(collection, 'Dropped');

  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds });
  console.log(
    `[028] Created TTL index on ${COLLECTION}.createdAt ` +
      `(${ttlSeconds}s = ${Math.round(ttlSeconds / 86400)} days)`,
  );
}

async function down() {
  const collection = mongoose.connection.collection(COLLECTION);
  await dropCreatedAtTtl(collection, 'Dropped');
}

module.exports = { version: VERSION, up, down };
