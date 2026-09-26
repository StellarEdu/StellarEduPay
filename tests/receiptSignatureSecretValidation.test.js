'use strict';

/**
 * Tests for RECEIPT_SIGNATURE_SECRET startup validation (#1498).
 *
 * config/index.js must:
 *  - throw when RECEIPT_SIGNATURE_SECRET is absent (in all environments)
 *  - throw when RECEIPT_SIGNATURE_SECRET is too short (<32 chars)
 *  - pass silently when RECEIPT_SIGNATURE_SECRET is present and valid (32+ chars)
 */

function loadConfig(env = {}) {
  // Isolate module so each call gets a fresh evaluation
  jest.resetModules();
  const saved = { ...process.env };
  // Minimal required vars
  process.env.MONGO_URI = 'mongodb://localhost/test';
  process.env.JWT_SECRET = 'a-sufficiently-long-secret-value-1234567890';
  Object.assign(process.env, env);
  try {
    return require('../backend/src/config/index');
  } finally {
    // Restore original env
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, saved);
  }
}

describe('RECEIPT_SIGNATURE_SECRET startup validation', () => {
  it('throws when RECEIPT_SIGNATURE_SECRET is missing (all environments)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production' })
    ).toThrow(/Missing required environment variables.*RECEIPT_SIGNATURE_SECRET/);

    jest.resetModules();
    expect(() =>
      loadConfig({ NODE_ENV: 'development' })
    ).toThrow(/Missing required environment variables.*RECEIPT_SIGNATURE_SECRET/);
  });

  it('throws when RECEIPT_SIGNATURE_SECRET is too short (<32 chars)', () => {
    expect(() =>
      loadConfig({ RECEIPT_SIGNATURE_SECRET: 'short-secret' })
    ).toThrow(/RECEIPT_SIGNATURE_SECRET is too short/);
  });

  it('passes silently when RECEIPT_SIGNATURE_SECRET is valid (32+ chars)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      loadConfig({ RECEIPT_SIGNATURE_SECRET: 'a-sufficiently-long-secret-value-1234567890' })
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
