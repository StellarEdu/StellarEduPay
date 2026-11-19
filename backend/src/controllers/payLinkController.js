'use strict';

const { toMoney, toMoneyNumber, Decimal } = require('../utils/money');
const logger = require('../utils/logger');
const { logAudit } = require('../services/auditService');
const {
  PayLinkError,
  issuePayLink,
  revokePayLinks,
  resolvePayLink,
} = require('../services/payLinkService');

const STUDENT_ID_RE = /^[A-Za-z0-9_-]{1,28}$/;

function sendError(res, err, next) {
  if (err instanceof PayLinkError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return next(err);
}

// Same masking rule as the public student lookup: "J*** S."
function maskName(name) {
  if (!name) return 'Unknown';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return `${parts[0][0]}***`;
  return `${parts[0][0]}*** ${parts[parts.length - 1][0]}.`;
}

function remainingFor(fee) {
  const remaining = Decimal.max(0, toMoney(fee.amount).minus(toMoney(fee.totalPaid || 0)));
  return toMoneyNumber(remaining);
}

// POST /api/students/:studentId/pay-link  (owner / staff)
async function handleIssuePayLink(req, res, next) {
  const { studentId } = req.params;
  if (!STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'Invalid studentId', code: 'VALIDATION_ERROR' });
  }
  const expiresInSeconds = req.body?.expiresInSeconds;
  try {
    const link = await issuePayLink({
      schoolId: req.schoolId,
      studentId,
      ...(expiresInSeconds !== undefined ? { expiresInSeconds: Number(expiresInSeconds) } : {}),
    });
    await logAudit({
      schoolId: req.schoolId,
      action: 'PAY_LINK_ISSUED',
      performedBy: req.auditContext?.performedBy,
      targetId: studentId,
      targetType: 'student',
      details: { linkVersion: link.linkVersion, expiresAt: link.expiresAt },
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    }).catch((err) => logger.warn('[PayLink] audit write failed', { error: err.message }));
    // The token is a bearer credential for payment instructions; keep it out of caches.
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ url: link.url, expiresAt: link.expiresAt });
  } catch (err) {
    return sendError(res, err, next);
  }
}

// POST /api/students/:studentId/pay-link/revoke  (owner / staff)
async function handleRevokePayLink(req, res, next) {
  const { studentId } = req.params;
  if (!STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'Invalid studentId', code: 'VALIDATION_ERROR' });
  }
  try {
    const { linkVersion } = await revokePayLinks({ schoolId: req.schoolId, studentId });
    await logAudit({
      schoolId: req.schoolId,
      action: 'PAY_LINK_REVOKED',
      performedBy: req.auditContext?.performedBy,
      targetId: studentId,
      targetType: 'student',
      details: { linkVersion },
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    }).catch((err) => logger.warn('[PayLink] audit write failed', { error: err.message }));
    return res.json({ message: 'Pay links revoked.', linkVersion });
  } catch (err) {
    return sendError(res, err, next);
  }
}

// GET /api/pay/:token  (public)
// Returns what the pay page needs. The student ID appears only as the payment
// memo, which the parent has to send anyway.
async function handleResolvePayLink(req, res, next) {
  try {
    const { school, student } = await resolvePayLink(req.params.token);
    res.set('Cache-Control', 'no-store');
    return res.json({
      schoolName: school.name,
      walletAddress: school.stellarAddress,
      memo: student.studentId,
      memoType: 'text',
      maskedName: maskName(student.name),
      class: student.class,
      feeAmount: student.feeAmount,
      fees: (student.fees || []).map((f) => ({
        category: f.category,
        amount: f.amount,
        paid: f.paid,
        totalPaid: f.totalPaid || 0,
        remainingBalance: remainingFor(f),
      })),
    });
  } catch (err) {
    return sendError(res, err, next);
  }
}

module.exports = {
  handleIssuePayLink,
  handleRevokePayLink,
  handleResolvePayLink,
};
