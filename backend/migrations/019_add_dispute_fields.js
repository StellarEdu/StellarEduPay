'use strict';

/**
 * Migration 019 — Add evidence, SLA tracking, and assignment fields to disputes
 *
 * Adds the following fields to existing dispute documents:
 *   evidence         — array of { type, url, description, uploadedAt }
 *   txReference      — additional transaction reference string
 *   slaDeadline      — auto-calculated from createdAt + DISPUTE_SLA_HOURS (default 72h)
 *   slaBreachedAt    — set when SLA deadline passes
 *   escalationLevel  — 0=normal, 1=warning, 2=breached
 *   escalatedAt      — when escalation occurred
 *   lastActivityAt   — tracks most recent modification
 *   assignedTo       — admin handling the dispute
 *   resolutionNote   — extended to 2000 chars
 */

const mongoose = require('mongoose');

const DISPUTE_SLA_HOURS = parseInt(process.env.DISPUTE_SLA_HOURS, 10) || 72;

async function up() {
  const db = mongoose.connection.db;
  const collection = db.collection('disputes');

  // Add default slaDeadline for existing disputes based on createdAt
  await collection.updateMany(
    { slaDeadline: { $exists: false } },
    [{ $set: {
      slaDeadline: {
        $add: [
          { $ifNull: ['$createdAt', new Date()] },
          DISPUTE_SLA_HOURS * 60 * 60 * 1000,
        ],
      },
      escalationLevel: { $ifNull: ['$escalationLevel', 0] },
      lastActivityAt: { $ifNull: ['$lastActivityAt', '$updatedAt'] },
      evidence: { $ifNull: ['$evidence', []] },
    } }]
  );

  console.log('[Migration 019] Added SLA and evidence fields to disputes');

  // Create index for SLA queries
  try {
    await collection.createIndex(
      { slaDeadline: 1, status: 1 },
      { name: 'slaDeadline_1_status_1' }
    );
    console.log('[Migration 019] Created SLA index on disputes');
  } catch (err) {
    if (err.code === 85) {
      await collection.dropIndex('slaDeadline_1_status_1');
      await collection.createIndex(
        { slaDeadline: 1, status: 1 },
        { name: 'slaDeadline_1_status_1' }
      );
      console.log('[Migration 019] Recreated SLA index on disputes');
    } else {
      throw err;
    }
  }

  try {
    await collection.createIndex(
      { escalationLevel: 1, status: 1 },
      { name: 'escalationLevel_1_status_1' }
    );
    console.log('[Migration 019] Created escalation index on disputes');
  } catch (err) {
    if (err.code === 85) {
      await collection.dropIndex('escalationLevel_1_status_1');
      await collection.createIndex(
        { escalationLevel: 1, status: 1 },
        { name: 'escalationLevel_1_status_1' }
      );
      console.log('[Migration 019] Recreated escalation index on disputes');
    } else {
      throw err;
    }
  }
}

async function down() {
  const db = mongoose.connection.db;
  const collection = db.collection('disputes');

  await collection.updateMany(
    {},
    {
      $unset: {
        evidence: '',
        txReference: '',
        slaDeadline: '',
        slaBreachedAt: '',
        escalationLevel: '',
        escalatedAt: '',
        lastActivityAt: '',
        assignedTo: '',
      },
    }
  );

  try {
    await collection.dropIndex('slaDeadline_1_status_1');
    await collection.dropIndex('escalationLevel_1_status_1');
    console.log('[Migration 019] Dropped SLA and escalation indexes');
  } catch (err) {
    if (err.code === 27) {
      console.log('[Migration 019] Indexes did not exist — skipping drop');
    } else {
      throw err;
    }
  }

  console.log('[Migration 019] Removed SLA and evidence fields from disputes');
}

module.exports = { up, down };
