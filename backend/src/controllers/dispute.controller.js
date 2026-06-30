'use strict';

const Dispute = require('../models/disputeModel');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const School  = require('../models/schoolModel');
const { emit: sseEmit } = require('../services/sseService');
const { notifyDisputeCreated, notifyDisputeResolved } = require('../services/webhookService');
const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger').child('DisputeController');

/**
 * Terminal statuses: moving to one of these closes the dispute and lifts the hold.
 */
const TERMINAL_STATUSES = ['resolved', 'rejected'];

/**
 * POST /api/disputes
 *
 * Creates a new dispute record, sets a disputeHold on the student so
 * automated reminders and downstream automation are paused, then notifies
 * the school via SSE, webhook, and audit log.
 */
async function flagDispute(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash, studentId, raisedBy, reason } = req.body;
    if (!txHash || !studentId || !raisedBy || !reason) {
      return res.status(400).json({ error: 'txHash, studentId, raisedBy, and reason are all required.', code: 'VALIDATION_ERROR' });
    }

    // Validate field lengths
    const raisedByTrimmed = raisedBy.trim();
    const reasonTrimmed = reason.trim();

    if (raisedByTrimmed.length > 200) {
      return res.status(400).json({ error: 'raisedBy must not exceed 200 characters.', code: 'VALIDATION_ERROR' });
    }
    if (reasonTrimmed.length > 1000) {
      return res.status(400).json({ error: 'reason must not exceed 1000 characters.', code: 'VALIDATION_ERROR' });
    }

    const payment = await Payment.findOne({ txHash, schoolId });
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found for this school.', code: 'NOT_FOUND' });
    }
    const existing = await Dispute.findOne({ schoolId, txHash, status: { $in: ['open', 'under_review'] } });
    if (existing) {
      return res.status(409).json({ error: 'An active dispute already exists for this payment.', code: 'DISPUTE_ALREADY_EXISTS', disputeId: existing._id });
    }

    const dispute = await Dispute.create({
      schoolId,
      txHash,
      studentId,
      raisedBy: raisedByTrimmed,
      reason: reasonTrimmed,
      status: 'open',
    });

    // ── Set hold on student ────────────────────────────────────────────────
    // Suppress automated reminders and downstream automation for the
    // duration of the dispute.
    await Student.findOneAndUpdate(
      { schoolId, studentId },
      { $set: { disputeHold: true } }
    );

    // ── Notifications ──────────────────────────────────────────────────────
    // All notifications are best-effort; a delivery failure must never roll
    // back the dispute creation.
    const disputePayload = {
      disputeId:  dispute._id.toString(),
      schoolId,
      txHash,
      studentId,
      raisedBy:   raisedByTrimmed,
      reason:     reasonTrimmed,
      status:     dispute.status,
      createdAt:  dispute.createdAt,
    };

    // 1. SSE — instant in-browser notification for connected school admins
    try {
      sseEmit(schoolId, 'dispute.created', disputePayload);
    } catch (sseErr) {
      logger.error('SSE emit failed for dispute.created', { schoolId, txHash, error: sseErr.message });
    }

    // 2. Webhook — fire to the school's registered endpoint
    try {
      const school = await School.findOne({ schoolId }).lean();
      if (school && school.webhookUrl) {
        notifyDisputeCreated(school.webhookUrl, dispute, school.webhookSecret).catch((err) => {
          logger.error('Webhook notify failed for dispute.created', { schoolId, txHash, error: err.message });
        });
      }
    } catch (schoolErr) {
      logger.error('Failed to fetch school for dispute webhook', { schoolId, error: schoolErr.message });
    }

    // 3. Audit log
    logAudit({
      schoolId,
      action:      'dispute.created',
      performedBy: raisedByTrimmed,
      targetId:    txHash,
      targetType:  'payment',
      details:     { disputeId: dispute._id.toString(), studentId, reason: reasonTrimmed, holdSet: true },
      result:      'success',
      ipAddress:   req.ip || null,
    });

    res.status(201).json(dispute);
  } catch (err) { next(err); }
}

async function getDisputes(req, res, next) {
  try {
    const { schoolId } = req;
    const { status, studentId, page = 1, limit = 50 } = req.query;
    const filter = { schoolId };
    if (status) filter.status = status;
    if (studentId) filter.studentId = studentId;
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * pageSize;
    const [disputes, total] = await Promise.all([
      Dispute.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      Dispute.countDocuments(filter),
    ]);
    res.json({ disputes, pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) { next(err); }
}

async function getDisputeById(req, res, next) {
  try {
    const dispute = await Dispute.findOne({ _id: req.params.id, schoolId: req.schoolId }).lean();
    if (!dispute) return res.status(404).json({ error: 'Dispute not found.', code: 'NOT_FOUND' });
    res.json(dispute);
  } catch (err) { next(err); }
}

/**
 * PATCH /api/disputes/:id/resolve
 *
 * Transitions the dispute to a new status. When the dispute reaches a
 * terminal status (resolved/rejected), the disputeHold is lifted on the
 * student and the school is notified via SSE, webhook, and audit log.
 */
async function resolveDispute(req, res, next) {
  try {
    const { schoolId, user } = req;
    const { resolutionNote, status } = req.body;

    // Extract admin identifier from authenticated user (JWT payload)
    const resolvedBy = user?.email || user?.id || user?.sub || 'admin';

    if (!resolutionNote) {
      return res.status(400).json({ error: 'resolutionNote is required.', code: 'VALIDATION_ERROR' });
    }

    // Validate field lengths
    const resolutionNoteTrimmed = resolutionNote.trim();

    if (resolutionNoteTrimmed.length > 1000) {
      return res.status(400).json({ error: 'resolutionNote must not exceed 1000 characters.', code: 'VALIDATION_ERROR' });
    }

    const ALLOWED = ['resolved', 'rejected', 'under_review'];
    const newStatus = status && ALLOWED.includes(status) ? status : 'resolved';
    const isTerminal = TERMINAL_STATUSES.includes(newStatus);

    const updateFields = {
      status: newStatus,
      resolvedBy,
      resolutionNote: resolutionNoteTrimmed,
      resolvedAt: isTerminal ? new Date() : null,
    };

    // Record that the hold was lifted when closing the dispute
    if (isTerminal) {
      updateFields.holdLifted = true;
    }

    const dispute = await Dispute.findOneAndUpdate(
      { _id: req.params.id, schoolId, status: { $in: ['open', 'under_review'] } },
      { $set: updateFields },
      { new: true }
    );
    if (!dispute) return res.status(404).json({ error: 'Dispute not found or already closed.', code: 'NOT_FOUND' });

    // ── Lift hold when the dispute is closed ───────────────────────────────
    if (isTerminal) {
      await Student.findOneAndUpdate(
        { schoolId, studentId: dispute.studentId },
        { $set: { disputeHold: false } }
      );
    }

    // ── Notifications ──────────────────────────────────────────────────────
    const resolvePayload = {
      disputeId:      dispute._id.toString(),
      schoolId,
      txHash:         dispute.txHash,
      studentId:      dispute.studentId,
      status:         newStatus,
      resolvedBy,
      resolutionNote: resolutionNoteTrimmed,
      resolvedAt:     dispute.resolvedAt,
      holdLifted:     isTerminal,
    };

    // 1. SSE
    try {
      sseEmit(schoolId, 'dispute.resolved', resolvePayload);
    } catch (sseErr) {
      logger.error('SSE emit failed for dispute.resolved', { schoolId, error: sseErr.message });
    }

    // 2. Webhook
    try {
      const school = await School.findOne({ schoolId }).lean();
      if (school && school.webhookUrl) {
        notifyDisputeResolved(school.webhookUrl, dispute, school.webhookSecret).catch((err) => {
          logger.error('Webhook notify failed for dispute.resolved', { schoolId, error: err.message });
        });
      }
    } catch (schoolErr) {
      logger.error('Failed to fetch school for dispute webhook', { schoolId, error: schoolErr.message });
    }

    // 3. Audit log
    logAudit({
      schoolId,
      action:      'dispute.resolved',
      performedBy: resolvedBy,
      targetId:    dispute.txHash,
      targetType:  'payment',
      details:     {
        disputeId:      dispute._id.toString(),
        studentId:      dispute.studentId,
        newStatus,
        resolutionNote: resolutionNoteTrimmed,
        holdLifted:     isTerminal,
      },
      result:     'success',
      ipAddress:  req.ip || null,
    });

    res.json(dispute);
  } catch (err) { next(err); }
}

module.exports = { flagDispute, getDisputes, getDisputeById, resolveDispute };
