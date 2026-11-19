'use strict';

// Issue #1829 — every secret can be supplied as a `<NAME>_FILE` path.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SECRET_ENV_KEYS,
  resolveFileSecrets,
  _resetForTests,
} = require('../backend/src/config/secrets');
const { redactConfig, isSecretFileRef } = require('../backend/src/utils/redactConfig');

const fakeReader = (files) => (p) => {
  if (!(p in files)) {
    const err = new Error(`ENOENT: no such file ${p}`);
    err.code = 'ENOENT';
    throw err;
  }
  return files[p];
};

describe('resolveFileSecrets', () => {
  beforeEach(() => _resetForTests());

  test('covers every secret named in the issue', () => {
    for (const key of [
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
    ]) {
      expect(SECRET_ENV_KEYS).toContain(key);
    }
  });

  test('populates the env var from the file, trimming a trailing newline', () => {
    const env = { JWT_SECRET_FILE: '/run/secrets/jwt' };
    const populated = resolveFileSecrets(env, fakeReader({ '/run/secrets/jwt': 'abc-secret\n' }));
    expect(env.JWT_SECRET).toBe('abc-secret');
    expect(populated).toEqual(['JWT_SECRET']);
  });

  test('accepts CRLF line endings', () => {
    const env = { SMTP_PASS_FILE: '/s/pass' };
    resolveFileSecrets(env, fakeReader({ '/s/pass': 'p@ss\r\n' }));
    expect(env.SMTP_PASS).toBe('p@ss');
  });

  test('refuses when both NAME and NAME_FILE are set', () => {
    const env = { JWT_SECRET: 'from-env', JWT_SECRET_FILE: '/run/secrets/jwt' };
    expect(() =>
      resolveFileSecrets(env, fakeReader({ '/run/secrets/jwt': 'from-file' })),
    ).toThrow(/Both JWT_SECRET and JWT_SECRET_FILE are set/);
  });

  test('fails closed on an empty file', () => {
    const env = { REDIS_PASSWORD_FILE: '/s/redis' };
    expect(() => resolveFileSecrets(env, fakeReader({ '/s/redis': '\n' }))).toThrow(
      /REDIS_PASSWORD_FILE points to an empty file/,
    );
  });

  test('fails closed on an unreadable file without leaking the path contents', () => {
    const env = { MONGO_URI_FILE: '/missing' };
    expect(() => resolveFileSecrets(env, fakeReader({}))).toThrow(
      /MONGO_URI_FILE could not be read \(ENOENT\)/,
    );
    expect(env.MONGO_URI).toBeUndefined();
  });

  test('ignores unrelated *_FILE variables and empty references', () => {
    const env = { SOME_OTHER_FILE: '/x', JWT_SECRET_FILE: '' };
    const populated = resolveFileSecrets(env, fakeReader({}));
    expect(populated).toEqual([]);
    expect(env.JWT_SECRET).toBeUndefined();
  });

  test('reads a real file from disk end to end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
    try {
      const file = path.join(dir, 'jwt');
      fs.writeFileSync(file, 'x'.repeat(40) + '\n');
      const env = { JWT_SECRET_FILE: file };
      resolveFileSecrets(env);
      expect(env.JWT_SECRET).toBe('x'.repeat(40));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('process.env resolution is idempotent', () => {
    const before = process.env.AUDIT_HMAC_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-once-'));
    const file = path.join(dir, 'hmac');
    fs.writeFileSync(file, 'hmac-value\n');
    process.env.AUDIT_HMAC_KEY_FILE = file;
    delete process.env.AUDIT_HMAC_KEY;
    try {
      expect(resolveFileSecrets().includes('AUDIT_HMAC_KEY')).toBe(true);
      expect(process.env.AUDIT_HMAC_KEY).toBe('hmac-value');
      // Second call must not throw "both set" because the first call populated NAME.
      expect(resolveFileSecrets()).toEqual([]);
    } finally {
      delete process.env.AUDIT_HMAC_KEY_FILE;
      if (before === undefined) delete process.env.AUDIT_HMAC_KEY;
      else process.env.AUDIT_HMAC_KEY = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('redaction of *_FILE references', () => {
  test('isSecretFileRef matches only known secret names', () => {
    expect(isSecretFileRef('JWT_SECRET_FILE')).toBe(true);
    expect(isSecretFileRef('MONGO_URI_FILE')).toBe(true);
    expect(isSecretFileRef('SOME_OTHER_FILE')).toBe(false);
    expect(isSecretFileRef('JWT_SECRET')).toBe(false);
  });

  test('redactConfig hides secret file paths and keeps ordinary values', () => {
    const out = redactConfig({
      JWT_SECRET_FILE: '/run/secrets/jwt',
      PORT: 5000,
      SMTP_HOST: 'smtp.example.com',
    });
    expect(out.JWT_SECRET_FILE).toBe('[REDACTED]');
    expect(out.PORT).toBe(5000);
    expect(out.SMTP_HOST).toBe('smtp.example.com');
  });
});
