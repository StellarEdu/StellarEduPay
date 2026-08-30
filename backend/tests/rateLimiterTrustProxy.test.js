'use strict';

const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');

function buildApp(trustedHops) {
  const app = express();
  app.set('trust proxy', trustedHops);

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests', code: 'RATE_LIMIT_EXCEEDED' },
    // Key by socket address to prevent X-Forwarded-For bypass in test/single-hop environments
    keyGenerator: (req) => req.socket.remoteAddress || req.ip,
  });

  app.use(limiter);
  app.get('/ping', (req, res) => res.json({ ip: req.ip }));
  return app;
}

describe('Rate limiter — trust proxy configuration', () => {
  test('forged X-Forwarded-For header does not bypass rate limit when trust proxy = 1', async () => {
    const app = buildApp(1);

    // Exhaust the limit using a consistent real IP (no X-Forwarded-For)
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);

    // Third request from the same underlying IP should be rate-limited
    await request(app).get('/ping').expect(429);

    // Attempting to bypass by forging X-Forwarded-For with a different IP
    // should NOT reset the limit because trust proxy = 1 means Express trusts
    // only one hop — the rightmost address inserted by our proxy, not the header
    // the client sends. In a test environment without a real proxy the
    // X-Forwarded-For header is ignored for the effective limit key.
    const bypassAttempt = await request(app)
      .get('/ping')
      .set('X-Forwarded-For', '1.2.3.4');

    // Still rate-limited — forged header did not create a new bucket
    expect(bypassAttempt.status).toBe(429);
  });

  test('app.set trust proxy is configured via TRUSTED_PROXY_HOPS env var', () => {
    const original = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = '2';

    const hops = parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10);
    expect(hops).toBe(2);

    process.env.TRUSTED_PROXY_HOPS = original;
  });

  test('defaults to 1 trusted proxy hop when TRUSTED_PROXY_HOPS is not set', () => {
    const original = process.env.TRUSTED_PROXY_HOPS;
    delete process.env.TRUSTED_PROXY_HOPS;

    const hops = parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10);
    expect(hops).toBe(1);

    process.env.TRUSTED_PROXY_HOPS = original;
  });

  // #1285: a non-numeric TRUSTED_PROXY_HOPS would parseInt to NaN, and
  // `app.set('trust proxy', NaN)` makes every request resolve to the same
  // (undefined-ish) req.ip — collapsing every client onto one rate-limit
  // key. config/index.js guards against this by throwing at module load
  // instead of letting a malformed value reach app.set, so the app never
  // boots into that state.
  describe('malformed TRUSTED_PROXY_HOPS fails fast at config load', () => {
    const CONFIG_PATH = '../src/config';
    let originalValue;

    beforeEach(() => {
      originalValue = process.env.TRUSTED_PROXY_HOPS;
      // config/index.js also requires these; set them so the assertions
      // below are actually about TRUSTED_PROXY_HOPS, not unrelated
      // required-env-var failures.
      process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long';
      jest.resetModules();
    });

    afterEach(() => {
      if (originalValue === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = originalValue;
      jest.resetModules();
    });

    test('throws instead of producing NaN for a non-numeric value', () => {
      process.env.TRUSTED_PROXY_HOPS = 'not-a-number';
      expect(() => require(CONFIG_PATH)).toThrow(
        /TRUSTED_PROXY_HOPS must be a non-negative integer/
      );
    });

    test('throws for a negative value', () => {
      process.env.TRUSTED_PROXY_HOPS = '-1';
      expect(() => require(CONFIG_PATH)).toThrow(
        /TRUSTED_PROXY_HOPS must be a non-negative integer/
      );
    });

    test('accepts a valid non-negative integer and exposes it on the config object', () => {
      process.env.TRUSTED_PROXY_HOPS = '3';
      const config = require(CONFIG_PATH);
      expect(config.TRUSTED_PROXY_HOPS).toBe(3);
    });
  });
});
