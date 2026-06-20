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
    logger.error('Webhook subscriber failed', { txHash: payment.txHash, error: err.message });
  }
}

// ── Receipt subscriber ────────────────────────────────────────────────────────

async function onPaymentSavedReceipt(payment) {
  try {
    await createReceipt(payment);
  } catch (err) {
    logger.error('Receipt subscriber failed', { txHash: payment.txHash, error: err.message });
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
      error: err.message,
    });
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerPaymentSavedSubscribers() {
  paymentEvents.on('payment.saved', onPaymentSavedWebhook);
  paymentEvents.on('payment.saved', onPaymentSavedReceipt);
  paymentEvents.on('payment.saved', onPaymentSavedCancelReminder);
}

module.exports = {
  registerPaymentSavedSubscribers,
  // Exported for testing
  onPaymentSavedWebhook,
  onPaymentSavedReceipt,
  onPaymentSavedCancelReminder,
};
