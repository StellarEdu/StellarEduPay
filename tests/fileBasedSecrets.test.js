'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SENSITIVE_CONFIG_KEYS,
  resolveSecret,
  resolveEnvSecrets,
  initializeSecretsProvider,
  _clearProviderSecretsCache,
} = require('../backend/src/config/secrets');
const { redactConfig, shouldRedact } = require('../backend/src/utils/redactConfig');

describe('file-based secrets (*_FILE) and secrets provider (#1829)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaredupay-secrets-'));
    _clearProviderSecretsCache();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
    _clearProviderSecretsCache();
  });

  test('covers all required sensitive config keys', () => {
    const expected = [
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
    ];
    for (const key of expected) {
      expect(SENSITIVE_CONFIG_KEYS).toContain(key);
    }
  });

  test('resolves secret from <KEY>_FILE and trims surrounding whitespace/newlines', () => {
    const secretFile = path.join(tmpDir, 'jwt_secret.txt');
    const expectedSecret = 'a'.repeat(48);
    fs.writeFileSync(secretFile, `  ${expectedSecret}\n\r\n`, 'utf8');

    const fakeEnv = {
      JWT_SECRET_FILE: secretFile,
    };

    expect(resolveSecret('JWT_SECRET', fakeEnv)).toBe(expectedSecret);
  });

  test('throws an ambiguity error when both <KEY> and <KEY>_FILE are set', () => {
    const secretFile = path.join(tmpDir, 'jwt_secret.txt');
    fs.writeFileSync(secretFile, 'b'.repeat(48), 'utf8');

    const fakeEnv = {
      JWT_SECRET: 'c'.repeat(48),
      JWT_SECRET_FILE: secretFile,
    };

    expect(() => resolveSecret('JWT_SECRET', fakeEnv)).toThrow(
      /both JWT_SECRET and JWT_SECRET_FILE are set/i
    );
  });

  test('throws a descriptive error when <KEY>_FILE points to a missing file', () => {
    const missingFile = path.join(tmpDir, 'does-not-exist.txt');
    const fakeEnv = {
      RECEIPT_SIGNATURE_SECRET_FILE: missingFile,
    };

    expect(() => resolveSecret('RECEIPT_SIGNATURE_SECRET', fakeEnv)).toThrow(
      /Failed to read secret for RECEIPT_SIGNATURE_SECRET from RECEIPT_SIGNATURE_SECRET_FILE/i
    );
  });

  test('resolveEnvSecrets resolves all *_FILE keys and optionally mutates target env', () => {
    const mongoFile = path.join(tmpDir, 'mongo_uri');
    const smtpFile = path.join(tmpDir, 'smtp_pass');
    fs.writeFileSync(mongoFile, 'mongodb://localhost:27017/school_db\n', 'utf8');
    fs.writeFileSync(smtpFile, 'super-secret-smtp-pass\n', 'utf8');

    const envObj = {
      MONGO_URI_FILE: mongoFile,
      SMTP_PASS_FILE: smtpFile,
      PORT: '5000',
    };

    const resolved = resolveEnvSecrets(envObj, { mutate: true });
    expect(resolved.MONGO_URI).toBe('mongodb://localhost:27017/school_db');
    expect(resolved.SMTP_PASS).toBe('super-secret-smtp-pass');
    expect(envObj.MONGO_URI).toBe('mongodb://localhost:27017/school_db');
    expect(envObj.SMTP_PASS).toBe('super-secret-smtp-pass');
  });

  test('config/index.js loads required secrets from *_FILE when direct env vars are unset', () => {
    const jwtFile = path.join(tmpDir, 'jwt_secret');
    const receiptFile = path.join(tmpDir, 'receipt_secret');
    const mongoFile = path.join(tmpDir, 'mongo_uri');

    const jwtVal = 'x'.repeat(40);
    const receiptVal = 'receipt-secret-from-mounted-file';
    const mongoVal = 'mongodb://127.0.0.1:27017/stellaredupay_test';

    fs.writeFileSync(jwtFile, `${jwtVal}\n`, 'utf8');
    fs.writeFileSync(receiptFile, `${receiptVal}\n`, 'utf8');
    fs.writeFileSync(mongoFile, `${mongoVal}\n`, 'utf8');

    const prevEnv = { ...process.env };
    try {
      jest.resetModules();
      delete process.env.JWT_SECRET;
      delete process.env.RECEIPT_SIGNATURE_SECRET;
      delete process.env.MONGO_URI;

      process.env.JWT_SECRET_FILE = jwtFile;
      process.env.RECEIPT_SIGNATURE_SECRET_FILE = receiptFile;
      process.env.MONGO_URI_FILE = mongoFile;

      const cfg = require('../backend/src/config');
      expect(cfg.JWT_SECRET).toBe(jwtVal);
      expect(cfg.RECEIPT_SIGNATURE_SECRET).toBe(receiptVal);
      expect(cfg.MONGO_URI).toBe(mongoVal);
    } finally {
      process.env = prevEnv;
      jest.resetModules();
    }
  });

  test('initializeSecretsProvider fetches JSON bundle from HTTP provider', async () => {
    const bundle = {
      JWT_SECRET: 'z'.repeat(48),
      SENDGRID_API_KEY: 'SG.test-key',
      ANCHOR_PLATFORM_KEYPAIR: 'SABCDEF123456',
    };

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(bundle),
    });

    try {
      await initializeSecretsProvider({
        SECRETS_PROVIDER: 'http',
        SECRETS_HTTP_URL: 'https://vault.internal/v1/secrets/stellaredupay',
        SECRETS_HTTP_TOKEN: 'vault-token-123',
      });

      const emptyEnv = {};
      Object.setPrototypeOf(emptyEnv, null);
      // When called against process.env (and not overridden in process.env), uses provider cache
      const savedJwt = process.env.JWT_SECRET;
      const savedSg = process.env.SENDGRID_API_KEY;
      try {
        delete process.env.JWT_SECRET;
        delete process.env.JWT_SECRET_FILE;
        delete process.env.SENDGRID_API_KEY;
        delete process.env.SENDGRID_API_KEY_FILE;

        expect(resolveSecret('JWT_SECRET', process.env)).toBe('z'.repeat(48));
        expect(resolveSecret('SENDGRID_API_KEY', process.env)).toBe('SG.test-key');
      } finally {
        if (savedJwt !== undefined) process.env.JWT_SECRET = savedJwt;
        if (savedSg !== undefined) process.env.SENDGRID_API_KEY = savedSg;
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('redactConfig redacts both sensitive keys and their *_FILE counterparts', () => {
    for (const key of SENSITIVE_CONFIG_KEYS) {
      expect(shouldRedact(key)).toBe(true);
      expect(shouldRedact(`${key}_FILE`)).toBe(true);
    }

    const sample = {
      PORT: 5000,
      STELLAR_NETWORK: 'testnet',
      JWT_SECRET: 'super-secret',
      JWT_SECRET_FILE: '/run/secrets/jwt_secret',
      ANCHOR_PLATFORM_KEYPAIR: 'S12345',
      ANCHOR_PLATFORM_KEYPAIR_FILE: '/run/secrets/anchor_keypair',
      MONGO_URI_FILE: '/run/secrets/mongo_uri',
    };

    const redacted = redactConfig(sample);
    expect(redacted.PORT).toBe(5000);
    expect(redacted.STELLAR_NETWORK).toBe('testnet');
    expect(redacted.JWT_SECRET).toBe('[REDACTED]');
    expect(redacted.JWT_SECRET_FILE).toBe('[REDACTED]');
    expect(redacted.ANCHOR_PLATFORM_KEYPAIR).toBe('[REDACTED]');
    expect(redacted.ANCHOR_PLATFORM_KEYPAIR_FILE).toBe('[REDACTED]');
    expect(redacted.MONGO_URI_FILE).toBe('[REDACTED]');
  });
});
