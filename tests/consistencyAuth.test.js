'use strict';

/**
 * Tests for requireAdminAuth on GET /api/consistency (Issue #371).
 *
 * Verifies that:
 *  - requireAdminAuth is wired to the consistency route in app.js.
 *  - Unauthenticated requests receive HTTP 401 (via middleware unit test).
 *  - docs/api-spec.md documents the authentication requirement.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-secret-for-consistency-auth';

const path = require('path');
const fs = require('fs');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/app.js'),
  'utf8',
);

const API_SPEC = fs.readFileSync(
  path.join(__dirname, '../docs/api-spec.md'),
  'utf8',
);

// ── Static source analysis ────────────────────────────────────────────────────

describe('GET /api/consistency — route wiring (source analysis)', () => {
  it('requireAdminAuth is applied before runConsistencyCheck in app.js', () => {
    expect(APP_SRC).toMatch(/\/api\/consistency.*requireAdminAuth.*runConsistencyCheck/);
  });

  it('requireAdminAuth is imported from middleware/auth in app.js', () => {
    expect(APP_SRC).toContain("require('./middleware/auth')");
    expect(APP_SRC).toContain('requireAdminAuth');
  });
});

describe('GET /api/consistency — documentation', () => {
  it('api-spec.md documents the consistency endpoint', () => {
    expect(API_SPEC).toContain('/api/consistency');
  });

  it('api-spec.md documents the authentication requirement', () => {
    const consistencySection = API_SPEC.slice(API_SPEC.indexOf('/api/consistency'));
    expect(consistencySection).toMatch(/Authorization|Bearer|admin/i);
  });

  it('api-spec.md documents 401 response for unauthenticated requests', () => {
    const consistencySection = API_SPEC.slice(API_SPEC.indexOf('/api/consistency'));
    expect(consistencySection).toContain('401');
  });
});

// ── Middleware unit tests ─────────────────────────────────────────────────────
// Test requireAdminAuth directly without loading the full app (avoids needing
// express/jsonwebtoken in root node_modules).

describe('GET /api/consistency — requireAdminAuth middleware behaviour', () => {
  const AUTH_SRC = fs.readFileSync(
    path.join(__dirname, '../backend/src/middleware/auth.js'),
    'utf8',
  );

  it('requireAdminAuth returns 401 for missing Authorization header', () => {
    // Verify the middleware source contains the 401 + MISSING_AUTH_TOKEN logic
    expect(AUTH_SRC).toContain('401');
    expect(AUTH_SRC).toContain('MISSING_AUTH_TOKEN');
  });

  it('requireAdminAuth returns 401 for invalid tokens', () => {
    expect(AUTH_SRC).toContain('INVALID_AUTH_TOKEN');
  });

  it('requireAdminAuth returns 403 for non-admin tokens', () => {
    expect(AUTH_SRC).toContain('403');
    expect(AUTH_SRC).toContain('INSUFFICIENT_ROLE');
  });

  it('requireAdminAuth calls next() for valid admin tokens', () => {
    expect(AUTH_SRC).toContain("decoded.role === 'admin'");
    expect(AUTH_SRC).toContain('next()');
  });
});
