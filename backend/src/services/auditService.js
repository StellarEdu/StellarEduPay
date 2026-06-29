'use strict';

const crypto = require('crypto');
const AuditLog = require('../models/auditLogModel');
const logger = require('../utils/logger');

// HMAC key for entry hashes. Falls back to JWT_SECRET so no new env var is
// required; operators can add AUDIT_HMAC_KEY to isolate the secret.
const HMAC_KEY = process.env.AUDIT_HMAC_KEY || process.env.JWT_SECRET || 'audit-integrity-key';

// In-process failure counter — reset on restart
let _auditFailureCount = 0;

function getAuditHealth() {
  return {
    status: _auditFailureCount === 0 ? 'ok' : 'degraded',
    recentFailures: _auditFailureCount,
  };
}

function _resetAuditFailureCount() {
  _auditFailureCount = 0;
}

/**
 * Compute a deterministic HMAC-SHA256 over the canonical fields of an entry.
 * prevHash is included so any modification to the chain is detectable.
 */
function _computeEntryHash(fields) {
  const canonical = JSON.stringify({
    schoolId:     fields.schoolId,
    action:       fields.action,
    performedBy:  fields.performedBy,
    targetId:     fields.targetId,
    targetType:   fields.targetType,
    details:      fields.details,
    result:       fields.result,
    errorMessage: fields.errorMessage ?? null,
    ipAddress:    fields.ipAddress ?? null,
    prevHash:     fields.prevHash ?? null,
    createdAt:    fields.createdAt instanceof Date ? fields.createdAt.toISOString() : fields.createdAt,
  });
  return crypto.createHmac('sha256', HMAC_KEY).update(canonical).digest('hex');
}

/**
 * Fetch the most recent audit entry's entryHash for the given schoolId.
 * Used to link the new entry into the hash chain.
 */
async function _getPrevHash(schoolId) {
  const last = await AuditLog.findOne({ schoolId })
    .sort({ _id: -1 })
    .select('entryHash')
    .lean()
    .bypassTenantScope();
  return last ? (last.entryHash || null) : null;
}

/**
 * logAudit — append-only audit entry with hash chain.
 *
 * Never throws; audit failure must not break the primary operation.
 */
async function logAudit({
  schoolId,
  action,
  performedBy,
  targetId,
  targetType,
  details = {},
  result = 'success',
  errorMessage = null,
  ipAddress = null,
  userAgent = null,
  severity = null,
}) {
  try {
    const prevHash = await _getPrevHash(schoolId);
    const createdAt = new Date();

    const entryHash = _computeEntryHash({
      schoolId, action, performedBy, targetId, targetType,
      details, result, errorMessage, ipAddress, prevHash, createdAt,
    });

    await AuditLog.create({
      schoolId,
      action,
      performedBy,
      targetId,
      targetType,
      details,
      result,
      errorMessage,
      ipAddress,
      userAgent,
      ...(severity ? { severity } : {}),
      prevHash,
      entryHash,
      createdAt,
    });
  } catch (err) {
    _auditFailureCount += 1;
    logger.error('AUDIT_LOG_FAILURE', { err, schoolId, action });
  }
}

const MAX_PAGE_SIZE = 200;

async function getAuditLogs(filters = {}) {
  const {
    schoolId, action, targetType, performedBy, result,
    startDate, endDate, cursor, page = 1, limit = 50,
  } = filters;

  const baseQuery = { schoolId };
  if (action) baseQuery.action = action;
  if (targetType) baseQuery.targetType = targetType;
  if (performedBy) baseQuery.performedBy = performedBy;
  if (result) baseQuery.result = result;
  if (startDate || endDate) {
    baseQuery.createdAt = {};
    if (startDate) baseQuery.createdAt.$gte = new Date(startDate);
    if (endDate)   baseQuery.createdAt.$lte = new Date(endDate);
  }

  const actualLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_PAGE_SIZE);
  const actualPage  = Math.max(parseInt(page,  10) || 1, 1);
  const skip = (actualPage - 1) * actualLimit;

  let indexHint;
  if (action)       indexHint = { schoolId: 1, action: 1, createdAt: -1 };
  else if (performedBy) indexHint = { schoolId: 1, performedBy: 1, createdAt: -1 };
  else if (targetType)  indexHint = { schoolId: 1, targetType: 1, createdAt: -1 };
  else              indexHint = { schoolId: 1, createdAt: -1 };

  const [logs, total] = await Promise.all([
    AuditLog.find(baseQuery)
      .hint(indexHint)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(actualLimit)
      .lean(),
    AuditLog.countDocuments(baseQuery),
  ]);

  const nextCursor =
    skip + logs.length < total && logs.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: logs[logs.length - 1].createdAt,
          _id: logs[logs.length - 1]._id,
        })).toString('base64')
      : null;

  return { logs, total, page: actualPage, limit: actualLimit, pages: Math.ceil(total / actualLimit) || 1, nextCursor };
}

async function getRecentAuditLogs(schoolId, limit = 10) {
  return AuditLog.find({ schoolId }).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * verifyAuditChain — walks the chain for a school and reports broken links.
 *
 * Returns { ok: boolean, scanned: number, broken: Array<{ _id, reason }> }
 *
 * Broken entries are those where:
 *   (a) recomputed entryHash !== stored entryHash, or
 *   (b) stored prevHash !== entryHash of the prior record.
 */
async function verifyAuditChain(schoolId, { limit = 1000 } = {}) {
  const entries = await AuditLog.find({ schoolId })
    .sort({ _id: 1 })
    .limit(limit)
    .lean()
    .bypassTenantScope();

  const broken = [];
  let prevHash = null;

  for (const entry of entries) {
    // (a) Recompute hash to detect field-level tampering
    const recomputed = _computeEntryHash({
      schoolId:     entry.schoolId,
      action:       entry.action,
      performedBy:  entry.performedBy,
      targetId:     entry.targetId,
      targetType:   entry.targetType,
      details:      entry.details,
      result:       entry.result,
      errorMessage: entry.errorMessage,
      ipAddress:    entry.ipAddress,
      prevHash:     entry.prevHash,
      createdAt:    entry.createdAt,
    });

    if (recomputed !== entry.entryHash) {
      broken.push({ _id: entry._id, reason: 'entryHash_mismatch' });
    } else if (entry.prevHash !== prevHash) {
      // (b) Chain link broken: this entry doesn't point to the previous one
      broken.push({ _id: entry._id, reason: 'chain_link_broken' });
    }

    prevHash = entry.entryHash;
  }

  return { ok: broken.length === 0, scanned: entries.length, broken };
}

/**
 * archiveAuditLogs — marks records older than retentionDays as archived=true.
 * Records are never deleted; archiving signals they can be exported to cold storage.
 */
async function archiveAuditLogs(retentionDays = 730) {
  const expiry = new Date(Date.now() - retentionDays * 86400000);
  const result = await AuditLog.updateMany(
    { createdAt: { $lt: expiry }, archived: false },
    { $set: { archived: true } },
  ).bypassTenantScope();
  if (result.modifiedCount > 0) {
    logger.info('AUDIT_LOG_ARCHIVE', { archivedCount: result.modifiedCount });
  }
  return result.modifiedCount;
}

module.exports = {
  logAudit,
  getAuditLogs,
  getRecentAuditLogs,
  getAuditHealth,
  verifyAuditChain,
  archiveAuditLogs,
  _resetAuditFailureCount,
  // Exported for testing
  _computeEntryHash,
};
