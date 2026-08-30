'use strict';

/**
 * Tests for issue #1415 — OPTIONS preflight coverage.
 *
 * tests/cors.test.js covers parseAllowedOrigins() only; the word OPTIONS does
 * not appear in it. So nothing checked the response a browser actually needs
 * before sending a PUT, PATCH or DELETE, and a preflight regression would only
 * surface in a browser — never in a curl-based API test.
 *
 * The real cors middleware is mounted here with the exact options from
 * backend/src/app.js, and a source assertion at the bottom fails if those two
 * ever drift apart, so this cannot quietly end up testing a stale copy.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
// cors is a backend dependency; the repo root does not install it.
const cors = require('../backend/node_modules/cors');
const request = require('supertest');

const APP_PATH = path.join(__dirname, '..', 'backend', 'src', 'app.js');

const ALLOWED_ORIGIN = 'https://app.example.com';
const DENIED_ORIGIN = 'https://evil.example.com';

/** The CORS options app.js mounts. Kept in step by the drift test below. */
const CORS_OPTIONS = {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-School-ID', 'Idempotency-Key'],
  credentials: true,
};

/** Non-simple methods: these are the ones a browser preflights. */
const PREFLIGHTED_METHODS = ['PUT', 'PATCH', 'DELETE'];

/** Custom headers the frontend sends, which must be named in the preflight. */
const CUSTOM_HEADERS = ['Idempotency-Key', 'X-School-ID'];

function buildApp() {
  const app = express();
  app.use(cors({ origin: [ALLOWED_ORIGIN], ...CORS_OPTIONS }));
  app.get('/thing', (req, res) => res.json({ ok: true }));
  app.put('/thing', (req, res) => res.json({ ok: true }));
  app.patch('/thing', (req, res) => res.json({ ok: true }));
  app.delete('/thing', (req, res) => res.json({ ok: true }));
  return app;
}

/** Sends a browser-shaped preflight. */
function preflight(app, method, requestHeaders = 'content-type', origin = ALLOWED_ORIGIN) {
  return request(app)
    .options('/thing')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', method)
    .set('Access-Control-Request-Headers', requestHeaders);
}

/** Case-insensitive membership, since header casing is not guaranteed. */
function listIncludes(headerValue, needle) {
  return String(headerValue || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes(needle.toLowerCase());
}

const app = buildApp();

describe.each(PREFLIGHTED_METHODS)('OPTIONS preflight for %s', (method) => {
  it('answers with a success status', async () => {
    const res = await preflight(app, method);
    expect(res.status).toBeLessThan(300);
  });

  it('echoes the allowed origin', async () => {
    const res = await preflight(app, method);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('names the method in Access-Control-Allow-Methods', async () => {
    const res = await preflight(app, method);
    expect(listIncludes(res.headers['access-control-allow-methods'], method)).toBe(true);
  });

  it('allows credentials, which the allowlist exists to make safe', async () => {
    const res = await preflight(app, method);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe.each(CUSTOM_HEADERS)('preflight allows the %s header', (header) => {
  it('names it in Access-Control-Allow-Headers', async () => {
    const res = await preflight(app, 'PATCH', header);
    expect(listIncludes(res.headers['access-control-allow-headers'], header)).toBe(true);
  });

  it('names it for every preflighted method', async () => {
    for (const method of PREFLIGHTED_METHODS) {
      const res = await preflight(app, method, header);
      expect(listIncludes(res.headers['access-control-allow-headers'], header)).toBe(true);
    }
  });
});

describe('preflight and the origin allowlist', () => {
  it('does not grant an origin that is not allowed', async () => {
    const res = await preflight(app, 'PATCH', 'content-type', DENIED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard, which credentials would make unsafe', async () => {
    const res = await preflight(app, 'PATCH');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('allows Content-Type and Authorization alongside the custom headers', async () => {
    const res = await preflight(app, 'PATCH', 'content-type,authorization');
    for (const header of ['Content-Type', 'Authorization']) {
      expect(listIncludes(res.headers['access-control-allow-headers'], header)).toBe(true);
    }
  });

  it('leaves an unlisted request header out of the allow list', async () => {
    const res = await preflight(app, 'PATCH', 'x-not-configured');
    expect(listIncludes(res.headers['access-control-allow-headers'], 'X-Not-Configured')).toBe(
      false,
    );
  });
});

describe('the actual request after a successful preflight', () => {
  it.each(PREFLIGHTED_METHODS)('carries the CORS headers on %s', async (method) => {
    const res = await request(app)[method.toLowerCase()]('/thing').set('Origin', ALLOWED_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('app.js CORS configuration', () => {
  const source = fs.readFileSync(APP_PATH, 'utf8');

  it('allows every method these tests preflight', () => {
    const line = source.split('\n').find((l) => l.includes('methods:'));
    for (const method of [...PREFLIGHTED_METHODS, 'GET', 'POST']) {
      expect(line).toContain(method);
    }
  });

  it('allows every custom header these tests assert on', () => {
    const line = source.split('\n').find((l) => l.includes('allowedHeaders:'));
    for (const header of [...CUSTOM_HEADERS, 'Content-Type', 'Authorization']) {
      expect(line).toContain(header);
    }
  });

  it('enables credentials, so the origin allowlist is load-bearing', () => {
    expect(source).toContain('credentials: true');
  });
});
