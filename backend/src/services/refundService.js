'use strict';

/**
 * refundService — full refund lifecycle management.
 *
 * Changes in this revision:
 *
 *   #1567 — Partial refunds: amount may be ≤ (payment.amount − already refunded).
 *            Refund rejection: rejectRefund() restores payment to SUCCESS.
 *
 *   #1566 — Atomic writes: initiateRefund, approveRefund, and updateRefundStatus
 *            each wrap their DB operations in a MongoDB session.withTransaction
 *            so Refund, Payment, and Outbox always commit together or not at all.
 *
 *   #1565 — Two-person approval: initiatedBy / approvedBy are stored as
 *            { userId, displayName } objects. The self-approval check now
 *            compares stable userId strings. Principals with userId 'unknown'
 *            are rejected outright.  requireSchoolAuth(['owner', 'staff']) is
 *            used on routes so tenant operators (not just super-admin) may
 *            participate in the approval flow.
 *
 *   #1564 — Execution flow: completeRefund() accepts the on-chain refund txHash,
 *            moves the refund to 'confirmed', marks the payment REFUNDED, and
 *            recalculates student balance. rejectRefund() moves the refund to
 *            'rejected' and restores the payment to SUCCESS.
 *            updateRefundStatus() now emits refund.status_changed so the
 *            paymentSavedSubscribers webhook subscriber fires on completion.
 */

const mongoose = require('mongoose');
const Refund = require('../models/refundModel');
const Payment = require('../models/paymentModel');
const Outbox = require('../models/outboxModel');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger').child('RefundService');
const lock = require('./distributedLock');
const paymentEvents = require('../events/paymentEvents');

// TTL for the per-payment refund lock. Long enough for the DB operations to
// complete; short enough to auto-expire after a crash without blocking permanently.
const REFUND_LOCK_TTL_MS = 30_000;

// Statuses that represent an active (non-terminal) refund. A payment that already
// has one of these is not eligible for a new refund request.
const ACTIVE_REFUND_STATUSES = ['approval_pending', 'pending', 'submitted', 'confirmed'];

// Valid status transitions for a refund lifecycle.
// 'rejected' and 'failed' are terminal states with no outgoing transitions.
// 'confirmed' is a terminal success state.
const REFUND_STATUS_TRANSITIONS = {
  approval_pending: ['pending', 'rejected', 'failed'],
  pending:          ['submitted', 'failed'],
  submitted:        ['confirmed', 'failed'],
  confirmed:        [],
  rejected:         [],
  failed:           [],
};

const VALID_REFUND_STATUSES = Object.keys(REFUND_STATUS_TRANSITIONS);

/**
 * Return a deterministic Redis key for a given payment refund operation.
 * @param {string} schoolId
 * @param {string} originalTxHash
 */
function refundLockKey(schoolId, originalTxHash) {
  return `refund:lock:${schoolId}:${originalTxHash}`;
}

/**
 * Construct a principal object from an auth context.
 * Throws UNKNOWN_PRINCIPAL if no stable userId can be determined — this
 * prevents 'unknown' from silently matching another 'unknown' and bypassing
 * two-person approval (Issue #1565).
 *
 * @param {object} auditContext - req.auditContext populated by auditContext middleware
 * @param {object} [admin]      - req.admin decoded JWT payload (optional)
 * @returns {{ userId: string, displayName: string }}
 */
function buildPrincipal(auditContext, admin) {
  // Prefer DB user ID; fall back to email; the env super-admin has userId 'super_admin'
  // but we enrich it with a descriptive name so the comparison is per-token not per-role.
  const userId =
    admin?.id ||           // DB-stored user ObjectId
    admin?._id?.toString() ||
    admin?.userId ||       // env super-admin constant
    auditContext?.performedBy;

  if (!userId || userId === 'unknown') {
    const err = new Error('Cannot initiate or approve a refund: caller identity could not be established. Ensure you are authenticated with a stable user account.');
    err.code = 'UNKNOWN_PRINCIPAL';
    throw err;
  }

  const displayName =
    admin?.email ||
    admin?.username ||
    admin?.name ||
    auditContext?.performedBy ||
    userId;

  return { userId, displayName };
}

// ──────────────────────────────────────────────────────────────────────────────
// initiateRefund
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Initiate a refund request.
 *
 * #1567: amount may be a partial refund — any positive value up to (original
 * payment amount − sum of already-confirmed refunds for that payment).
 *
 * #1566: Refund document, payment status change (SUCCESS → REFUND_PENDING), and
 * Outbox event all commit atomically in a single MongoDB transaction.
 *
 * #1565: principal must be a stable userId object; 'unknown' is rejected.
 *
 * @param {string}  schoolId
 * @param {string}  originalTxHash
 * @param {string}  studentId
 * @param {number}  amount          — positive, ≤ refundable amount
 * @param {string}  reason
 * @param {object}  principal       — { userId, displayName } from buildPrincipal()
 * @returns {Promise<Refund>}
 */
async function initiateRefund(schoolId, originalTxHash, studentId, amount, reason, principal) {
  if (!principal || !principal.userId || principal.userId === 'unknown') {
    const err = new Error('Cannot initiate refund: caller identity unknown');
    err.code = 'UNKNOWN_PRINCIPAL';
    throw err;
  }

  const lockKey = refundLockKey(schoolId, originalTxHash);
  const acquired = await lock.acquire(lockKey, REFUND_LOCK_TTL_MS);
  if (!acquired) {
    const err = new Error('A refund for this payment is already being processed. Please try again shortly.');
    err.code = 'REFUND_LOCK_CONTENDED';
    throw err;
  }

  const { token } = acquired;
  let session;
  try {
    const payment = await Payment.findOne({ schoolId, txHash: originalTxHash, status: 'SUCCESS' });
    if (!payment) {
      const err = new Error('Original payment not found or not in SUCCESS status');
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    // #1567 — Validate partial refund amount.
    if (!amount || amount <= 0) {
      const err = new Error('Refund amount must be a positive number');
      err.code = 'INVALID_AMOUNT';
      throw err;
    }

    // Sum all previously confirmed refunds for this payment to determine how
    // much of the original amount is still available to refund.
    const confirmedRefundsAgg = await Refund.aggregate([
      {
        $match: {
          schoolId,
          originalTxHash,
          status: 'confirmed',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const alreadyRefunded = confirmedRefundsAgg.length ? confirmedRefundsAgg[0].total : 0;
    const refundable = parseFloat((payment.amount - alreadyRefunded).toFixed(7));

    if (amount > refundable) {
      const err = new Error(
        `Refund amount ${amount} exceeds the refundable amount ${refundable} ` +
        `(original: ${payment.amount}, already refunded: ${alreadyRefunded})`
      );
      err.code = 'AMOUNT_EXCEEDS_REFUNDABLE';
      err.refundable = refundable;
      err.alreadyRefunded = alreadyRefunded;
      err.originalAmount = payment.amount;
      throw err;
    }

    // Guard: reject if an active (non-terminal) refund already exists.
    const existingRefund = await Refund.findOne({
      schoolId,
      originalTxHash,
      status: { $in: ACTIVE_REFUND_STATUSES },
    });
    if (existingRefund) {
      const err = new Error(`A refund for this payment already exists (status: ${existingRefund.status}, id: ${existingRefund._id})`);
      err.code = 'REFUND_ALREADY_EXISTS';
      err.refundId = existingRefund._id.toString();
      throw err;
    }

    // #1566 — Atomic writes via MongoDB session.withTransaction.
    session = await mongoose.connection.startSession();
    let refund;
    await session.withTransaction(async () => {
      // 1. Create the Refund document.
      [refund] = await Refund.create(
        [{
          schoolId,
          originalTxHash,
          studentId,
          amount,
          status: 'approval_pending',
          reason,
          initiatedBy: principal,
        }],
        { session }
      );

      // 2. Move payment to REFUND_PENDING (not immediately REFUNDED — #1564).
      payment.$locals.adminOverride = true;
      payment.status = 'REFUND_PENDING';
      await payment.save({ session });

      // 3. Write the Outbox event.
      await Outbox.create(
        [{
          eventId: uuidv4(),
          eventType: 'refund.initiated',
          aggregateId: originalTxHash,
          aggregateType: 'payment',
          payload: {
            refundId: refund._id.toString(),
            schoolId,
            originalTxHash,
            studentId,
            amount,
            reason,
            initiatedBy: principal,
          },
        }],
        { session }
      );
    });

    logger.info('Refund initiated', { schoolId, originalTxHash, studentId, refundId: refund._id, amount });
    return refund;
  } finally {
    if (session) await session.endSession();
    await lock.release(lockKey, token);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// approveRefund
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Approve a pending refund (two-person approval — #1565).
 *
 * The approver must have a different stable userId than the initiator. Both
 * initiatedBy and approvedBy are stored as { userId, displayName } objects.
 *
 * #1566: Refund save and Outbox event commit atomically.
 *
 * @param {string} refundId
 * @param {object} principal  — { userId, displayName } from buildPrincipal()
 * @returns {Promise<Refund>}
 */
async function approveRefund(refundId, principal) {
  if (!principal || !principal.userId || principal.userId === 'unknown') {
    const err = new Error('Cannot approve refund: caller identity unknown');
    err.code = 'UNKNOWN_PRINCIPAL';
    throw err;
  }

  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (refund.status !== 'approval_pending') {
    const err = new Error(`Cannot approve refund in ${refund.status} status`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  // #1565 — Compare stable userId values, not display names.
  if (refund.initiatedBy.userId === principal.userId) {
    const err = new Error('Approval must be by a different operator than the one who initiated the refund');
    err.code = 'SELF_APPROVAL_NOT_ALLOWED';
    throw err;
  }

  const previousStatus = refund.status;

  let session;
  try {
    session = await mongoose.connection.startSession();
    let updated;
    await session.withTransaction(async () => {
      refund.status = 'pending';
      refund.approvedBy = principal;
      refund.approvedAt = new Date();
      updated = await refund.save({ session });

      await Outbox.create(
        [{
          eventId: uuidv4(),
          eventType: 'refund.approved',
          aggregateId: refund.originalTxHash,
          aggregateType: 'payment',
          payload: {
            refundId: refund._id.toString(),
            schoolId: refund.schoolId,
            originalTxHash: refund.originalTxHash,
            initiatedBy: refund.initiatedBy,
            approvedBy: principal,
            amount: refund.amount,
          },
        }],
        { session }
      );
    });

    logger.info('Refund approved', {
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      refundId: refund._id,
      initiatedBy: refund.initiatedBy.userId,
      approvedBy: principal.userId,
    });

    return updated;
  } finally {
    if (session) await session.endSession();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// rejectRefund  (#1567 / #1564)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reject an approval_pending refund and restore the payment to SUCCESS.
 *
 * The rejector must be different from the initiator (same two-person rule).
 * Both the refund status change and the payment restoration commit atomically.
 *
 * @param {string} refundId
 * @param {object} principal    — { userId, displayName }
 * @param {string} rejectReason — required
 * @returns {Promise<Refund>}
 */
async function rejectRefund(refundId, principal, rejectReason) {
  if (!principal || !principal.userId || principal.userId === 'unknown') {
    const err = new Error('Cannot reject refund: caller identity unknown');
    err.code = 'UNKNOWN_PRINCIPAL';
    throw err;
  }

  if (!rejectReason || !rejectReason.trim()) {
    const err = new Error('A rejection reason is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (refund.status !== 'approval_pending') {
    const err = new Error(`Cannot reject a refund that is not in approval_pending status (current: ${refund.status})`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  // Two-person rule: initiator cannot self-reject.
  if (refund.initiatedBy.userId === principal.userId) {
    const err = new Error('Rejection must be by a different operator than the one who initiated the refund');
    err.code = 'SELF_APPROVAL_NOT_ALLOWED';
    throw err;
  }

  const lockKey = refundLockKey(refund.schoolId, refund.originalTxHash);
  const acquired = await lock.acquire(lockKey, REFUND_LOCK_TTL_MS);
  if (!acquired) {
    const err = new Error('A refund operation for this payment is already in progress');
    err.code = 'REFUND_LOCK_CONTENDED';
    throw err;
  }

  const { token } = acquired;
  let session;
  try {
    const payment = await Payment.findOne({ schoolId: refund.schoolId, txHash: refund.originalTxHash });
    if (!payment) {
      const err = new Error('Original payment not found — cannot restore status');
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    session = await mongoose.connection.startSession();
    let updated;
    await session.withTransaction(async () => {
      // 1. Mark refund as rejected.
      refund.status = 'rejected';
      refund.rejectedBy = principal;
      refund.rejectedAt = new Date();
      refund.rejectionReason = rejectReason;
      updated = await refund.save({ session });

      // 2. Restore payment to SUCCESS.
      payment.$locals.adminOverride = true;
      payment.status = 'SUCCESS';
      await payment.save({ session });

      // 3. Outbox event.
      await Outbox.create(
        [{
          eventId: uuidv4(),
          eventType: 'refund.rejected',
          aggregateId: refund.originalTxHash,
          aggregateType: 'payment',
          payload: {
            refundId: refund._id.toString(),
            schoolId: refund.schoolId,
            originalTxHash: refund.originalTxHash,
            studentId: refund.studentId,
            amount: refund.amount,
            rejectedBy: principal,
            rejectionReason: rejectReason,
          },
        }],
        { session }
      );
    });

    // Emit in-process event so SSE clients are notified.
    paymentEvents.emit('refund.status_changed', {
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      studentId: refund.studentId,
      amount: refund.amount,
      previousStatus: 'approval_pending',
      newStatus: 'rejected',
    });

    logger.info('Refund rejected', {
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      refundId: refund._id,
      rejectedBy: principal.userId,
    });

    return updated;
  } finally {
    if (session) await session.endSession();
    await lock.release(lockKey, token);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// completeRefund  (#1564)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mark a refund as confirmed given an on-chain refund transaction hash.
 *
 * This is the manual execution path (Issue #1564 short-term solution).
 * It moves the refund to 'confirmed', marks the payment as REFUNDED (or
 * PARTIALLY_REFUNDED as a derived flag — the model uses REFUNDED; a separate
 * refundedAmount virtual indicates partial vs full), and recalculates the
 * student's balance.
 *
 * All writes are atomic (#1566). The refund.status_changed event fires so
 * webhooks and SSE clients are notified (#1564).
 *
 * @param {string} refundId
 * @param {string} refundTxHash — on-chain Stellar tx hash for the refund
 * @param {object} principal    — { userId, displayName } of the operator
 * @returns {Promise<Refund>}
 */
async function completeRefund(refundId, refundTxHash, principal) {
  if (!principal || !principal.userId || principal.userId === 'unknown') {
    const err = new Error('Cannot complete refund: caller identity unknown');
    err.code = 'UNKNOWN_PRINCIPAL';
    throw err;
  }

  if (!refundTxHash || !refundTxHash.trim()) {
    const err = new Error('refundTxHash is required to complete a refund');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (refund.status !== 'pending') {
    const err = new Error(`Cannot complete refund in ${refund.status} status — must be in 'pending' status`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  const lockKey = refundLockKey(refund.schoolId, refund.originalTxHash);
  const acquired = await lock.acquire(lockKey, REFUND_LOCK_TTL_MS);
  if (!acquired) {
    const err = new Error('A refund operation for this payment is already in progress');
    err.code = 'REFUND_LOCK_CONTENDED';
    throw err;
  }

  const { token } = acquired;
  let session;
  try {
    const payment = await Payment.findOne({ schoolId: refund.schoolId, txHash: refund.originalTxHash });
    if (!payment) {
      const err = new Error('Original payment not found');
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    session = await mongoose.connection.startSession();
    let updated;
    await session.withTransaction(async () => {
      // 1. Move refund to confirmed.
      refund.status = 'confirmed';
      refund.refundTxHash = refundTxHash;
      refund.confirmedAt = new Date();
      updated = await refund.save({ session });

      // 2. Mark payment as REFUNDED.
      //    REFUND_PENDING → REFUNDED is in both transition tables; use
      //    adminOverride for safety in case the current status diverged.
      payment.$locals.adminOverride = true;
      payment.status = 'REFUNDED';
      await payment.save({ session });

      // 3. Outbox event — this is the event that paymentSavedSubscribers
      //    listens for to fire the payment.refunded webhook (#1564).
      await Outbox.create(
        [{
          eventId: uuidv4(),
          eventType: 'refund.status_changed',
          aggregateId: refund.originalTxHash,
          aggregateType: 'payment',
          payload: {
            refundId: refund._id.toString(),
            schoolId: refund.schoolId,
            originalTxHash: refund.originalTxHash,
            studentId: refund.studentId,
            amount: refund.amount,
            previousStatus: 'pending',
            newStatus: 'confirmed',
            refundTxHash,
            completedBy: principal,
          },
        }],
        { session }
      );
    });

    // Emit in-process event AFTER the transaction commits so subscribers always
    // see a consistent DB state (#1564).
    paymentEvents.emit('refund.status_changed', {
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      studentId: refund.studentId,
      amount: refund.amount,
      previousStatus: 'pending',
      newStatus: 'confirmed',
      refundTxHash,
    });

    // #1567 — Recalculate student balance after refund is confirmed.
    // A refunded fee payment reduces the student's totalPaid; a refunded
    // overpayment excess should not reduce feePaid.
    try {
      const { updateStudentBalance } = require('../utils/studentBalanceUpdater');
      await updateStudentBalance(refund.schoolId, refund.studentId, {});
    } catch (balanceErr) {
      // Non-fatal: log but don't fail the refund completion.
      logger.error('Failed to update student balance after refund completion', {
        schoolId: refund.schoolId,
        studentId: refund.studentId,
        refundId: refund._id,
        error: balanceErr.message,
      });
    }

    logger.info('Refund completed', {
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      refundId: refund._id,
      refundTxHash,
      amount: refund.amount,
    });

    return updated;
  } finally {
    if (session) await session.endSession();
    await lock.release(lockKey, token);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// updateRefundStatus  (#1564 / #1566)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generic status transition for the refund state machine.
 * Used internally and by the automated worker path (longer-term #1564).
 *
 * #1566: save() and Outbox.create() are wrapped in a MongoDB transaction.
 * #1564: emits refund.status_changed in-process after the transaction commits.
 */
async function updateRefundStatus(refundId, newStatus, txHash = null, failureReason = null) {
  // ── 1. Validate newStatus before touching the DB ───────────────────────────
  if (!VALID_REFUND_STATUSES.includes(newStatus)) {
    const err = new Error(
      `Invalid refund status "${newStatus}". Must be one of: ${VALID_REFUND_STATUSES.join(', ')}`
    );
    err.code = 'INVALID_STATUS';
    throw err;
  }

  // ── 2. Load the refund to read its schoolId / originalTxHash for the lock ──
  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // ── 3. Acquire the per-payment distributed lock ────────────────────────────
  const lockKey = refundLockKey(refund.schoolId, refund.originalTxHash);
  const acquired = await lock.acquire(lockKey, REFUND_LOCK_TTL_MS);
  if (!acquired) {
    const err = new Error('A refund operation for this payment is already in progress. Please try again shortly.');
    err.code = 'REFUND_LOCK_CONTENDED';
    throw err;
  }

  const { token } = acquired;
  let session;
  try {
    // ── 4. Re-fetch inside the lock for the authoritative current status ───
    const lockedRefund = await Refund.findById(refundId);
    if (!lockedRefund) {
      const err = new Error('Refund not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const previousStatus = lockedRefund.status;

    // ── 5. Enforce the legal-transition table ────────────────────────────────
    const allowedTransitions = REFUND_STATUS_TRANSITIONS[previousStatus];
    if (!allowedTransitions.includes(newStatus)) {
      const err = new Error(
        `Cannot transition refund from "${previousStatus}" to "${newStatus}". ` +
        (allowedTransitions.length
          ? `Allowed transitions: ${allowedTransitions.join(', ')}.`
          : `"${previousStatus}" is a terminal state.`)
      );
      err.code = 'INVALID_STATUS_TRANSITION';
      err.currentStatus = previousStatus;
      err.requestedStatus = newStatus;
      throw err;
    }

    lockedRefund.status = newStatus;

    if (newStatus === 'confirmed' && txHash) {
      lockedRefund.refundTxHash = txHash;
      lockedRefund.confirmedAt = new Date();
    } else if (newStatus === 'failed' && failureReason) {
      lockedRefund.failureReason = failureReason;
      lockedRefund.failedAt = new Date();
    }

    // ── 6. Atomic save + outbox event ─────────────────────────────────────────
    session = await mongoose.connection.startSession();
    let updated;
    await session.withTransaction(async () => {
      updated = await lockedRefund.save({ session });

      await Outbox.create(
        [{
          eventId: uuidv4(),
          eventType: 'refund.status_changed',
          aggregateId: lockedRefund.originalTxHash,
          aggregateType: 'payment',
          payload: {
            refundId: lockedRefund._id.toString(),
            schoolId: lockedRefund.schoolId,
            originalTxHash: lockedRefund.originalTxHash,
            previousStatus,
            newStatus,
            refundTxHash: lockedRefund.refundTxHash,
            failureReason,
          },
        }],
        { session }
      );
    });

    // #1564 — Emit in-process event after the transaction commits.
    paymentEvents.emit('refund.status_changed', {
      schoolId: lockedRefund.schoolId,
      originalTxHash: lockedRefund.originalTxHash,
      studentId: lockedRefund.studentId,
      amount: lockedRefund.amount,
      previousStatus,
      newStatus,
      refundTxHash: lockedRefund.refundTxHash,
    });

    logger.info('Refund status updated', {
      schoolId: lockedRefund.schoolId,
      originalTxHash: lockedRefund.originalTxHash,
      refundId: lockedRefund._id,
      previousStatus,
      newStatus,
    });

    return updated;
  } finally {
    if (session) await session.endSession();
    await lock.release(lockKey, token);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Read helpers
// ──────────────────────────────────────────────────────────────────────────────

async function getRefundsByPayment(schoolId, originalTxHash) {
  return Refund.find({ schoolId, originalTxHash }).sort({ createdAt: -1 }).lean();
}

async function getRefundsBySchool(schoolId, status = null) {
  const query = { schoolId };
  if (status) query.status = status;
  return Refund.find(query).sort({ createdAt: -1 }).lean();
}

module.exports = {
  initiateRefund,
  approveRefund,
  rejectRefund,
  completeRefund,
  updateRefundStatus,
  getRefundsByPayment,
  getRefundsBySchool,
  refundLockKey,
  buildPrincipal,
  ACTIVE_REFUND_STATUSES,
  VALID_REFUND_STATUSES,
  REFUND_STATUS_TRANSITIONS,
};
