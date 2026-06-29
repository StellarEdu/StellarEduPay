'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

// Issue #885: Audit records are never deleted — archived only.
// Hash chain: each entry stores the SHA-256 HMAC of its own content and a
// reference to the previous entry's hash, enabling tamper detection.
const auditLogSchema = new mongoose.Schema(
  {
    schoolId:     { type: String, required: true, index: true },
    action:       { type: String, required: true, index: true },
    performedBy:  { type: String, required: true },
    targetId:     { type: String, required: true, index: true },
    targetType:   { type: String, enum: ['student', 'payment', 'fee', 'school'], required: true, index: true },
    details:      { type: mongoose.Schema.Types.Mixed, default: {} },
    result:       { type: String, enum: ['success', 'failure'], default: 'success' },
    errorMessage: { type: String, default: null },
    ipAddress:    { type: String, default: null },
    userAgent:    { type: String, default: null },

    // #885 — Hash-chain integrity fields
    // prevHash: the entryHash of the previous audit record for this school (null for first record)
    prevHash:    { type: String, default: null },
    // entryHash: HMAC-SHA256 of this entry's canonical fields + prevHash
    entryHash:   { type: String, default: null, index: true },
    // archived: set to true by the archive job; never hard-deleted
    archived:    { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
auditLogSchema.index({ schoolId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, targetType: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, performedBy: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });
// Chain verification index: schoolId + sequential ordering
auditLogSchema.index({ schoolId: 1, _id: 1 });

// NOTE: No TTL index — audit records must be retained for compliance.
// Use the archive flag + export job for cold-tier storage offload.

auditLogSchema.plugin(tenantScope, { modelName: 'AuditLog' });

module.exports = mongoose.model('AuditLog', auditLogSchema);
