'use strict';

/**
 * Migration 005 — Backfill isActive on existing fee structures.
 *
 * feeStructureModel.js now declares isActive: { type: Boolean, default: true }.
 * Documents created before this field was added will have isActive: undefined,
 * which causes { isActive: true } queries in studentController.js to miss them.
 * This migration sets isActive = true on every document that lacks the field.
 */

const mongoose = require('mongoose');

const VERSION = '005_backfill_fee_structure_is_active';

async function up() {
  const result = await mongoose.connection
    .collection('feestructures')
    .updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });

  console.log(`[005] Backfilled isActive:true on ${result.modifiedCount} fee structure(s)`);
}

async function down() {
  // up() only set isActive:true on documents that lacked the field. Scope the
  // reversal to that same value so a fee structure that was legitimately set to
  // isActive:false after the migration keeps its value instead of being wiped.
  const result = await mongoose.connection
    .collection('feestructures')
    .updateMany({ isActive: true }, { $unset: { isActive: '' } });

  console.log(`[005] Removed isActive from ${result.modifiedCount} fee structure(s)`);
}

module.exports = { version: VERSION, up, down };
