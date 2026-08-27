'use strict';

/**
 * Payment receipt emails.
 * Issue #669: sends a receipt when a payment transitions to SUCCESS.
 * Issue #80:  now routed through the unified email module (services/email),
 *             which adds the pluggable provider, retry, and suppression handling.
 *             The receipt body is rendered from externalized templates
 *             (templates/receiptEmail.{txt,html}).
 */

const logger = require('../utils/logger');
const { sendEmail } = require('./email');
const { renderEmailTemplate } = require('../utils/templateRenderer');
const School = require('../models/schoolModel');

/**
 * Send payment receipt email to parent/student contact email.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.schoolId - School identifier for fetching branding
 * @param {string} options.studentName
 * @param {number} options.amount
 * @param {string} options.txHash
 * @param {Date}   options.confirmedAt
 * @param {number} options.remainingBalance
 * @returns {Promise<Object>} Email send result
 */
async function sendPaymentReceipt(options) {
  const { to, schoolId, studentName, amount, txHash, confirmedAt, remainingBalance } = options;

  if (!to) {
    logger.info({ msg: 'Payment receipt email skipped: no contact email', studentName, amount });
    return { sent: false, skipped: true };
  }

  // Fetch school branding data
  let school = null;
  if (schoolId) {
    try {
      school = await School.findOne({ schoolId });
    } catch (err) {
      logger.warn('Failed to fetch school branding for receipt', { schoolId, error: err.message });
    }
  }

  const { text, html } = renderEmailTemplate('receiptEmail', {
    studentName,
    amount,
    txHash,
    confirmedAt: confirmedAt ? new Date(confirmedAt).toISOString() : '',
    remainingBalance: remainingBalance > 0 ? remainingBalance : '',
    schoolName: school?.name || 'StellarEduPay',
    logoUrl: school?.logoUrl || '',
    primaryColor: school?.primaryColor || '#1a56db',
    schoolAddress: school?.address || '',
  });

  return sendEmail({
    to,
    subject: `Payment Receipt for ${studentName}`,
    text,
    html,
    category: 'receipt',
  });
}

module.exports = { sendPaymentReceipt };
