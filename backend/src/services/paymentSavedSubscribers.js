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
const { notifyPaymentConfirmed } = require('./webhookService');
const { createReceipt } = require('./receiptService');
const { incrementPaymentMetrics } = require('./metricsRollupService');
const School = require('../models/schoolModel');
const Student = require('../models/studentModel');
const logger = require('../utils/logger').child('PaymentSavedSubscribers');

// ── Webhook subscriber ────────────────────────────────────────────────────────

async function onPaymentSavedWebhook(payment) {
  try {
    const school = await School.findOne({ schoolId: payment.schoolId }).lean();
    const webhookUrl = (school && school.webhookUrl) || process.env.PAYMENT_WEBHOOK_URL;
    if (!webhookUrl) return;
    const secret = school ? school.webhookSecret : null;
    await notifyPaymentConfirmed(webhookUrl, payment, null, secret);
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
      const webhookUrl = (school && school.webhookUrl) || process.env.PAYMENT_WEBHOOK_URL;
      if (!webhookUrl) return;

      const secret = school ? school.webhookSecret : null;
      const { notifyPaymentRefunded } = require('./webhookService');
      await notifyPaymentRefunded(webhookUrl, refundEvent, null, secret);
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
