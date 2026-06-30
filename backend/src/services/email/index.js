'use strict';

/**
 * Unified email send path (Issue #80).
 *
 * All transactional email (receipts, reminders) flows through sendEmail(), which:
 *   1. Honours the suppression list — never sends to a bounced/complained/
 *      unsubscribed address.
 *   2. Sends through the configured pluggable provider (smtp | ses | sendgrid |
 *      console) — see emailProvider.js.
 *   3. Retries transient failures with exponential backoff + jitter so an email
 *      that fails for a blip is not silently lost.
 *
 * Bounce/complaint handling is asynchronous (provider webhooks → suppressionList),
 * see controllers/emailWebhookController.js.
 */

const config = require('../../config');
const logger = require('../../utils/logger').child('EmailService');
const { getProvider } = require('./emailProvider');
const suppressionList = require('./suppressionList');

const MAX_RETRIES = parseInt(process.env.EMAIL_MAX_RETRIES, 10) || 3;
const RETRY_BASE_MS = parseInt(process.env.EMAIL_RETRY_BASE_MS, 10) || 500;
const RETRY_MAX_MS = parseInt(process.env.EMAIL_RETRY_MAX_MS, 10) || 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
  // +/- 20% jitter to avoid synchronised retries when many sends fail at once.
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Send a transactional email with suppression checks and retry.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} [message.text]
 * @param {string} [message.html]
 * @param {string} [message.from]
 * @param {string} [message.category]   - logical type, e.g. 'receipt'|'reminder'
 * @returns {Promise<{sent:boolean, skipped?:boolean, suppressed?:boolean,
 *   messageId?:string, attempts?:number, provider?:string, error?:string}>}
 */
async function sendEmail(message) {
  const { to, subject, category } = message;

  if (!to) {
    logger.info('Email skipped — no recipient', { category, subject });
    return { sent: false, skipped: true, reason: 'no_recipient' };
  }

  // 1. Suppression check — never email a bounced/complained/unsubscribed address.
  if (await suppressionList.isSuppressed(to)) {
    logger.info('Email skipped — recipient suppressed', { to, category });
    return { sent: false, skipped: true, suppressed: true };
  }

  const provider = getProvider();

  // 2. Send with retry on transient failure.
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { messageId } = await provider.send(message);
      logger.info('Email sent', { to, category, provider: provider.name, messageId, attempts: attempt });
      return { sent: true, messageId, attempts: attempt, provider: provider.name };
    } catch (err) {
      lastError = err;
      const willRetry = attempt < MAX_RETRIES;
      logger.warn('Email send attempt failed', {
        to,
        category,
        provider: provider.name,
        attempt,
        willRetry,
        error: err.message,
      });
      if (willRetry) await sleep(backoff(attempt));
    }
  }

  logger.error('Email send failed after retries', {
    to,
    category,
    provider: provider.name,
    attempts: MAX_RETRIES,
    error: lastError?.message,
  });
  return { sent: false, attempts: MAX_RETRIES, provider: provider.name, error: lastError?.message };
}

/**
 * Verify the active provider is reachable/configured (used by /health and the
 * reminder startup check).
 */
async function verify() {
  const provider = getProvider();
  if (typeof provider.verify !== 'function') return { ok: true };
  return provider.verify();
}

module.exports = {
  sendEmail,
  verify,
  suppressionList,
  MAX_RETRIES,
};
