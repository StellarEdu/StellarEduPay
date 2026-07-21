'use strict';

/**
 * Tests for JWT_SECRET startup validation (#342).
 *
 * config/index.js must:
 *  - throw (exit-equivalent) in production when JWT_SECRET is absent
 *  - log a warning in non-production when JWT_SECRET is absent
 *  - pass silently when JWT_SECRET is present
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
  it('throws in production when JWT_SECRET is missing', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: '' })
    ).toThrow(/JWT_SECRET is not set/);
  });

  it('logs a warning in development when JWT_SECRET is missing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({ NODE_ENV: 'development', JWT_SECRET: '' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('JWT_SECRET is not set')
    );
    warnSpy.mockRestore();
  });

  it('passes silently when JWT_SECRET is present', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Must be at least the 32-char minimum, otherwise config throws in production.
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'a-sufficiently-long-secret-value-1234567890' })
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
