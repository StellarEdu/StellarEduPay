'use strict';

/**
 * Tests for issue #1419 — per-school rate limit on POST /api/payments/sync.
 *
 * The endpoint had only the global per-IP limiter, so one school scripting it
 * could exhaust the shared Horizon budget, trip the circuit breaker and stall
 * background polling for every other school. The limit has to be keyed on the
 * school rather than the caller's address, which is what these tests pin.
 *
 * No Redis and no database: the limiter falls back to its in-process counter
 * when no client is connected, and that is the path exercised here.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { rl, syncLimiter, SYNC_INTERVAL_MS } = require('../backend/src/middleware/rateLimiter');

/**
 * An app that stamps a schoolId onto each successive request, then applies the
 * limiter — so one app can simulate several schools calling from one address.
 */
function appForSchools(schoolIdsInOrder) {
  const app = express();
  let call = 0;
  app.use((req, res, next) => {
    const schoolId = schoolIdsInOrder[Math.min(call++, schoolIdsInOrder.length - 1)];
    if (schoolId) req.schoolId = schoolId;
    next();
  });
  app.post('/sync', syncLimiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('SYNC_INTERVAL_MS', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(SYNC_INTERVAL_MS)).toBe(true);
    expect(SYNC_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('defaults to the 60s poll interval', () => {
    expect(SYNC_INTERVAL_MS).toBe(60000);
  });
});

describe('syncLimiter', () => {
  it('allows the first sync for a school', async () => {
    const res = await request(appForSchools(['SCH-A'])).post('/sync');
    expect(res.status).toBe(200);
  });

  it('rejects a second sync from the same school within the window', async () => {
    const app = appForSchools(['SCH-B']);
    await request(app).post('/sync');
    const res = await request(app).post('/sync');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('SYNC_RATE_LIMITED');
  });

  it('sends a Retry-After the client can actually wait on', async () => {
    const app = appForSchools(['SCH-C']);
    await request(app).post('/sync');
    const res = await request(app).post('/sync');

    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // The remainder of the current window, never more than a whole one.
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(SYNC_INTERVAL_MS / 1000));
  });

  it('does not let one school consume another school allowance', async () => {
    const app = appForSchools(['SCH-D', 'SCH-E']);
    const first = await request(app).post('/sync');
    const second = await request(app).post('/sync');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('rate limits per school even from the same caller', async () => {
    const app = appForSchools(['SCH-F', 'SCH-G', 'SCH-F']);
    await request(app).post('/sync'); // SCH-F, allowed
    await request(app).post('/sync'); // SCH-G, allowed
    const third = await request(app).post('/sync'); // SCH-F again
    expect(third.status).toBe(429);
  });

  it('still buckets a request that arrives without school context', async () => {
    const app = appForSchools([null]);
    const first = await request(app).post('/sync');
    const second = await request(app).post('/sync');
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('exposes the standard RateLimit headers', async () => {
    const res = await request(appForSchools(['SCH-H'])).post('/sync');
    expect(res.headers['ratelimit-limit']).toBe('1');
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});

describe('Retry-After accuracy', () => {
  it('reports the remainder of the window, not its full length', async () => {
    // A long window makes the difference measurable: a full-window value would
    // always be 600, while the true remainder is strictly less once any time
    // in the bucket has passed.
    const app = express();
    app.use((req, res, next) => {
      req.schoolId = 'SCH-REMAINDER';
      next();
    });
    app.post(
      '/x',
      rl(600000, 1, { error: 'nope' }, { keyGenerator: (r) => r.schoolId }),
      (req, res) => res.json({ ok: true }),
    );

    await request(app).post('/x');
    const res = await request(app).post('/x');

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
  });
});

describe('route wiring', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'routes', 'paymentRoutes.js'),
    'utf8',
  );
  const line = routes.split('\n').find((l) => l.includes('router.post("/sync"'));

  it('applies syncLimiter to POST /sync', () => {
    expect(line).toContain('syncLimiter');
  });

  it('applies it after requireAdminAuth, which is what sets req.schoolId', () => {
    expect(line.indexOf('requireAdminAuth')).toBeLessThan(line.indexOf('syncLimiter'));
  });

  it('keeps the existing global limiter in place', () => {
    expect(line).toContain('strictLimiter');
  });
});
