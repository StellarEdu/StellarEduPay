'use strict';

/**
 * Tests for JWT_SECRET startup validation (#342, #1282).
 *
 * config/index.js must:
 *  - throw when JWT_SECRET is absent (in all environments)
 *  - throw when JWT_SECRET is too short (<32 chars)
 *  - pass silently when JWT_SECRET is present and valid (32+ chars)
 */

function loadConfig(env = {}) {
  // Isolate module so each call gets a fresh evaluation
  jest.resetModules();
  const saved = { ...process.env };
  // Minimal required vars
  process.env.MONGO_URI = 'mongodb://localhost/test';
  Object.assign(process.env, env);
  try {
    return require('../backend/src/config/index');
  } finally {
    // Restore original env
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, saved);
  }
}

describe('JWT_SECRET startup validation', () => {
  it('throws when JWT_SECRET is missing (all environments)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production' })
    ).toThrow(/Missing required environment variables.*JWT_SECRET/);

    jest.resetModules();
    expect(() =>
      loadConfig({ NODE_ENV: 'development' })
    ).toThrow(/Missing required environment variables.*JWT_SECRET/);
  });

  it('throws when JWT_SECRET is too short (<32 chars)', () => {
    expect(() =>
      loadConfig({ JWT_SECRET: 'short-secret' })
    ).toThrow(/JWT_SECRET is too short/);
  });

  it('passes silently when JWT_SECRET is valid (32+ chars)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      loadConfig({ JWT_SECRET: 'a-sufficiently-long-secret-value-1234567890' })
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
