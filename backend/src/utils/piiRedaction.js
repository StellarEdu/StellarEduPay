'use strict';

const crypto = require('crypto');

/**
 * PII Redaction Utilities for Logging
 * 
 * Provides field-level redaction for personal data in logs to comply with
 * data minimisation requirements (GDPR Art. 5(1)(c), storage limitation).
 */

// Fields that contain PII and should be redacted in logs
const PII_FIELDS = new Set([
  'email',
  'parentEmail',
  'contactEmail',
  'parentPhone',
  'phone',
  'loginId',
  'name',
  'studentId',
  'memo',
  'senderAddress',
  'walletAddress',
  // Issue #2015 — raw request bodies are never logged.
  'rawBody',
]);

/**
 * Keyed hash for IP addresses in logs. Uses HMAC-SHA256 with a per-boot
 * secret so that:
 * 1. IPs are not reversible from logs
 * 2. Same IP maps to same hash within a server session (for correlation)
 * 3. Different servers produce different hashes (no cross-server tracking)
 */
let _ipHashKey = crypto.randomBytes(32);

function hashIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  return crypto.createHmac('sha256', _ipHashKey)
    .update(ip)
    .digest('hex')
    .slice(0, 16); // 64-bit hash, sufficient for collision resistance in a day's logs
}

/**
 * Mask an email address: shows first character and domain, masks the rest.
 * Example: user@example.com → u***@example.com
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const match = email.match(/^(.).*?@(.+)$/);
  if (!match) return '[MASKED]';
  return `${match[1]}***@${match[2]}`;
}

/**
 * Mask a phone number: shows last 4 digits only.
 * Example: +1234567890 → ****7890
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `****${digits.slice(-4)}`;
}

/**
 * Mask a name: shows first character of first word and first character of last word.
 * Example: John Smith → J*** S.
 */
function maskName(name) {
  if (!name || typeof name !== 'string') return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return `${parts[0][0]}***`;
  return `${parts[0][0]}*** ${parts[parts.length - 1][0]}.`;
}

/**
 * Redact PII fields from an object for logging.
 * Returns a new object with sensitive fields masked.
 */
function redactPii(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactPii);
  
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS.has(key)) {
      if (key === 'email' || key === 'parentEmail' || key === 'contactEmail' || key === 'loginId') {
        result[key] = maskEmail(value);
      } else if (key === 'phone' || key === 'parentPhone') {
        result[key] = maskPhone(value);
      } else if (key === 'name') {
        result[key] = maskName(value);
      } else {
        result[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactPii(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Strip query strings from URLs to prevent token/secret leakage in logs.
 */
function stripQueryString(url) {
  if (!url || typeof url !== 'string') return url;
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.substring(0, idx);
}

module.exports = {
  hashIp,
  maskEmail,
  maskPhone,
  maskName,
  redactPii,
  stripQueryString,
  PII_FIELDS,
};
