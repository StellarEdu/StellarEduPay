'use strict';

/**
 * SMS / WhatsApp Service
 *
 * Thin wrapper around the Twilio REST API.  The Twilio client is lazily
 * initialised the first time a message is sent, so the module loads without
 * error even when Twilio credentials are absent (e.g. local dev).
 *
 * When credentials are not configured, both sendSms() and sendWhatsApp()
 * fall back to a console-log so outbound messages are still visible during
 * development without requiring real Twilio credentials.
 *
 * Required environment variables (all optional — absence enables dev mode):
 *   TWILIO_ACCOUNT_SID   — Twilio Account SID  (starts with "AC")
 *   TWILIO_AUTH_TOKEN    — Twilio Auth Token
 *   TWILIO_FROM_NUMBER   — E.164 sender number for SMS (e.g. +15005550006)
 *   TWILIO_WHATSAPP_FROM — WhatsApp-enabled number prefixed with "whatsapp:"
 *                          (e.g. whatsapp:+14155238886)
 */

const config = require('../config');
const logger = require('../utils/logger').child('SmsService');

let _twilioClient = null;

/**
 * Lazily initialise and return the Twilio REST client.
 * Returns null when credentials are not configured.
 */
function getTwilioClient() {
  if (_twilioClient) return _twilioClient;

  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    return null;
  }

  // Require twilio here (not at module top) so the module can load in
  // environments where the package is present but credentials are absent.
  const twilio = require('twilio');
  _twilioClient = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return _twilioClient;
}

/**
 * Check whether Twilio credentials are fully configured.
 */
function isTwilioConfigured() {
  return !!(
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    config.TWILIO_FROM_NUMBER
  );
}

/**
 * Validate a phone number as E.164 (e.g. +447700900000).
 *
 * @param {string} phone
 * @returns {boolean}
 */
function isValidE164(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{1,14}$/.test(phone.trim());
}

/**
 * Send an SMS message.
 *
 * @param {string} to   - Recipient phone number in E.164 format (e.g. +447700900000)
 * @param {string} body - Message text (max 1600 chars; longer messages are split)
 * @returns {Promise<{sent: boolean, sid?: string}>}
 */
async function sendSms(to, body) {
  if (!isValidE164(to)) {
    logger.warn('Refusing to send SMS — recipient is not a valid E.164 number', { to });
    return { sent: false, error: 'invalid_recipient' };
  }

  const client = getTwilioClient();

  if (!client || !config.TWILIO_FROM_NUMBER) {
    // Dev / no-Twilio fallback — log so the message is not silently dropped
    logger.info('SMS (no Twilio — dev mode)', { to, body });
    return { sent: false };
  }

  try {
    const message = await client.messages.create({
      from: config.TWILIO_FROM_NUMBER,
      to,
      body,
    });

    logger.info('SMS sent', { to, sid: message.sid });
    return { sent: true, sid: message.sid };
  } catch (err) {
    logger.error('Failed to send SMS', { to, error: err.message });
    return { sent: false, error: err.message };
  }
}

/**
 * Send a WhatsApp message via the Twilio WhatsApp API.
 *
 * The `to` number should be in E.164 format; the "whatsapp:" prefix is added
 * automatically if it is missing.
 *
 * @param {string} to   - Recipient WhatsApp number (E.164 or whatsapp:+...)
 * @param {string} body - Message text
 * @returns {Promise<{sent: boolean, sid?: string}>}
 */
async function sendWhatsApp(to, body) {
  // Normalise the recipient address — Twilio requires the "whatsapp:" prefix
  const toAddress = to && to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const bareNumber = toAddress.replace(/^whatsapp:/, '');

  if (!isValidE164(bareNumber)) {
    logger.warn('Refusing to send WhatsApp — recipient is not a valid E.164 number', { to });
    return { sent: false, error: 'invalid_recipient' };
  }

  const client = getTwilioClient();

  if (!client || !config.TWILIO_WHATSAPP_FROM) {
    // Dev / no-Twilio fallback
    logger.info('WhatsApp (no Twilio — dev mode)', { to: toAddress, body });
    return { sent: false };
  }

  try {
    const message = await client.messages.create({
      from: config.TWILIO_WHATSAPP_FROM,
      to:   toAddress,
      body,
    });

    logger.info('WhatsApp message sent', { to: toAddress, sid: message.sid });
    return { sent: true, sid: message.sid };
  } catch (err) {
    logger.error('Failed to send WhatsApp message', { to: toAddress, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = { sendSms, sendWhatsApp, isTwilioConfigured, isValidE164 };
