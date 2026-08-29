'use strict';

const SENSITIVE_KEYS = new Set(['JWT_SECRET', 'WEBHOOK_SECRET', 'MONGO_URI', 'MONGODB_URI', 'SMTP_PASS', 'REDIS_PASSWORD']);

// Request body/query fields that must never be written to request logs.
const REQUEST_LOG_REDACT_FIELDS = [
  'txHash',
  'studentId',
  'memo',
  'senderAddress',
  'password',
  'secret',
  'token',
  'mfaCode',
  'backupCode',
  'currentPassword',
];

function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) && v !== undefined ? '[REDACTED]' : v]));
}

module.exports = { redactConfig, SENSITIVE_KEYS, REQUEST_LOG_REDACT_FIELDS };
