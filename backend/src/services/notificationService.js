'use strict';

/**
 * Notification Service — fee reminder emails.
 *
 * Issue #80: sending is now delegated to the unified email module
 * (services/email), giving reminders a pluggable provider (SMTP/SES/SendGrid),
 * automatic retry, and suppression-list handling. This service is responsible
 * only for building the reminder content from external templates and the signed
 * unsubscribe link.
 *
 * Templates:
 *   backend/src/templates/reminderEmail.txt  (plain-text)
 *   backend/src/templates/reminderEmail.html (HTML)
 *
 * Supported placeholders: {{studentName}}, {{studentId}}, {{className}},
 * {{schoolName}}, {{feeAmount}}, {{outstanding}}, {{reminderNote}},
 * {{urgency}}, {{deadline}}, {{unsubscribeUrl}}
 * The {{#if reminderNote}}…{{/if}} block is stripped when reminderNote is empty.
 */

const config = require('../config');
const logger = require('../utils/logger').child('NotificationService');
const { generateUnsubscribeToken } = require('../utils/unsubscribeToken');
const { renderEmailTemplate } = require('../utils/templateRenderer');
const email = require('./email');
const { sendSms, sendWhatsApp, isTwilioConfigured } = require('./smsService');

/**
 * Verify the active email provider is reachable/configured.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
async function verifySmtp() {
  return email.verify();
}

/**
 * Build the reminder email body from external template files.
 */
function buildReminderEmail({ studentName, studentId, className, feeAmount, remainingBalance, schoolName, reminderCount, unsubscribeUrl, escalationLevel, paymentDeadline }) {
  const outstanding = remainingBalance != null ? remainingBalance : feeAmount;

  // Determine escalation prefix and urgency message
  const ESCALATION_LABELS = {
    1: { prefix: '', urgency: 'This is a friendly reminder that school fees are due.' },
    2: { prefix: 'URGENT: ', urgency: 'This is an urgent reminder — fees are due very soon.' },
    3: { prefix: 'OVERDUE: ', urgency: 'Fees are now overdue. Please arrange payment immediately to avoid any disruption.' },
  };
  const esc = ESCALATION_LABELS[escalationLevel] || ESCALATION_LABELS[1];
  const subject = `${esc.prefix}[${schoolName}] Fee Payment Reminder — ${studentName}`;
  const reminderNote = reminderCount > 1
    ? `Note: This is reminder #${reminderCount}. If you have already paid, please disregard this message.`
    : '';

  const deadlineStr = paymentDeadline
    ? new Date(paymentDeadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const vars = { studentName, studentId, className, feeAmount, outstanding, schoolName, reminderNote, urgency: esc.urgency, deadline: deadlineStr || '', unsubscribeUrl: unsubscribeUrl || '' };
  const { text, html } = renderEmailTemplate('reminderEmail', vars);

  return { subject, text, html };
}

/**
 * Send a fee reminder to a parent.
 *
 * @param {object} opts
 * @param {string} opts.to            - Parent email address
 * @param {string} opts.studentName
 * @param {string} opts.studentId
 * @param {string} opts.schoolId      - Required for generating the unsubscribe token
 * @param {string} opts.className
 * @param {number} opts.feeAmount
 * @param {number|null} opts.remainingBalance
 * @param {string} opts.schoolName
 * @param {number} opts.reminderCount
 * @param {number} [opts.escalationLevel=1] - 1=early, 2=approaching, 3=overdue
 * @param {Date|null} [opts.paymentDeadline] - Payment deadline date
 * @returns {Promise<{sent: boolean, messageId?: string, preview?: string, suppressed?: boolean}>}
 */
async function sendFeeReminder(opts) {
  const token = generateUnsubscribeToken(opts.studentId, opts.schoolId || 'unknown', config.JWT_SECRET);
  const baseUrl = config.APP_URL || process.env.APP_URL || 'http://localhost:5000';
  const unsubscribeUrl = `${baseUrl}/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;

  const { subject, text, html } = buildReminderEmail({ ...opts, unsubscribeUrl });

  const result = await email.sendEmail({
    to: opts.to,
    subject,
    text,
    html,
    category: 'reminder',
  });

  // The console (dev/no-provider) backend logs instead of delivering — preserve
  // the original "not sent" semantics so reminder tracking isn't advanced in dev.
  if (result.provider === 'console') {
    logger.info('REMINDER (console provider)', {
      to: opts.to,
      subject,
      studentId: opts.studentId,
      reminderCount: opts.reminderCount,
    });
    return { sent: false, preview: text };
  }

  if (result.sent) {
    logger.info('Reminder email sent', {
      messageId: result.messageId,
      to: opts.to,
      studentId: opts.studentId,
      reminderCount: opts.reminderCount,
    });
    return { sent: true, messageId: result.messageId };
  }

  // Suppressed recipient — a deliberate skip, not a provider failure.
  if (result.suppressed) {
    logger.info('Reminder skipped — recipient suppressed', { to: opts.to, studentId: opts.studentId });
    return { sent: false, suppressed: true };
  }

  // Genuine delivery failure after retries — throw so the caller's circuit
  // breaker counts it (preserves the original sendMail-throws behaviour).
  throw new Error(result.error || 'Email delivery failed after retries');
}

/**
 * Build an SMS reminder message body.
 */
function buildReminderSMS({ studentName, className, feeAmount, remainingBalance, schoolName, reminderCount, escalationLevel, paymentDeadline }) {
  const outstanding = remainingBalance != null ? remainingBalance : feeAmount;

  const ESCALATION_LABELS = {
    1: { prefix: '', urgency: 'Friendly reminder' },
    2: { prefix: 'URGENT: ', urgency: 'Urgent reminder' },
    3: { prefix: 'OVERDUE: ', urgency: 'Overdue notice' },
  };
  const esc = ESCALATION_LABELS[escalationLevel] || ESCALATION_LABELS[1];

  const deadlineStr = paymentDeadline
    ? new Date(paymentDeadline).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  let message = `${esc.prefix}${esc.urgency}: ${studentName} (${className}) has unpaid school fees at ${schoolName}. Outstanding: ${outstanding}. `;
  if (deadlineStr) {
    message += `Due: ${deadlineStr}. `;
  }
  if (reminderCount > 1) {
    message += `(Reminder #${reminderCount}) `;
  }
  message += 'Please arrange payment.';

  return message;
}

/**
 * Send an SMS fee reminder to a parent.
 *
 * @param {object} opts
 * @param {string} opts.to            - Parent phone number (E.164 format)
 * @param {string} opts.studentName
 * @param {string} opts.className
 * @param {number} opts.feeAmount
 * @param {number|null} opts.remainingBalance
 * @param {string} opts.schoolName
 * @param {number} opts.reminderCount
 * @param {number} [opts.escalationLevel=1]
 * @param {Date|null} [opts.paymentDeadline]
 * @returns {Promise<{sent: boolean, sid?: string}>}
 */
async function sendSmsReminder(opts) {
  const message = buildReminderSMS(opts);
  const result = await sendSms(opts.to, message);

  if (result.sent) {
    logger.info('Reminder SMS sent', {
      sid: result.sid,
      to: opts.to,
      studentId: opts.studentId,
      reminderCount: opts.reminderCount,
    });
    return { sent: true, sid: result.sid };
  }

  logger.warn('Reminder SMS not sent', {
    to: opts.to,
    studentId: opts.studentId,
    error: result.error,
  });
  return { sent: false, error: result.error };
}

/**
 * Send a WhatsApp fee reminder to a parent.
 *
 * @param {object} opts
 * @param {string} opts.to            - Parent WhatsApp number (E.164 format)
 * @param {string} opts.studentName
 * @param {string} opts.className
 * @param {number} opts.feeAmount
 * @param {number|null} opts.remainingBalance
 * @param {string} opts.schoolName
 * @param {number} opts.reminderCount
 * @param {number} [opts.escalationLevel=1]
 * @param {Date|null} [opts.paymentDeadline]
 * @returns {Promise<{sent: boolean, sid?: string}>}
 */
async function sendWhatsAppReminder(opts) {
  const message = buildReminderSMS(opts);
  const result = await sendWhatsApp(opts.to, message);

  if (result.sent) {
    logger.info('Reminder WhatsApp sent', {
      sid: result.sid,
      to: opts.to,
      studentId: opts.studentId,
      reminderCount: opts.reminderCount,
    });
    return { sent: true, sid: result.sid };
  }

  logger.warn('Reminder WhatsApp not sent', {
    to: opts.to,
    studentId: opts.studentId,
    error: result.error,
  });
  return { sent: false, error: result.error };
}

module.exports = { sendFeeReminder, sendSmsReminder, sendWhatsAppReminder, verifySmtp };
