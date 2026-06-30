'use strict';

/**
 * SMTP email provider (nodemailer). Used when EMAIL_PROVIDER=smtp and SMTP_*
 * settings are configured.
 */

const nodemailer = require('nodemailer');
const config = require('../../../config');
const logger = require('../../../utils/logger').child('EmailProvider:smtp');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    throw new Error('SMTP provider selected but SMTP_HOST/SMTP_USER/SMTP_PASS are not configured');
  }
  _transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  return _transporter;
}

module.exports = {
  name: 'smtp',

  async send(message) {
    const info = await getTransporter().sendMail({
      from: message.from || config.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { messageId: info.messageId };
  },

  async verify() {
    try {
      await getTransporter().verify();
      return { ok: true };
    } catch (err) {
      logger.error('SMTP verification failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  },

  // Exposed for tests to reset the cached transporter.
  _reset() {
    _transporter = null;
  },
};
