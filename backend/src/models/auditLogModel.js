'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

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
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
auditLogSchema.index({ schoolId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, targetType: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, performedBy: 1, createdAt: -1 });
// Issue #668: Compound index for efficient pagination by schoolId and createdAt
auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

// TTL index for automatic document expiration
// Default: 730 days (2 years), configurable via AUDIT_LOG_RETENTION_DAYS env var
// Add jitter (±30 minutes) to spread deletions across time
const ttlDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '730', 10);
const ttlSeconds = ttlDays * 24 * 60 * 60;
const jitterSeconds = Math.floor(Math.random() * 3600) - 1800; // ±30 minutes
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds + jitterSeconds });

auditLogSchema.plugin(tenantScope, { modelName: 'AuditLog' });

module.exports = mongoose.model('AuditLog', auditLogSchema);
