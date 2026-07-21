'use strict';

/**
 * Admin management of payment limits (#1117).
 *
 * Limits are a fraud-prevention control, so every change is audit-logged with
 * the before and after values. An operator tightening a ceiling mid-incident
 * leaves the same trail as any other sensitive action, and the previous value
 * is recoverable from the log rather than only from a deploy diff.
 */

const {
  resolveLimits,
  getStoredLimits,
  setSystemLimits,
  setSchoolLimits,
  clearSchoolLimits,
} = require('../services/paymentLimitsService');
const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger').child('PaymentLimitsAdmin');

const GLOBAL_SCOPE = '__global__';

function actorFrom(req) {
  return req.user?.email || req.user?.id || req.adminId || 'unknown';
}

/**
 * GET /api/admin/payment-limits
 * Optional ?schoolId= to include that school's override and effective values.
 */
async function getLimits(req, res, next) {
  try {
    const { schoolId, asset } = req.query;
    const stored = await getStoredLimits(schoolId);
    const effective = await resolveLimits({ schoolId, asset });

    res.json({
      scope: schoolId || GLOBAL_SCOPE,
      // `source` tells the operator which layer actually supplied the value —
      // without it, a school override silently masking a global change is
      // indistinguishable from the change not having applied.
      effective,
      stored,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/admin/payment-limits
 * Body: { default?: {min,max}, assets?: {CODE:{min,max}}, schoolId?: string }
 * Omitting schoolId sets the global limits.
 */
async function updateLimits(req, res, next) {
  const { schoolId, ...doc } = req.body || {};
  const actor = actorFrom(req);

  try {
    const before = await getStoredLimits(schoolId);
    const stored = schoolId
      ? await setSchoolLimits(schoolId, doc)
      : await setSystemLimits(doc);

    await logAudit({
      schoolId: schoolId || GLOBAL_SCOPE,
      action: 'PAYMENT_LIMITS_UPDATED',
      performedBy: actor,
      targetId: schoolId || GLOBAL_SCOPE,
      targetType: 'PaymentLimits',
      details: {
        scope: schoolId ? 'school' : 'global',
        before: schoolId ? before.school : before.system,
        after: stored,
      },
      severity: 'high',
      ipAddress: req.ip || null,
      userAgent: req.get?.('user-agent') || null,
    });

    logger.info('Payment limits updated', { scope: schoolId || GLOBAL_SCOPE, actor });
    res.json({ scope: schoolId || GLOBAL_SCOPE, stored });
  } catch (err) {
    if (err.code === 'INVALID_PAYMENT_LIMITS') {
      // Log rejected attempts too — a series of malformed writes against a
      // security control is itself worth seeing in the audit trail.
      await logAudit({
        schoolId: schoolId || GLOBAL_SCOPE,
        action: 'PAYMENT_LIMITS_UPDATE_REJECTED',
        performedBy: actor,
        targetId: schoolId || GLOBAL_SCOPE,
        targetType: 'PaymentLimits',
        details: { attempted: doc },
        result: 'failure',
        errorMessage: err.message,
        ipAddress: req.ip || null,
      });
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    }
    next(err);
  }
}

/**
 * DELETE /api/admin/payment-limits/:schoolId
 * Removes a school override so it falls back to the global limits.
 */
async function deleteSchoolLimits(req, res, next) {
  const { schoolId } = req.params;
  try {
    const before = await getStoredLimits(schoolId);
    await clearSchoolLimits(schoolId);

    await logAudit({
      schoolId,
      action: 'PAYMENT_LIMITS_CLEARED',
      performedBy: actorFrom(req),
      targetId: schoolId,
      targetType: 'PaymentLimits',
      details: { before: before.school },
      severity: 'high',
      ipAddress: req.ip || null,
      userAgent: req.get?.('user-agent') || null,
    });

    res.json({ scope: schoolId, cleared: true });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    }
    next(err);
  }
}

module.exports = { getLimits, updateLimits, deleteSchoolLimits };
