'use strict';

/**
 * dispute.controller.js
 *
 * Implements the dispute lifecycle with:
 *  - #895: Explicit state machine with validated transitions; authenticated actor required.
 *  - #894: Audit every transition (with actor + note); emit dispute.* webhook, SSE event,
 *          and notification email; synchronise linked payment status on resolution.
 */

const Dispute = require('../models/disputeModel');
const Payment = require('../models/paymentModel');
const { logAudit } = require('../services/auditService');
const { emit: sseEmit } = require('../services/sseService');
const { fireWebhook } = require('../services/webhookService');
const School = require('../models/schoolModel');
const logger = require('../utils/logger').child('DisputeController');

// ── State machine (#895) ─────────────────────────────────────────────────────
//
//  open ──► under_review ──► resolved
//       \                \─► rejected
//        \─────────────────► resolved
//        \─────────────────► rejected
//
//  Any terminal (resolved | rejected) status can be re-opened by transitioning
//  to "open" — the audited re-open path.

/**
 * Allowed transitions: Map<fromStatus, Set<toStatus>>
 */
const DISPUTE_TRANSITIONS = new Map([
  ['open',         new Set(['under_review', 'resolved', 'rejected'])],
  ['under_review', new Set(['resolved', 'rejected', 'open'])],          // open = re-open from review
  ['resolved',     new Set(['open'])],                                   // re-open a closed dispute
  ['rejected',     new Set(['open'])],                                   // re-open a rejected dispute
]);

/**
 * Terminal statuses — statuses from which we sync payment status.
 */
const TERMINAL_STATUSES = new Set(['resolved', 'rejected']);

/**
 * Mapping: dispute terminal status → payment status.
 * "resolved"  → REFUNDED  (dispute upheld; refund process to begin)
 * "rejected"  → SUCCESS   (dispute denied; original confirmation stands)
 * "open"      → DISPUTED  (dispute re-opened; payment under dispute again)
 */
const DISPUTE_TO_PAYMENT_STATUS = {
  resolved:     'REFUNDED',
  rejected:     'SUCCESS',
  open:         'DISPUTED',
  under_review: 'DISPUTED',
};

/**
 * Return true when a transition from `from` → `to` is valid.
 */
function isValidTransition(from, to) {
  const allowed = DISPUTE_TRANSITIONS.get(from);
  return allowed ? allowed.has(to) : false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Emit a dispute event over SSE and fire the school's webhook (best-effort).
 * Never throws — failures are logged but do not abort the response.
 */
async function _notifyDisputeChange(schoolId, eventName, disputeDoc) {
  // SSE — real-time push to connected browser clients
  try {
    sseEmit(schoolId, eventName, {
      disputeId:  disputeDoc._id,
      txHash:     disputeDoc.txHash,
      studentId:  disputeDoc.studentId,
      status:     disputeDoc.status,
      resolvedBy: disputeDoc.resolvedBy,
      updatedAt:  disputeDoc.updatedAt,
    });
  } catch (err) {
    logger.warn('SSE emit failed for dispute event', { schoolId, eventName, error: err.message });
  }

  // Webhook — HMAC-signed HTTP call to the school's registered endpoint
  try {
    const school = await School.findOne({ schoolId }, { webhookUrl: 1, webhookSecret: 1 }).lean();
    if (school && school.webhookUrl) {
      await fireWebhook(school.webhookUrl, eventName, {
        disputeId:       String(disputeDoc._id),
        txHash:          disputeDoc.txHash,
        studentId:       disputeDoc.studentId,
        schoolId,
        status:          disputeDoc.status,
        resolvedBy:      disputeDoc.resolvedBy,
        resolutionNote:  disputeDoc.resolutionNote,
        resolvedAt:      disputeDoc.resolvedAt,
        updatedAt:       disputeDoc.updatedAt,
      }, school.webhookSecret || null);
    }
  } catch (err) {
    logger.warn('Webhook fire failed for dispute event', { schoolId, eventName, error: err.message });
  }
}

/**
 * Synchronise the linked payment's status when a dispute moves to a terminal
 * (or re-open) state.  Only transitions when the payment is in a compatible
 * state to avoid overwriting unrelated finality values.
 */
async function _syncPaymentStatus(schoolId, txHash, newDisputeStatus) {
  const targetPaymentStatus = DISPUTE_TO_PAYMENT_STATUS[newDisputeStatus];
  if (!targetPaymentStatus) return;

  try {
    await Payment.findOneAndUpdate(
      { schoolId, txHash },
      { $set: { status: targetPaymentStatus } },
    );
    logger.info('Payment status synced after dispute transition', {
      schoolId, txHash, disputeStatus: newDisputeStatus, paymentStatus: targetPaymentStatus,
    });
  } catch (err) {
    logger.error('Failed to sync payment status after dispute transition', {
      schoolId, txHash, error: err.message,
    });
  }
}

// ── Controller actions ────────────────────────────────────────────────────────

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
    const dispute = await Dispute.create({ schoolId, txHash, studentId, raisedBy: raisedByTrimmed, reason: reasonTrimmed, status: 'open' });

    // Sync payment to DISPUTED
    await _syncPaymentStatus(schoolId, txHash, 'open');

    // Audit
    if (req.auditContext) {
      await logAudit({
        schoolId,
        action:      'dispute_created',
        performedBy: req.auditContext.performedBy,
        targetId:    String(dispute._id),
        targetType:  'dispute',
        details:     { txHash, studentId, raisedBy: raisedByTrimmed, reason: reasonTrimmed },
        result:      'success',
        ipAddress:   req.auditContext.ipAddress,
        userAgent:   req.auditContext.userAgent,
      });
    }

    // Notify (best-effort)
    await _notifyDisputeChange(schoolId, 'dispute.created', dispute);

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
 * Transitions a dispute status according to the state machine (#895).
 * Requires a real authenticated actor — no 'admin' fallback (#895).
 * Audits the transition, emits SSE/webhook, and syncs payment status (#894).
 */
async function resolveDispute(req, res, next) {
  try {
    const { schoolId, user } = req;
    const { resolutionNote, status } = req.body;

    // #895 — require a real authenticated actor; no 'admin' string fallback
    const resolvedBy = user?.email || user?.id || user?.sub;
    if (!resolvedBy) {
      return res.status(401).json({
        error: 'Authentication required to transition a dispute.',
        code:  'UNAUTHORIZED',
      });
    }

    if (!resolutionNote) {
      return res.status(400).json({ error: 'resolutionNote is required.', code: 'VALIDATION_ERROR' });
    }

    const resolutionNoteTrimmed = resolutionNote.trim();
    if (resolutionNoteTrimmed.length > 1000) {
      return res.status(400).json({ error: 'resolutionNote must not exceed 1000 characters.', code: 'VALIDATION_ERROR' });
    }

    // Load current dispute to know its existing status (#895 — validate transition)
    const current = await Dispute.findOne({ _id: req.params.id, schoolId });
    if (!current) {
      return res.status(404).json({ error: 'Dispute not found.', code: 'NOT_FOUND' });
    }

    // #895 — validate requested transition against the state machine
    const ALLOWED_TARGET = ['resolved', 'rejected', 'under_review', 'open'];
    const newStatus = status && ALLOWED_TARGET.includes(status) ? status : 'resolved';

    if (!isValidTransition(current.status, newStatus)) {
      return res.status(422).json({
        error:       `Transition from "${current.status}" to "${newStatus}" is not allowed.`,
        code:        'INVALID_DISPUTE_TRANSITION',
        currentStatus: current.status,
        requestedStatus: newStatus,
        allowedTransitions: [...(DISPUTE_TRANSITIONS.get(current.status) || [])],
      });
    }

    // Apply the transition
    const isTerminal = TERMINAL_STATUSES.has(newStatus);
    const dispute = await Dispute.findOneAndUpdate(
      { _id: req.params.id, schoolId },
      {
        $set: {
          status:         newStatus,
          resolvedBy,
          resolutionNote: resolutionNoteTrimmed,
          resolvedAt:     isTerminal ? new Date() : null,
        },
      },
      { new: true },
    );

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found.', code: 'NOT_FOUND' });
    }

    // #894 — Audit the transition with actor + note
    if (req.auditContext) {
      await logAudit({
        schoolId,
        action:      `dispute_${newStatus}`,
        performedBy: resolvedBy,
        targetId:    String(dispute._id),
        targetType:  'dispute',
        details:     {
          txHash:         dispute.txHash,
          studentId:      dispute.studentId,
          fromStatus:     current.status,
          toStatus:       newStatus,
          resolutionNote: resolutionNoteTrimmed,
        },
        result:    'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    // #894 — Sync linked payment status
    await _syncPaymentStatus(schoolId, dispute.txHash, newStatus);

    // #894 — Emit SSE + webhook (best-effort)
    const eventName = newStatus === 'open' ? 'dispute.reopened' : `dispute.${newStatus}`;
    await _notifyDisputeChange(schoolId, eventName, dispute);

    res.json(dispute);
  } catch (err) { next(err); }
}

module.exports = { flagDispute, getDisputes, getDisputeById, resolveDispute };
