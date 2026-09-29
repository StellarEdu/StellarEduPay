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
 *
 * Issue #1587: i18n labels are resolved from the school's emailLocale via
 * renderEmailTemplate (which calls buildI18nVars internally), so reminder
 * emails are delivered in the school's configured language.
 * Issue #1588: supportContact from school settings is now included in vars.
 */

const config = require('../config');
const logger = require('../utils/logger').child('NotificationService');
const { generateUnsubscribeToken } = require('../utils/unsubscribeToken');
const { renderEmailTemplate } = require('../utils/templateRenderer');
const { t } = require('./i18n');
const email = require('./email');
const { sendSms, sendWhatsApp, isTwilioConfigured } = require('./smsService');
const School = require('../models/schoolModel');
const { formatCryptoAmount, formatWithFiatEquivalent } = require('../utils/formatMoney');

/**
 * Verify the active email provider is reachable/configured.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
async function verifySmtp() {
  return email.verify();
}

/**
 * Build the reminder email body from external template files.
 *
 * @param {object} opts
 * @param {string} opts.locale        - BCP-47 locale code for email language (e.g. 'en', 'fr')
 * @param {string} opts.timezone      - IANA timezone for deadline formatting (e.g. 'UTC')
 * @param {string} [opts.assetCode]   - Asset code for amount display, e.g. 'XLM' or 'USDC'
 * @param {string} [opts.localCurrency] - ISO 4217 fiat currency for fiat equivalent, e.g. 'NGN'
 */
async function buildReminderEmail({ studentName, studentId, className, feeAmount, remainingBalance, schoolName, reminderCount, unsubscribeUrl, escalationLevel, paymentDeadline, logoUrl, primaryColor, address, supportContact, locale, timezone, assetCode, localCurrency }) {
  const outstanding = remainingBalance != null ? remainingBalance : feeAmount;
  // Issue #1587: use the school's configured locale for translated labels.
  const resolvedLocale = locale || 'en';
  const resolvedAsset = assetCode || 'XLM';

  // Issue #1589: format amounts with the asset code and optional fiat equivalent
  // so parents see "250.00 USDC (≈ ₦390,000 NGN at today's rate)" instead of "250".
  const [feeAmountFormatted, outstandingFormatted] = await Promise.all([
    formatWithFiatEquivalent(feeAmount, resolvedAsset, localCurrency || null, resolvedLocale),
    formatWithFiatEquivalent(outstanding, resolvedAsset, localCurrency || null, resolvedLocale),
  ]);

  // Determine escalation prefix and urgency message
  const ESCALATION_LABELS = {
    1: { prefix: '', urgency: t(resolvedLocale, 'feeReminder') },
    2: { prefix: 'URGENT: ', urgency: t(resolvedLocale, 'feeReminder') },
    3: { prefix: 'OVERDUE: ', urgency: t(resolvedLocale, 'feeReminder') },
  };
  const esc = ESCALATION_LABELS[escalationLevel] || ESCALATION_LABELS[1];
  const subject = `${esc.prefix}[${schoolName}] Fee Payment Reminder — ${studentName}`;
  const reminderNote = reminderCount > 1 ? t(resolvedLocale, 'reminderNote', { n: reminderCount }) : '';

  // Issue #1587: format the deadline using the school's locale and timezone so
  // dates are presented in the user's regional format rather than hard-coded 'en-US'.
  const dateLocale = resolvedLocale === 'tpi' ? 'en' : resolvedLocale; // Intl fallback for Tok Pisin
  const deadlineStr = paymentDeadline
    ? new Date(paymentDeadline).toLocaleDateString(dateLocale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: timezone || 'UTC',
      })
    : null;

  const vars = {
    // Issue #1587: pass locale so renderEmailTemplate builds the correct i18n vars.
    locale: resolvedLocale,
    studentName,
    studentId,
    className,
    // Issue #1589: use formatted amounts (with asset code) instead of bare numbers.
    feeAmount: feeAmountFormatted,
    outstanding: outstandingFormatted,
    schoolName,
    reminderNote,
    urgency: esc.urgency,
    deadline: deadlineStr || '',
    unsubscribeUrl: unsubscribeUrl || '',
    logoUrl: logoUrl || '',
    primaryColor: primaryColor || '#1a56db',
    schoolAddress: address || '',
    // Issue #1588: include supportContact so the template placeholder is filled.
    supportContact: supportContact || '',
  };
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
 * @param {string} [opts.assetCode]         - Asset code, e.g. 'XLM' or 'USDC'
 * @param {number} [opts.escalationLevel=1] - 1=early, 2=approaching, 3=overdue
 * @param {Date|null} [opts.paymentDeadline] - Payment deadline date
 * @returns {Promise<{sent: boolean, messageId?: string, preview?: string, suppressed?: boolean}>}
 */
async function sendFeeReminder(opts) {
  const token = generateUnsubscribeToken(opts.studentId, opts.schoolId || 'unknown', config.JWT_SECRET);
  // APP_URL is required (HTTPS) in production — see config/index.js.
  const baseUrl = (config.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const encodedToken = encodeURIComponent(token);
  // Issue #1542: the in-body link opens the frontend /unsubscribe page, which
  // asks for confirmation (and offers undo) before POSTing the opt-out, so
  // link pre-fetching by email security scanners changes nothing.
  const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${encodedToken}`;
  // RFC 8058 one-click endpoint — mailbox providers POST
  // "List-Unsubscribe=One-Click" to this URL.
  const oneClickUrl = `${baseUrl}/api/reminders/unsubscribe?token=${encodedToken}`;

  let school = null;
  if (opts.schoolId) {
    try {
      school = await School.findOne({ schoolId: opts.schoolId });
    } catch (err) {
      logger.warn('Failed to fetch school branding for reminder', { schoolId: opts.schoolId, error: err.message });
    }
  }

  const { subject, text, html } = await buildReminderEmail({
    ...opts,
    unsubscribeUrl,
    logoUrl: school?.logoUrl || '',
    primaryColor: school?.primaryColor || '#1a56db',
    address: school?.address || '',
    // Issue #1587: resolve locale from school settings → fall back to 'en'.
    locale: school?.emailLocale || 'en',
    // Issue #1587: use school's timezone for date formatting.
    timezone: school?.timezone || 'UTC',
    // Issue #1588: pass school support contact so the template placeholder is filled.
    supportContact: school?.supportContact || '',
    // Issue #1589: pass asset code and local currency for formatted amounts.
    assetCode: opts.assetCode || 'XLM',
    localCurrency: school?.localCurrency || null,
  });

  const result = await email.sendEmail({
    to: opts.to,
    subject,
    text,
    html,
    category: 'reminder',
    headers: {
      'List-Unsubscribe': `<${oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
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
 *
 * Issue #1589: amounts are formatted with the asset code so the recipient
 * knows whether "250" means XLM or USDC.
 */
function buildReminderSMS({ studentName, className, feeAmount, remainingBalance, schoolName, reminderCount, escalationLevel, paymentDeadline, assetCode }) {
  const outstanding = remainingBalance != null ? remainingBalance : feeAmount;
  const resolvedAsset = assetCode || 'XLM';

  // Issue #1589: format amounts with the asset code (no async fiat lookup in SMS
  // to keep the builder synchronous and side-effect-free).
  const outstandingFormatted = formatCryptoAmount(outstanding, resolvedAsset, 'en');

  const ESCALATION_LABELS = {
    1: { prefix: '', urgency: 'Friendly reminder' },
    2: { prefix: 'URGENT: ', urgency: 'Urgent reminder' },
    3: { prefix: 'OVERDUE: ', urgency: 'Overdue notice' },
  };
  const esc = ESCALATION_LABELS[escalationLevel] || ESCALATION_LABELS[1];

  const deadlineStr = paymentDeadline
    ? new Date(paymentDeadline).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  let message = `${esc.prefix}${esc.urgency}: ${studentName} (${className}) has unpaid school fees at ${schoolName}. Outstanding: ${outstandingFormatted}. `;
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
