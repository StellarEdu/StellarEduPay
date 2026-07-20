'use strict';

/**
 * paymentSavedSubscribers.js
 *
 * Registers all downstream handlers for the 'payment.saved' event.
 * Call registerPaymentSavedSubscribers() once during app startup.
 *
 * Subscribers (each runs independently; one failing does not block others):
 *   1. Webhook  — fires payment.confirmed to the school's registered webhook URL.
 *   2. Receipt  — creates an idempotent receipt document in MongoDB.
 *   3. Reminder — clears reminder tracking fields when the fee is fully paid.
 */

const paymentEvents = require('../events/paymentEvents');
const { createReceipt } = require('./receiptService');
const { incrementPaymentMetrics } = require('./metricsRollupService');
const School = require('../models/schoolModel');
const Student = require('../models/studentModel');
const logger = require('../utils/logger').child('PaymentSavedSubscribers');

// ── Webhook subscriber ────────────────────────────────────────────────────────

async function onPaymentSavedWebhook(payment) {
  try {
    const school = await School.findOne({ schoolId: payment.schoolId }).lean();
    const allowedFields = school?.webhookPayloadConfig?.allowedFields || null;
    const { buildWebhookPayload } = require('../utils/buildWebhookPayload');
    const { fireWebhookToEndpoints } = require('./webhookService');

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

    // #865: fire to all active WebhookEndpoint subscriptions
    const results = await fireWebhookToEndpoints(payment.schoolId, 'payment.confirmed', rawPayload, allowedFields);

    // Fallback: legacy single-URL on the School document (backward compat)
    if (results.length === 0) {
      const webhookUrl = (school && school.webhookUrl) || process.env.PAYMENT_WEBHOOK_URL;
      if (!webhookUrl) return;
      const secret = school ? school.webhookSecret : null;
      const filteredPayload = buildWebhookPayload(rawPayload, allowedFields);
      const { notifyPaymentConfirmed } = require('./webhookService');
      await notifyPaymentConfirmed(webhookUrl, { ...payment, ...filteredPayload }, null, secret);
    }
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
    if (refundEvent.newStatus === 'confirmed') {
      const school = await School.findOne({ schoolId: refundEvent.schoolId }).lean();
      const allowedFields = school?.webhookPayloadConfig?.allowedFields || null;
      const { buildWebhookPayload } = require('../utils/buildWebhookPayload');
      const { fireWebhookToEndpoints } = require('./webhookService');

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

      const results = await fireWebhookToEndpoints(refundEvent.schoolId, 'payment.refunded', rawPayload, allowedFields);

      // Fallback to legacy single-URL
      if (results.length === 0) {
        const webhookUrl = (school && school.webhookUrl) || process.env.PAYMENT_WEBHOOK_URL;
        if (!webhookUrl) return;
        const secret = school ? school.webhookSecret : null;
        const filteredPayload = buildWebhookPayload(rawPayload, allowedFields);
        const { notifyPaymentRefunded } = require('./webhookService');
        await notifyPaymentRefunded(webhookUrl, { ...refundEvent, ...filteredPayload }, null, secret);
      }
    }
  } catch (err) {
    logger.error('Refund webhook subscriber failed', {
      originalTxHash: refundEvent.originalTxHash,
      error: err.message,
    });
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerPaymentSavedSubscribers() {
  paymentEvents.on('payment.saved', onPaymentSavedWebhook);
  paymentEvents.on('payment.saved', onPaymentSavedReceipt);
  paymentEvents.on('payment.saved', onPaymentSavedCancelReminder);
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
  onRefundStatusChanged,
};
