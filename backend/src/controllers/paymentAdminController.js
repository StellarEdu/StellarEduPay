'use strict';

/**
 * paymentAdminController — admin-only payment operations, all school-scoped.
 */

const Payment = require('../models/paymentModel');
const Receipt = require('../models/receiptModel');
const Refund = require('../models/refundModel');
const ReconciliationReport = require('../models/reconciliationReportModel');
const { createReceipt, verifyReceiptSignature } = require('../services/receiptService');
const { finalizeConfirmedPayments } = require('../services/stellarService');
const { logAudit } = require('../services/auditService');
const { syncDurationSeconds } = require('../metrics');
const { syncPaymentsForSchool } = require('../services/stellarService');
const { initiateRefund, getRefundsByPayment, getRefundsBySchool } = require('../services/refundService');
const { generateReconciliationReport } = require('../services/reconciliationService');
const lock = require('../services/distributedLock');
const { ADMIN_PAYMENT_STATUS_TRANSITIONS } = require('../constants/paymentStatus');

// TTL for the per-school distributed sync lock (60 s — long enough to complete
// a full blockchain sync while short enough to auto-expire after a crash).
const SYNC_LOCK_TTL_MS = parseInt(process.env.SYNC_LOCK_TTL_MS || '60000', 10);

function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

async function syncAllPayments(req, res, next) {
  const { schoolId } = req;

  // Issue #69 — replace the in-process _syncLocks Set with a cross-replica
  // distributed lock (Redis SET NX PX, in-process Map fallback when no Redis).
  // Any replica that cannot acquire the lock immediately returns 409 so the
  // caller knows a sync is already in flight somewhere in the cluster.
  const lockKey = `sync:lock:${schoolId}`;
  // acquire() returns { token, fencingToken } (or null). release() expects the
  // raw token string, so destructure — passing the whole object never matches
  // and the lock would never be released.
  const acquired = await lock.acquire(lockKey, SYNC_LOCK_TTL_MS);
  if (!acquired) {
    return res.status(409).json({ error: 'Sync already in progress', code: 'SYNC_IN_PROGRESS' });
  }
  const { token } = acquired;

  const stopSyncTimer = syncDurationSeconds.startTimer();
  try {
    const summary = await syncPaymentsForSchool(req.school);

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_manual_sync',
        performedBy: req.auditContext.performedBy,
        targetId: schoolId,
        targetType: 'payment',
        details: { syncResult: summary },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({
      message: 'Sync complete',
      summary: {
        found: summary.found,
        new: summary.new,
        matched: summary.matched,
        unmatched: summary.unmatched,
        failed: summary.failed,
        alreadyProcessed: summary.alreadyProcessed,
        failedDetails: summary.failedDetails,
      },
    });
  } catch (err) {
    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_manual_sync',
        performedBy: req.auditContext.performedBy,
        targetId: schoolId,
        targetType: 'payment',
        details: {},
        result: 'failure',
        errorMessage: err.message,
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }
    next(wrapStellarError(err));
  } finally {
    stopSyncTimer();
    await lock.release(lockKey, token);
  }
}

async function getSyncStatus(req, res, next) {
  try {
    const SystemConfig = require('../models/systemConfigModel');
    const lastSyncAt = await SystemConfig.get(`lastSyncAt:${req.schoolId}`);
    res.json({ lastSyncAt: lastSyncAt || null, status: lastSyncAt ? 'synced' : 'never_synced' });
  } catch (err) {
    next(err);
  }
}

async function finalizePayments(req, res, next) {
  try {
    const result = await finalizeConfirmedPayments(req.schoolId);

    if (req.auditContext) {
      await logAudit({
        schoolId: req.schoolId,
        action: 'payment_finalize',
        performedBy: req.auditContext.performedBy,
        targetId: req.schoolId,
        targetType: 'payment',
        details: { finalizeResult: result },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ message: 'Finalization complete' });
  } catch (err) {
    next(err);
  }
}

async function generateReceipt(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash } = req.params;

    const existing = await Receipt.findOne({ txHash, schoolId });
    if (existing) return res.json(existing);

    const payment = await Payment.findOne({ txHash, schoolId, status: 'SUCCESS' });
    if (!payment) {
      return res.status(404).json({ error: 'Confirmed payment not found for this transaction hash', code: 'NOT_FOUND' });
    }

    const receipt = await Receipt.create({
      txHash: payment.txHash,
      studentId: payment.studentId,
      schoolId: payment.schoolId,
      amount: payment.amount,
      assetCode: payment.assetCode || 'XLM',
      feeAmount: payment.feeAmount,
      feeValidationStatus: payment.feeValidationStatus,
      memo: payment.memo,
      confirmedAt: payment.confirmedAt,
    });

    res.status(201).json(receipt);
  } catch (err) {
    next(err);
  }
}

async function lockPaymentForUpdate(req, res, next) {
  try {
    const { schoolId } = req;
    const { paymentId } = req.params;
    const lockDurationMs = req.body.lockDurationMs || 30000;
    const lockId = `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const lockDeadline = new Date(Date.now() + lockDurationMs);

    const payment = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        schoolId,
        $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: new Date() } }],
      },
      { $set: { lockedUntil: lockDeadline, lockHolder: lockId } },
      { new: true },
    );

    if (!payment) {
      const exists = await Payment.findOne({ _id: paymentId, schoolId });
      if (!exists) return res.status(404).json({ error: 'Payment not found', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Payment is currently locked by another process', code: 'PAYMENT_LOCKED', lockedUntil: exists.lockedUntil });
    }

    res.json({ locked: true, lockId, lockedUntil: lockDeadline, paymentId: payment._id });
  } catch (err) {
    next(err);
  }
}

async function unlockPayment(req, res, next) {
  try {
    const { schoolId } = req;
    const { paymentId } = req.params;
    const { lockId } = req.body;

    if (!lockId) return res.status(400).json({ error: 'lockId is required', code: 'VALIDATION_ERROR' });

    const payment = await Payment.findOneAndUpdate(
      { _id: paymentId, schoolId, lockHolder: lockId },
      { $set: { lockedUntil: null, lockHolder: null } },
      { new: true },
    );

    if (!payment) return res.status(404).json({ error: 'Payment not found or lockId does not match', code: 'NOT_FOUND' });

    res.json({ unlocked: true, paymentId: payment._id });
  } catch (err) {
    next(err);
  }
}

async function getDeadLetterJobs(req, res, next) {
  try {
    const { getDeadLetterQueue } = require('../config/retryQueueSetup');
    const queue = getDeadLetterQueue();
    const jobs = queue ? await queue.getFailed(0, 99) : [];
    res.json({ jobs: jobs.map((j) => ({ id: j.id, name: j.name, data: j.data, failedReason: j.failedReason })) });
  } catch (err) {
    next(err);
  }
}

async function retryDeadLetterJob(req, res, next) {
  try {
    const { getDeadLetterQueue } = require('../config/retryQueueSetup');
    const { jobId } = req.params;
    const queue = getDeadLetterQueue();
    if (!queue) return res.status(503).json({ error: 'Retry queue unavailable', code: 'SERVICE_UNAVAILABLE' });
    const job = await queue.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' });
    await job.retry();
    res.json({ message: 'Job queued for retry', jobId });
  } catch (err) {
    next(err);
  }
}

async function getQueueJobStatus(req, res, next) {
  try {
    const { getRetryQueueStatus } = require('../config/retryQueueSetup');
    const status = await getRetryQueueStatus();
    res.json(status || { available: false });
  } catch (err) {
    next(err);
  }
}

async function getStuckPayments(req, res, next) {
  try {
    const { findStuckPayments, STUCK_PAYMENT_THRESHOLD_MS } = require('../services/stuckPaymentReconciliation');
    const stuckPayments = await findStuckPayments();
    res.json({
      count: stuckPayments.length,
      thresholdMs: STUCK_PAYMENT_THRESHOLD_MS,
      thresholdMinutes: Math.round(STUCK_PAYMENT_THRESHOLD_MS / 60000),
      payments: stuckPayments.map((p) => ({
        txHash: p.txHash,
        studentId: p.studentId,
        amount: p.amount,
        status: p.status,
        submittedAt: p.submittedAt,
        confirmedAt: p.confirmedAt,
        schoolId: p.schoolId,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// Admin-allowed manual status transitions: from → [to, ...]
// Use the canonical transition table from constants/paymentStatus.js (Issue #72).
// ADMIN_PAYMENT_STATUS_TRANSITIONS is the wider admin-path table that allows
// transitions like DISPUTED → REFUNDED in addition to the normal set.
const ALLOWED_TRANSITIONS = ADMIN_PAYMENT_STATUS_TRANSITIONS;

async function updatePaymentStatus(req, res, next) {
  try {
    const { txHash } = req.params;
    const { status: newStatus, reason } = req.body;

    if (!newStatus || !reason) return res.status(400).json({ error: 'status and reason are required', code: 'VALIDATION_ERROR' });
    if (newStatus === 'PENDING') return res.status(400).json({ error: 'Cannot transition to PENDING', code: 'INVALID_TRANSITION' });

    const payment = await Payment.findOne({ schoolId: req.schoolId, txHash });
    if (!payment) {
      const err = new Error('Payment not found');
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const previousStatus = payment.status;
    const allowed = ALLOWED_TRANSITIONS[previousStatus] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({ error: `Cannot transition from ${previousStatus} to ${newStatus}`, code: 'INVALID_TRANSITION' });
    }

    // Set $locals.adminOverride so the pre-save hook uses ADMIN_PAYMENT_STATUS_TRANSITIONS
    // instead of the narrower PAYMENT_STATUS_TRANSITIONS.  $locals is Mongoose's
    // per-document transient store — it is never persisted and survives through save().
    payment.$locals.adminOverride = true;
    payment.status = newStatus;
    const updated = await payment.save();

    await logAudit({
      schoolId: req.schoolId,
      action: 'payment_status_update',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: txHash,
      targetType: 'payment',
      details: { from: previousStatus, to: newStatus, reason, adminOverride: true },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/payments/:txHash/suspicion-review
 *
 * Review a flagged (suspicious) payment. Resolves the false-positive / fraud
 * ambiguity an admin would otherwise have no way to act on:
 *
 *   action: 'clear'         — false positive. Removes the suspicious flag so the
 *                             payment leaves the suspicious queue.
 *   action: 'confirm_fraud' — confirmed fraudulent. Keeps it flagged/excluded
 *                             and records the determination.
 *
 * The balance-affecting status (SUCCESS/FAILED/etc.) is intentionally left to
 * the existing updatePaymentStatus flow so this endpoint never silently mutates
 * student balances. Every review is written to the audit log.
 */
async function reviewSuspiciousPayment(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash } = req.params;
    const { action, note } = req.body;

    if (!['clear', 'confirm_fraud'].includes(action)) {
      return res.status(400).json({
        error: "action must be 'clear' or 'confirm_fraud'",
        code: 'VALIDATION_ERROR',
      });
    }

    const payment = await Payment.findOne({ schoolId, txHash });
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', code: 'NOT_FOUND' });
    }
    if (!payment.isSuspicious && payment.suspicionReviewStatus === 'flagged') {
      return res.status(400).json({ error: 'Payment is not flagged as suspicious', code: 'NOT_FLAGGED' });
    }

    const previousStatus = payment.suspicionReviewStatus;
    const reviewer = req.auditContext?.performedBy || 'unknown';

    payment.suspicionReviewStatus = action === 'clear' ? 'cleared' : 'confirmed_fraud';
    payment.suspicionReviewedBy = reviewer;
    payment.suspicionReviewedAt = new Date();
    payment.suspicionReviewNote = note || null;
    // Clearing a false positive removes it from the suspicious queue; confirming
    // fraud keeps the flag.
    if (action === 'clear') payment.isSuspicious = false;

    const updated = await payment.save();

    await logAudit({
      schoolId,
      action: 'payment_suspicion_review',
      performedBy: reviewer,
      targetId: txHash,
      targetType: 'payment',
      details: {
        from: previousStatus,
        to: payment.suspicionReviewStatus,
        suspicionReason: payment.suspicionReason,
        note: note || null,
      },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

function streamPaymentEvents(req, res) {
  const { addClient, removeClient } = require('../services/sseService');
  const { schoolId } = req;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // addClient owns the per-connection heartbeat and enforces the per-school
  // connection cap. A false return means the cap is reached — reject cleanly.
  if (!addClient(schoolId, res)) {
    res.write('event: error\ndata: {"error":"too_many_connections"}\n\n');
    res.end();
    return;
  }

  req.on('close', () => {
    removeClient(schoolId, res);
  });
}

async function initiatePaymentRefund(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash } = req.params;
    const { reason } = req.body;

    if (!reason) return res.status(400).json({ error: 'reason is required', code: 'VALIDATION_ERROR' });

    const payment = await Payment.findOne({ schoolId, txHash, status: 'SUCCESS' });
    if (!payment) {
      return res.status(404).json({ error: 'Confirmed payment not found', code: 'NOT_FOUND' });
    }

    const refund = await initiateRefund(
      schoolId,
      txHash,
      payment.studentId,
      payment.amount,
      reason,
      req.auditContext?.performedBy || 'unknown'
    );

    await logAudit({
      schoolId,
      action: 'refund_initiated',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: txHash,
      targetType: 'refund',
      details: { refundId: refund._id.toString(), amount: payment.amount },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.status(201).json(refund);
  } catch (err) {
    next(err);
  }
}

async function getPaymentRefunds(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash } = req.params;

    const refunds = await getRefundsByPayment(schoolId, txHash);
    res.json({ refunds });
  } catch (err) {
    next(err);
  }
}

async function getSchoolRefunds(req, res, next) {
  try {
    const { schoolId } = req;
    const { status } = req.query;

    const refunds = await getRefundsBySchool(schoolId, status);
    res.json({ refunds, count: refunds.length });
  } catch (err) {
    next(err);
  }
}

async function verifyReceipt(req, res, next) {
  try {
    const { receiptId } = req.params;

    const receipt = await Receipt.findById(receiptId).lean();
    if (!receipt) return res.status(404).json({ error: 'Receipt not found', code: 'NOT_FOUND' });

    try {
      const isValid = verifyReceiptSignature(receipt);
      res.json({
        receiptId,
        valid: isValid,
        txHash: receipt.txHash,
        amount: receipt.amount,
        confirmedAt: receipt.confirmedAt,
      });
    } catch (err) {
      res.json({ receiptId, valid: false, error: 'Signature verification failed' });
    }
  } catch (err) {
    next(err);
  }
}

async function getReconciliationReports(req, res, next) {
  try {
    const { schoolId } = req;
    const { limit = 30 } = req.query;

    const reports = await ReconciliationReport.find({ schoolId })
      .sort({ reportedAt: -1 })
      .limit(Math.min(parseInt(limit), 100))
      .lean();

    res.json({ reports, count: reports.length });
  } catch (err) {
    next(err);
  }
}

async function generateSchoolReconciliationReport(req, res, next) {
  try {
    const { schoolId } = req;

    const report = await generateReconciliationReport(schoolId);

    await logAudit({
      schoolId,
      action: 'reconciliation_report_generated',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: schoolId,
      targetType: 'reconciliation',
      details: { reportId: report._id.toString(), drift: report.drift },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.status(201).json(report);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  syncAllPayments,
  getSyncStatus,
  finalizePayments,
  generateReceipt,
  lockPaymentForUpdate,
  unlockPayment,
  getDeadLetterJobs,
  retryDeadLetterJob,
  getQueueJobStatus,
  getStuckPayments,
  updatePaymentStatus,
  reviewSuspiciousPayment,
  streamPaymentEvents,
  initiatePaymentRefund,
  getPaymentRefunds,
  getSchoolRefunds,
  verifyReceipt,
  getReconciliationReports,
  generateSchoolReconciliationReport,
  // Exposed for testing — callers can introspect the lock state
  _lock: lock,
};
