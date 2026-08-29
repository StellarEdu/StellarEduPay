'use strict';

/**
 * Migration 027 — Add TTL index on dailymetrics.createdAt
 *
 * metricsModel.js now declares a TTL index on createdAt so MongoDB
 * automatically removes stale daily rollups. Mongoose only creates schema
 * indexes on new collections; this migration applies the index to existing
 * ones.
 *
 * Only the DAILY collection is expired. getDashboardMetrics derives all-time
 * totals by summing monthlymetrics, so expiring those would silently shrink
 * historical figures rather than just free space — and they are tiny anyway
 * (twelve documents per school per year).
 *
 * TTL is read from DAILY_METRICS_TTL_SECONDS (default: 34560000 = 400 days).
 */

const mongoose = require('mongoose');

const VERSION = '027_add_daily_metrics_ttl_index';
const TTL_SECONDS = parseInt(
  process.env.DAILY_METRICS_TTL_SECONDS || String(400 * 24 * 60 * 60),
  10
);

/**
 * Existing indexes on a collection, tolerating a collection that has never
 * been created (NamespaceNotFound, code 26).
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<Array<object>>}
 */
async function existingIndexes(collection) {
  return collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });
}

async function up() {
  const collection = mongoose.connection.collection('dailymetrics');

  // Drop any existing TTL index on createdAt before (re)creating it, so a
  // changed DAILY_METRICS_TTL_SECONDS actually takes effect.
  for (const idx of await existingIndexes(collection)) {
    if (idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined) {
      await collection.dropIndex(idx.name);
      console.log(`[027] Dropped existing TTL index: ${idx.name}`);
    }
  }

  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
  console.log(`[027] Created TTL index on dailymetrics.createdAt (${TTL_SECONDS}s)`);
}

async function down() {
  const collection = mongoose.connection.collection('dailymetrics');

  for (const idx of await existingIndexes(collection)) {
    if (idx.key && idx.key.createdAt !== undefined && idx.expireAfterSeconds !== undefined) {
      await collection.dropIndex(idx.name);
      console.log(`[027] Dropped TTL index: ${idx.name}`);
    }
  }
}

module.exports = { version: VERSION, up, down };
