'use strict';

/**
 * Unified Secret Resolution & File-Based Secrets (`*_FILE`) — Issue #1829
 *
 * Generalizes secret loading across all sensitive configuration keys so that
 * deployments using Docker Swarm Secrets, Kubernetes projected volumes, or
 * external secrets providers (AWS Secrets Manager, HTTP/Vault proxy) do not
 * have to expose plaintext secrets in `process.env`.
 *
 * Supported resolution rules for any sensitive key `X`:
 *   1. If both `X` and `X_FILE` are non-empty in the environment, throw an
 *      explicit configuration error to prevent ambiguous precedence.
 *   2. If `X_FILE` is set, read the file at that path synchronously at boot
 *      (UTF-8, `.trim()`) and return its contents.
 *   3. Otherwise return the in-memory provider cache entry (if populated by
 *      `initializeSecretsProvider()`) or `env[X]`.
 */

const fs = require('fs');

const SENSITIVE_CONFIG_KEYS = Object.freeze([
  'JWT_SECRET',
  'RECEIPT_SIGNATURE_SECRET',
  'ADMIN_PASSWORD',
  'ADMIN_PASSWORD_HASH',
  'STUDENT_PII_ENCRYPTION_KEY',
  'WEBHOOK_SECRET_ENCRYPTION_KEY',
  'AUDIT_HMAC_KEY',
  'METRICS_BEARER_TOKEN',
  'SMTP_PASS',
  'SENDGRID_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'ANCHOR_PLATFORM_KEYPAIR',
  'REDIS_PASSWORD',
  'MONGO_URI',
  'SIGNER_MASTER_KEY',
]);

const HTTP_FETCH_TIMEOUT_MS = 5000;

// In-memory map populated by initializeSecretsProvider() when SECRETS_PROVIDER
// is configured ('aws_secrets_manager' | 'http').
let _providerSecretsCache = {};

/**
 * Resolve a single secret key `name` from `envSource` (defaults to `process.env`),
 * supporting `<name>_FILE` and the in-memory secrets provider cache.
 *
 * @param {string} name
 * @param {object} [envSource=process.env]
 * @returns {string|undefined}
 */
function resolveSecret(name, envSource = process.env) {
  const fileKey = `${name}_FILE`;
  const rawVal = envSource[name];
  const filePath = envSource[fileKey];

  const hasDirect = rawVal !== undefined && rawVal !== null && String(rawVal) !== '';
  const hasFile = filePath !== undefined && filePath !== null && String(filePath).trim() !== '';

  if (hasDirect && hasFile) {
    throw new Error(
      `[Secrets] Ambiguous configuration: both ${name} and ${fileKey} are set. ` +
        `Provide either ${name} or ${fileKey}, not both.`
    );
  }

  if (hasFile) {
    const trimmedPath = String(filePath).trim();
    let content;
    try {
      content = fs.readFileSync(trimmedPath, 'utf8');
    } catch (err) {
      throw new Error(
        `[Secrets] Failed to read secret for ${name} from ${fileKey} ("${trimmedPath}"): ${err.message}`
      );
    }
    return content.trim();
  }

  if (
    envSource === process.env &&
    Object.prototype.hasOwnProperty.call(_providerSecretsCache, name) &&
    _providerSecretsCache[name] !== undefined
  ) {
    return _providerSecretsCache[name];
  }

  return rawVal;
}

/**
 * Build a shallow copy of `envSource` with all `SENSITIVE_CONFIG_KEYS` (and any
 * custom `*_FILE` pairs present in `envSource`) resolved into their base keys.
 * Also syncs resolved values into `envSource` when `mutate = true` so modules
 * reading `process.env.<KEY>` directly after config boot see the resolved secret.
 *
 * @param {object} [envSource=process.env]
 * @param {{ mutate?: boolean, keys?: string[] }} [options]
 * @returns {object}
 */
function resolveEnvSecrets(envSource = process.env, options = {}) {
  const { mutate = false, keys = SENSITIVE_CONFIG_KEYS } = options;
  const resolved = { ...envSource };

  const keySet = new Set(keys);
  for (const k of Object.keys(envSource)) {
    if (k.endsWith('_FILE') && k.length > 5) {
      keySet.add(k.slice(0, -5));
    }
  }

  for (const key of keySet) {
    const val = resolveSecret(key, envSource);
    if (val !== undefined) {
      resolved[key] = val;
      if (mutate && envSource[key] === undefined) {
        envSource[key] = val;
      }
    }
  }

  return resolved;
}

/**
 * Optional async initialization for external secret bundles (AWS Secrets Manager
 * or an HTTP/Vault endpoint) covering all sensitive config keys.
 *
 * Environment variables:
 *   SECRETS_PROVIDER          'env' (default) | 'file' | 'aws_secrets_manager' | 'http'
 *   SECRETS_AWS_SECRET_ID     Secret name or ARN returning a JSON map of secret keys
 *   SECRETS_HTTP_URL          HTTP endpoint returning a JSON map of secret keys
 *   SECRETS_HTTP_TOKEN        Optional bearer token for SECRETS_HTTP_URL
 *
 * @param {object} [envSource=process.env]
 * @returns {Promise<Record<string, string>>}
 */
async function initializeSecretsProvider(envSource = process.env) {
  const provider = (envSource.SECRETS_PROVIDER || 'env').toLowerCase();

  if (provider === 'env' || provider === 'file') {
    return _providerSecretsCache;
  }

  let rawPayload;
  if (provider === 'aws_secrets_manager') {
    const secretId = envSource.SECRETS_AWS_SECRET_ID;
    if (!secretId) {
      throw new Error(
        '[Secrets] SECRETS_AWS_SECRET_ID is required when SECRETS_PROVIDER=aws_secrets_manager.'
      );
    }
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient(
      envSource.AWS_REGION ? { region: envSource.AWS_REGION } : {}
    );
    try {
      const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      rawPayload = response.SecretString;
    } catch (err) {
      throw new Error(
        `[Secrets] Failed to fetch secrets bundle "${secretId}" from AWS Secrets Manager: ${err.message}`
      );
    }
  } else if (provider === 'http') {
    const url = envSource.SECRETS_HTTP_URL;
    if (!url) {
      throw new Error('[Secrets] SECRETS_HTTP_URL is required when SECRETS_PROVIDER=http.');
    }
    const headers = {};
    const token = resolveSecret('SECRETS_HTTP_TOKEN', envSource);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      rawPayload = await resp.text();
    } catch (err) {
      throw new Error(`[Secrets] Failed to fetch secrets bundle from ${url}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  } else {
    throw new Error(
      `[Secrets] Unknown SECRETS_PROVIDER "${provider}". Use 'env', 'file', 'aws_secrets_manager', or 'http'.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse((rawPayload || '').trim());
  } catch {
    throw new Error(`[Secrets] Secrets provider "${provider}" did not return valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[Secrets] Secrets provider "${provider}" must return a JSON object.`);
  }

  const nextCache = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined && v !== null) {
      nextCache[k] = String(v).trim();
    }
  }
  _providerSecretsCache = nextCache;
  return _providerSecretsCache;
}

function _clearProviderSecretsCache() {
  _providerSecretsCache = {};
}

module.exports = {
  SENSITIVE_CONFIG_KEYS,
  resolveSecret,
  resolveEnvSecrets,
  initializeSecretsProvider,
  _clearProviderSecretsCache,
};
