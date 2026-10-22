'use strict';

/**
 * paymentSavedSubscribers.js
 *
 * Registers all downstream handlers for the 'payment.saved' event.
 * Call registerPaymentSavedSubscribers() once during app startup.
 *
 * Subscribers (each runs independently; one failing does not block others):
 *   1. Webhook  — fires payment.confirmed to the school's webhook endpoints.
 *   2. Receipt  — creates an idempotent receipt document in MongoDB.
 *   3. Reminder — clears reminder tracking fields when the fee is fully paid.
 */

const paymentEvents = require('../events/paymentEvents');
const { createReceipt } = require('./receiptService');
const { incrementPaymentMetrics } = require('./metricsRollupService');
const { invalidateReportCache } = require('./reportCacheInvalidator');
const School = require('../models/schoolModel');
const Student = require('../models/studentModel');
const logger = require('../utils/logger').child('PaymentSavedSubscribers');

// ── Webhook subscriber ────────────────────────────────────────────────────────

async function onPaymentSavedWebhook(payment) {
  try {
    const { dispatchToSchool } = require('./webhookService');

    const rawPayload = {
      transactionHash: payment.transactionHash || payment.txHash,
      txHash: payment.txHash || payment.transactionHash,
      correlationId: payment.correlationId,
      studentId: payment.studentId,
      amount: payment.amount,
      assetCode: payment.assetCode || 'XLM',
      asset: payment.assetCode || 'XLM',
      finalFee: payment.finalFee,
      feeValidationStatus: payment.feeValidationStatus,
      confirmedAt: payment.confirmedAt,
      referenceCode: payment.referenceCode,
      schoolId: payment.schoolId,
      senderAddress: payment.senderAddress,
      status: payment.status,
      ts: new Date().toISOString(),
    };

    // #865 / #1640: fire to all active WebhookEndpoint subscriptions — the
    // only outbound webhook path.
    await dispatchToSchool(payment.schoolId, 'payment.confirmed', rawPayload);
  } catch (err) {
    logger.error('Webhook subscriber failed', { txHash: payment.txHash, correlationId: payment.correlationId, error: err.message });
  }
}

// ── Receipt subscriber ────────────────────────────────────────────────────────

async function onPaymentSavedReceipt(payment) {
  try {
    await createReceipt(payment);
  } catch (err) {
    logger.error('Receipt subscriber failed', { txHash: payment.txHash, correlationId: payment.correlationId, error: err.message });
    try {
      require('../metrics').receiptGenerationFailuresTotal.inc({ source: 'payment_saved_subscriber' });
    } catch (_) {
      // metrics module unavailable — logging above is still the primary signal
    }
  }
}

// ── Reminder-cancellation subscriber ─────────────────────────────────────────

async function onPaymentSavedCancelReminder(payment) {
  try {
    // Only clear reminders when the student's fee is now fully paid.
    const student = await Student.findOne({
      schoolId: payment.schoolId,
      studentId: payment.studentId,
    }).lean();

    if (student && student.feePaid) {
      await Student.updateOne(
        { schoolId: payment.schoolId, studentId: payment.studentId },
        { $set: { reminderCount: 0, lastReminderSentAt: null } }
      );
    }
  } catch (err) {
    logger.error('Reminder-cancellation subscriber failed', {
      txHash: payment.txHash,
      correlationId: payment.correlationId,
      error: err.message,
    });
  }
}

// ── Refund handler ────────────────────────────────────────────────────────────

async function onRefundStatusChanged(refundEvent) {
  try {
    // Fire webhooks on significant terminal state transitions.
    if (refundEvent.newStatus === 'confirmed' || refundEvent.newStatus === 'rejected') {
      const { dispatchToSchool } = require('./webhookService');

      const eventType = refundEvent.newStatus === 'confirmed' ? 'payment.refunded' : 'payment.refund_rejected';

      const rawPayload = {
        originalTxHash: refundEvent.originalTxHash,
        refundTxHash: refundEvent.refundTxHash || null,
        studentId: refundEvent.studentId,
        amount: refundEvent.amount,
        reason: refundEvent.reason,
        status: refundEvent.newStatus,
        refundedAt: new Date().toISOString(),
        ts: new Date().toISOString(),
      };

      await dispatchToSchool(refundEvent.schoolId, eventType, rawPayload);
    }
  } catch (err) {
    logger.error('Refund webhook subscriber failed', {
      originalTxHash: refundEvent.originalTxHash,
      newStatus: refundEvent.newStatus,
      error: err.message,
    });
  }
}

// ── Processing duration subscriber ─────────────────────────────────────────

async function onPaymentSavedRecordDuration(payment) {
  try {
    // Record payment processing duration (from detectedAt to confirmedAt)
    if (payment.detectedAt && payment.confirmedAt) {
      const durationSeconds = (new Date(payment.confirmedAt) - new Date(payment.detectedAt)) / 1000;
      const metricsModule = require('../metrics');
      if (metricsModule?.paymentProcessingDurationSeconds) {
        metricsModule.paymentProcessingDurationSeconds.observe(durationSeconds);
      }
    }
  } catch (err) {
    logger.error('Payment duration recording failed', { txHash: payment.txHash, error: err.message });
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerPaymentSavedSubscribers() {
  paymentEvents.on('payment.saved', onPaymentSavedWebhook);
  paymentEvents.on('payment.saved', onPaymentSavedReceipt);
  paymentEvents.on('payment.saved', onPaymentSavedCancelReminder);
  paymentEvents.on('payment.saved', onPaymentSavedRecordDuration);
  // #1747 — invalidate school-scoped report cache entries on each new payment
  paymentEvents.on('payment.saved', (payment) => { invalidateReportCache(payment); });
  // #881 — increment pre-aggregated rollups on every confirmed payment
  paymentEvents.on('payment.saved', async (payment) => {
    try { await incrementPaymentMetrics(payment); }
    catch (err) { logger.error('Metrics rollup subscriber failed', { txHash: payment.txHash, error: err.message }); }
  });
  paymentEvents.on('refund.status_changed', onRefundStatusChanged);
}

module.exports = {
  registerPaymentSavedSubscribers,
  // Exported for testing
  onPaymentSavedWebhook,
  onPaymentSavedReceipt,
  onPaymentSavedCancelReminder,
  onPaymentSavedRecordDuration,
  onRefundStatusChanged,
  invalidateReportCache,
};
