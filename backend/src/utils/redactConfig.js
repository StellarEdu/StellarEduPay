'use strict';

// Pattern-based secret detection to automatically cover new secrets.
// Matches common secret-related suffixes (and their *_FILE file-based secret
// counterparts) plus explicit known-non-secret exceptions.
const SECRET_PATTERN = /(SECRET|PASSWORD|PASS|TOKEN|KEY|KEYPAIR|SID|URI|HASH|API_KEY)(_FILE)?$/i;

// Known environment variable keys that match the pattern but are NOT secrets.
const NON_SECRET_ALLOWLIST = new Set([
  'SIGNER_KEY_SOURCE',
  'EMAIL_PROVIDER',
  'STELLAR_NETWORK',
  'AWS_REGION',
  'HORIZON_URL',
  'STELLAR_HORIZON_URL',
  'STELLAR_HORIZON_URLS',
  'PAYMENT_WEBHOOK_URL',
  'SIGNER_MASTER_KEY_HTTP_URL',
  'HORIZON_RATE_LIMIT_HEADER',
  'APP_URL',
  'API_URL',
]);

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
  'parentEmail',
  'parentPhone',
  'email',
  'phone',
];

/**
 * Determine if a config key should be redacted.
 * Uses pattern-based detection (any key ending with SECRET, PASSWORD, etc.)
 * with an explicit allowlist for known non-secret keys.
 */
function shouldRedact(key) {
  if (NON_SECRET_ALLOWLIST.has(key)) return false;
  if (typeof key === 'string' && key.endsWith('_FILE')) {
    const baseKey = key.slice(0, -5);
    if (NON_SECRET_ALLOWLIST.has(baseKey)) return false;
  }
  return SECRET_PATTERN.test(key);
}

/**
 * Redact credentials embedded in URIs (mongodb://user:pass@host, redis://:pass@host).
 */
function redactUri(value) {
  if (typeof value !== 'string') return value;
  
  // Match mongodb:// or redis:// URIs with embedded credentials
  return value
    .replace(/(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@/gi, '$1$2:[REDACTED]@')
    .replace(/(redis:\/\/:)([^@]+)@/gi, '$1[REDACTED]@');
}

/**
 * Redact configuration object for safe logging.
 * Redacts keys matching the secret pattern and credentials in URI strings.
 */
function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  
  return Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => {
      if (v === undefined) return [k, v];
      
      // Redact if key matches the secret pattern
      if (shouldRedact(k)) {
        return [k, '[REDACTED]'];
      }
      
      // Redact credentials in URI strings even if key name doesn't match pattern
      if (typeof v === 'string' && (v.startsWith('mongodb') || v.startsWith('redis'))) {
        return [k, redactUri(v)];
      }
      
      return [k, v];
    })
  );
}

module.exports = { 
  redactConfig, 
  shouldRedact, 
  redactUri, 
  REQUEST_LOG_REDACT_FIELDS,
  SECRET_PATTERN,
  NON_SECRET_ALLOWLIST,
};
