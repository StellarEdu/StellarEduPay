'use strict';

/**
 * Email provider webhook authentication — Issue #1537.
 *
 *   - verifySnsMessage()          Amazon SNS message signature verification
 *                                 (SES bounce/complaint notifications are
 *                                 delivered through SNS).
 *   - verifySendGridSignature()   SendGrid Signed Event Webhook (ECDSA P-256 /
 *                                 SHA-256 over `timestamp + rawBody`).
 *   - safeEqualSecret()           constant-time shared-secret comparison.
 *   - isAllowedSnsUrl()           host allow-list for SigningCertURL and
 *                                 SubscribeURL (sns.<region>.amazonaws.com).
 */

const crypto = require('crypto');
const axios = require('axios');

const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const CERT_FETCH_TIMEOUT_MS = 5000;
const CERT_MAX_BYTES = 16 * 1024;
const CERT_CACHE_MAX = 50;

// SigningCertURL → PEM. AWS rotates signing certs rarely; caching avoids a
// network round trip per notification.
const _certCache = new Map();

/**
 * Constant-time comparison of a provided secret against the expected one.
 * Both values are hashed first so differing lengths do not leak via timing.
 *
 * @param {string|undefined|null} provided
 * @param {string} expected
 * @returns {boolean}
 */
function safeEqualSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when `rawUrl` is an https:// URL on an Amazon SNS host.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {boolean} [opts.requirePem=false]  also require a .pem path (SigningCertURL)
 * @returns {boolean}
 */
function isAllowedSnsUrl(rawUrl, { requirePem = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || (u.port && u.port !== '443')) return false;
  if (!SNS_HOST_RE.test(u.hostname.toLowerCase())) return false;
  if (requirePem && !u.pathname.endsWith('.pem')) return false;
  return true;
}

/**
 * Build the canonical SNS string-to-sign for a message.
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * @param {object} msg
 * @returns {string|null} null for unsupported message types
 */
function buildSnsStringToSign(msg) {
  let keys;
  if (msg.Type === 'Notification') {
    keys = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
  } else if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
    keys = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  } else {
    return null;
  }
  let out = '';
  for (const key of keys) {
    // Subject is optional on notifications and omitted from the string when absent.
    if (msg[key] === undefined || msg[key] === null) {
      if (key === 'Subject') continue;
      return null;
    }
    out += `${key}\n${msg[key]}\n`;
  }
  return out;
}

async function _fetchSigningCert(certUrl) {
  if (_certCache.has(certUrl)) return _certCache.get(certUrl);
  const res = await axios.get(certUrl, {
    timeout: CERT_FETCH_TIMEOUT_MS,
    responseType: 'text',
    maxRedirects: 0,
    maxContentLength: CERT_MAX_BYTES,
    transformResponse: [(d) => d],
  });
  const pem = String(res.data || '');
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('SigningCertURL did not return a PEM certificate');
  }
  if (_certCache.size >= CERT_CACHE_MAX) {
    _certCache.delete(_certCache.keys().next().value);
  }
  _certCache.set(certUrl, pem);
  return pem;
}

/**
 * Verify an Amazon SNS message signature.
 *
 * @param {object} msg  Parsed SNS JSON envelope
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function verifySnsMessage(msg) {
  if (!msg || typeof msg !== 'object') return { valid: false, reason: 'MALFORMED_SNS_MESSAGE' };
  if (!msg.Signature || !msg.SigningCertURL) return { valid: false, reason: 'UNSIGNED_SNS_MESSAGE' };

  let algorithm;
  if (String(msg.SignatureVersion) === '1') algorithm = 'RSA-SHA1';
  else if (String(msg.SignatureVersion) === '2') algorithm = 'RSA-SHA256';
  else return { valid: false, reason: 'UNSUPPORTED_SNS_SIGNATURE_VERSION' };

  if (!isAllowedSnsUrl(msg.SigningCertURL, { requirePem: true })) {
    return { valid: false, reason: 'INVALID_SNS_CERT_URL' };
  }

  const stringToSign = buildSnsStringToSign(msg);
  if (!stringToSign) return { valid: false, reason: 'MALFORMED_SNS_MESSAGE' };

  let certPem;
  try {
    certPem = await _fetchSigningCert(msg.SigningCertURL);
  } catch {
    return { valid: false, reason: 'SNS_CERT_FETCH_FAILED' };
  }

  try {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(stringToSign, 'utf8');
    const ok = verifier.verify(certPem, String(msg.Signature), 'base64');
    return ok ? { valid: true } : { valid: false, reason: 'INVALID_SNS_SIGNATURE' };
  } catch {
    return { valid: false, reason: 'INVALID_SNS_SIGNATURE' };
  }
}

/**
 * Parse the SendGrid verification key. SendGrid shows it as base64-encoded
 * DER (SubjectPublicKeyInfo); a PEM block is accepted too.
 *
 * @param {string} key
 * @returns {crypto.KeyObject}
 */
function _parseSendGridPublicKey(key) {
  const trimmed = String(key).trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(trimmed);
  return crypto.createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
}

/**
 * Verify a SendGrid Signed Event Webhook request.
 *
 * @param {object} opts
 * @param {string} opts.publicKey   EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY
 * @param {string} opts.signature   X-Twilio-Email-Event-Webhook-Signature (base64 DER ECDSA)
 * @param {string} opts.timestamp   X-Twilio-Email-Event-Webhook-Timestamp
 * @param {Buffer|string} opts.rawBody  exact request body bytes
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifySendGridSignature({ publicKey, signature, timestamp, rawBody }) {
  if (!signature || !timestamp) return { valid: false, reason: 'MISSING_SENDGRID_SIGNATURE' };
  // Issue #1797 — accept the raw Buffer so the signature covers the exact bytes.
  const bodyBytes = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : null;
  if (!bodyBytes) return { valid: false, reason: 'MISSING_RAW_BODY' };
  try {
    const key = _parseSendGridPublicKey(publicKey);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(Buffer.concat([Buffer.from(String(timestamp), 'utf8'), bodyBytes]));
    const ok = verifier.verify(key, Buffer.from(String(signature), 'base64'));
    return ok ? { valid: true } : { valid: false, reason: 'INVALID_SENDGRID_SIGNATURE' };
  } catch {
    return { valid: false, reason: 'INVALID_SENDGRID_SIGNATURE' };
  }
}

function _clearCertCache() {
  _certCache.clear();
}

module.exports = {
  safeEqualSecret,
  isAllowedSnsUrl,
  buildSnsStringToSign,
  verifySnsMessage,
  verifySendGridSignature,
  _clearCertCache,
};
