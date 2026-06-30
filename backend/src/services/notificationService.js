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
 * {{unsubscribeUrl}}
 */

const config = require('../config');
const logger = require('../utils/logger').child('NotificationService');
const { generateUnsubscribeToken } = require('../utils/unsubscribeToken');
const { renderEmailTemplate } = require('../utils/templateRenderer');
const email = require('./email');

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
function buildReminderEmail({ studentName, studentId, className, feeAmount, remainingBalance, schoolName, reminderCount, unsubscribeUrl }) {
  const outstanding = remainingBalance != null ? remainingBalance : feeAmount;
  const subject = `[${schoolName}] Fee Payment Reminder — ${studentName}`;
  const reminderNote = reminderCount > 1
    ? `Note: This is reminder #${reminderCount}. If you have already paid, please disregard this message.`
    : '';

  const vars = { studentName, studentId, className, feeAmount, outstanding, schoolName, reminderNote, unsubscribeUrl: unsubscribeUrl || '' };
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

module.exports = { sendFeeReminder, verifySmtp };
