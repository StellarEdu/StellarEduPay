'use strict';

/**
 * Parent self-service portal (#1637).
 *
 * Parent endpoints (requireParentAuth): read-only access to the linked
 * students' balances, payment history, receipts and payment plan, plus two
 * narrow writes — raising a dispute on one of their own payments and toggling
 * reminder emails. Every parent action is audit-logged.
 *
 * Staff endpoints (requireSchoolAuth owner/staff): issue, list and revoke
 * magic links.
 */

const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const PaymentPlan = require('../models/paymentPlanModel');
const Dispute = require('../models/disputeModel');
const School = require('../models/schoolModel');
const { getReceiptByTxHash } = require('../services/receiptService');
const { logAudit } = require('../services/auditService');
const parentPortal = require('../services/parentPortalService');
const logger = require('../utils/logger').child('ParentPortal');

const PAYMENT_FIELDS = 'txHash amount assetCode status confirmedAt createdAt feeCategory memo feeValidationStatus';

function _audit(req, action, targetId, details = {}) {
  logAudit({
    schoolId: req.schoolId,
    action,
    performedBy: req.parent ? `parent:${req.parent.tokenId}` : (req.user?.userId || req.user?.id || req.user?.email || 'unknown'),
    targetId: String(targetId),
    targetType: 'student',
    details,
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
  }).catch((err) => logger.warn('Audit log failed', { action, error: err.message }));
}

function _summarisePlan(plan) {
  if (!plan) return null;
  const now = new Date();
  const ordered = [...plan.installments].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const next = ordered.find((i) => !i.paid) || null;
  return {
    status: plan.status,
    totalAmount: plan.totalAmount,
    paidAmount: ordered.reduce((sum, i) => sum + (i.paidAmount || 0), 0),
    installmentCount: ordered.length,
    paidInstallments: ordered.filter((i) => i.paid).length,
    overdueInstallments: ordered.filter((i) => !i.paid && new Date(i.dueDate) < now).length,
    nextInstallment: next
      ? { amount: next.amount, paidAmount: next.paidAmount || 0, dueDate: next.dueDate, overdue: new Date(next.dueDate) < now }
      : null,
  };
}

function _balance(student) {
  if (student.remainingBalance !== null && student.remainingBalance !== undefined) return student.remainingBalance;
  return Math.max(0, (student.feeAmount || 0) - (student.totalPaid || 0));
}

// ── Parent endpoints ─────────────────────────────────────────────────────────

// GET /api/parent/me
async function getOverview(req, res, next) {
  try {
    const { schoolId, studentIds, expiresAt } = req.parent;
    const [school, students, plans] = await Promise.all([
      School.findOne({ schoolId }).select('name logoUrl primaryColor supportContact localCurrency').lean(),
      Student.find({ schoolId, studentId: { $in: studentIds }, deletedAt: null })
        .select('studentId name class academicYear feeAmount totalPaid remainingBalance feePaid paymentDeadline reminderOptOut fees')
        .lean(),
      PaymentPlan.find({ schoolId, studentId: { $in: studentIds }, status: 'active', deletedAt: null }).lean(),
    ]);

    const planByStudent = new Map(plans.map((p) => [p.studentId, p]));

    _audit(req, 'parent_portal_view', studentIds.join(','), { view: 'overview' });

    return res.json({
      school: school
        ? { name: school.name, logoUrl: school.logoUrl || null, primaryColor: school.primaryColor || null, supportContact: school.supportContact || null }
        : null,
      expiresAt,
      students: students.map((s) => ({
        studentId: s.studentId,
        name: s.name,
        class: s.class,
        academicYear: s.academicYear || null,
        feeAmount: s.feeAmount,
        totalPaid: s.totalPaid || 0,
        remainingBalance: _balance(s),
        feePaid: Boolean(s.feePaid),
        paymentDeadline: s.paymentDeadline || null,
        fees: (s.fees || []).map((f) => ({
          category: f.category,
          amount: f.amount,
          totalPaid: f.totalPaid || 0,
          paid: Boolean(f.paid),
        })),
        preferences: { reminderOptOut: Boolean(s.reminderOptOut) },
        paymentPlan: _summarisePlan(planByStudent.get(s.studentId)),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/parent/students/:studentId/payments?page=&limit=
async function getPaymentHistory(req, res, next) {
  try {
    const { schoolId } = req.parent;
    const { studentId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const filter = { schoolId, studentId, deletedAt: null };
    const [payments, total] = await Promise.all([
      Payment.find(filter).select(PAYMENT_FIELDS).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Payment.countDocuments(filter),
    ]);

    _audit(req, 'parent_portal_view', studentId, { view: 'payments', page });

    return res.json({
      studentId,
      page,
      limit,
      total,
      payments: payments.map((p) => ({
        txHash: p.txHash,
        amount: p.amount,
        assetCode: p.assetCode || 'XLM',
        status: p.status,
        feeCategory: p.feeCategory || null,
        feeValidationStatus: p.feeValidationStatus || null,
        confirmedAt: p.confirmedAt || null,
        createdAt: p.createdAt,
        receiptAvailable: p.status === 'SUCCESS' || p.status === 'REFUNDED',
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/parent/receipts/:txHash?format=pdf
async function getReceipt(req, res, next) {
  try {
    const { schoolId, studentIds } = req.parent;
    const receipt = await getReceiptByTxHash(req.params.txHash, schoolId);
    // 404 for receipts of other families too — never confirm they exist.
    if (!receipt || !studentIds.includes(receipt.studentId)) {
      return res.status(404).json({ error: 'Receipt not found', code: 'NOT_FOUND' });
    }

    _audit(req, 'parent_portal_receipt', receipt.studentId, { txHash: receipt.txHash, format: req.query.format || 'json' });

    const format = (req.query.format || 'json').toLowerCase();
    if (format === 'json') return res.json(receipt);
    if (format !== 'pdf') {
      return res.status(400).json({ error: "Unsupported format. Use 'json' or 'pdf'.", code: 'INVALID_FORMAT' });
    }

    const { generateReceiptPdf } = require('../services/receiptPdfService');
    const school = await School.findOne({ schoolId }).lean();
    const pdfStream = generateReceiptPdf(receipt, school);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${receipt.txHash}.pdf`);
    pdfStream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ code: 'PDF_GENERATION_ERROR', error: 'Failed to generate PDF' });
      else res.end();
    });
    return pdfStream.pipe(res);
  } catch (err) {
    next(err);
  }
}

// POST /api/parent/disputes  { txHash, reason, raisedBy? }
async function raiseDispute(req, res, next) {
  try {
    const { schoolId, studentIds } = req.parent;
    const { txHash } = req.body || {};
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const raisedBy = typeof req.body?.raisedBy === 'string' && req.body.raisedBy.trim()
      ? req.body.raisedBy.trim().slice(0, 200)
      : 'Parent (portal)';

    if (!txHash || typeof txHash !== 'string') {
      return res.status(400).json({ error: 'txHash is required.', code: 'VALIDATION_ERROR' });
    }
    if (!reason || reason.length > 1000) {
      return res.status(400).json({ error: 'reason is required (max 1000 characters).', code: 'VALIDATION_ERROR' });
    }

    const payment = await Payment.findOne({ schoolId, txHash, deletedAt: null }).select('studentId txHash').lean();
    if (!payment || !studentIds.includes(payment.studentId)) {
      return res.status(404).json({ error: 'Payment not found', code: 'NOT_FOUND' });
    }

    const existing = await Dispute.findOne({ schoolId, txHash, status: { $in: ['open', 'under_review'] } }).lean();
    if (existing) {
      return res.status(409).json({ error: 'An active dispute already exists for this payment.', code: 'DISPUTE_ALREADY_EXISTS', disputeId: existing._id });
    }

    const dispute = await Dispute.create({
      schoolId,
      txHash,
      studentId: payment.studentId,
      raisedBy: `${raisedBy} [portal]`.slice(0, 200),
      reason,
      status: 'open',
    });

    // Same behaviour as staff-raised disputes (#993): pause automation.
    await Student.findOneAndUpdate({ schoolId, studentId: payment.studentId }, { $set: { disputeHold: true } });

    _audit(req, 'parent_portal_dispute', payment.studentId, { txHash, disputeId: String(dispute._id) });

    return res.status(201).json({ id: dispute._id, txHash, studentId: payment.studentId, status: dispute.status, slaDeadline: dispute.slaDeadline });
  } catch (err) {
    next(err);
  }
}

// PUT /api/parent/students/:studentId/preferences  { reminderOptOut: boolean }
async function updatePreferences(req, res, next) {
  try {
    const { schoolId } = req.parent;
    const { studentId } = req.params;
    if (typeof req.body?.reminderOptOut !== 'boolean') {
      return res.status(400).json({ error: 'reminderOptOut must be a boolean.', code: 'VALIDATION_ERROR' });
    }
    const student = await Student.findOneAndUpdate(
      { schoolId, studentId, deletedAt: null },
      { $set: { reminderOptOut: req.body.reminderOptOut } },
      { new: true }
    ).select('studentId reminderOptOut').lean();
    if (!student) return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });

    _audit(req, 'parent_portal_preferences', studentId, { reminderOptOut: student.reminderOptOut });

    return res.json({ studentId, preferences: { reminderOptOut: Boolean(student.reminderOptOut) } });
  } catch (err) {
    next(err);
  }
}

// ── Staff endpoints ──────────────────────────────────────────────────────────

function _staffId(req) {
  return String(req.user?.userId || req.user?.id || req.user?.email || 'staff');
}

// POST /api/parent/links  { studentIds?: string[], parentEmail?: string, ttlDays?: number, send?: boolean }
async function createLink(req, res, next) {
  try {
    const { studentIds, parentEmail, ttlDays, send } = req.body || {};
    if (studentIds !== undefined && (!Array.isArray(studentIds) || studentIds.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'studentIds must be an array of strings.', code: 'VALIDATION_ERROR' });
    }
    if (parentEmail !== undefined && typeof parentEmail !== 'string') {
      return res.status(400).json({ error: 'parentEmail must be a string.', code: 'VALIDATION_ERROR' });
    }

    const link = await parentPortal.issueParentLink({
      schoolId: req.schoolId,
      studentIds,
      parentEmail,
      ttlDays,
      send: send === true,
      createdBy: _staffId(req),
    });

    _audit(req, 'parent_portal_link_issued', link.studentIds.join(','), { tokenId: link.tokenId, expiresAt: link.expiresAt, emailed: link.emailed });

    return res.status(201).json({
      tokenId: link.tokenId,
      url: link.url,
      expiresAt: link.expiresAt,
      studentIds: link.studentIds,
      emailed: link.emailed,
    });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
}

// GET /api/parent/links?studentId=&includeInactive=true
async function listLinks(req, res, next) {
  try {
    const links = await parentPortal.listParentLinks({
      schoolId: req.schoolId,
      studentId: typeof req.query.studentId === 'string' ? req.query.studentId : null,
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json({
      links: links.map((l) => ({
        tokenId: l.tokenId,
        studentIds: l.studentIds,
        createdBy: l.createdBy,
        createdAt: l.createdAt,
        expiresAt: l.expiresAt,
        revokedAt: l.revokedAt,
        revokedBy: l.revokedBy,
        lastUsedAt: l.lastUsedAt,
        useCount: l.useCount || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/parent/links/:tokenId  { reason? }
async function revokeLink(req, res, next) {
  try {
    const record = await parentPortal.revokeParentLink({
      schoolId: req.schoolId,
      tokenId: req.params.tokenId,
      revokedBy: _staffId(req),
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
    });
    if (!record) return res.status(404).json({ error: 'Active link not found', code: 'NOT_FOUND' });

    _audit(req, 'parent_portal_link_revoked', record.studentIds.join(','), { tokenId: record.tokenId });

    return res.json({ tokenId: record.tokenId, revokedAt: record.revokedAt });
  } catch (err) {
    next(err);
  }
}

// POST /api/parent/links/revoke-student/:studentId
async function revokeStudentLinks(req, res, next) {
  try {
    const revoked = await parentPortal.revokeLinksForStudent({
      schoolId: req.schoolId,
      studentId: req.params.studentId,
      revokedBy: _staffId(req),
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
    });
    _audit(req, 'parent_portal_link_revoked', req.params.studentId, { revoked });
    return res.json({ studentId: req.params.studentId, revoked });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getOverview,
  getPaymentHistory,
  getReceipt,
  raiseDispute,
  updatePreferences,
  createLink,
  listLinks,
  revokeLink,
  revokeStudentLinks,
};
