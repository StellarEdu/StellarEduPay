'use strict';

/**
 * Tests for body size limit enforcement (Issue: oversized JSON payload DoS).
 *
 * Verifies that:
 *  1. MAX_BODY_SIZE is exported from config with the correct default.
 *  2. app.js applies express.json({ limit: config.MAX_BODY_SIZE }) globally.
 *  3. The bulk import route applies a 1mb override before the handler.
 *  4. MAX_BODY_SIZE is documented in .env.example.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';

const fs = require('fs');
const path = require('path');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/app.js'),
  'utf8'
);

const STUDENT_ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/routes/studentRoutes.js'),
  'utf8'
);

const ENV_EXAMPLE = fs.readFileSync(
  path.join(__dirname, '../backend/.env.example'),
  'utf8'
);

describe('Body size limit — configuration', () => {
  it('config exports MAX_BODY_SIZE with default 10kb', () => {
    // Temporarily clear any override so we get the default
    const saved = process.env.MAX_BODY_SIZE;
    delete process.env.MAX_BODY_SIZE;
    // Re-require with a fresh module registry to pick up the cleared env var
    jest.resetModules();
    const config = require('../backend/src/config');
    expect(config.MAX_BODY_SIZE).toBe('10kb');
    // Restore
    if (saved !== undefined) process.env.MAX_BODY_SIZE = saved;
    jest.resetModules();
  });

  it('config respects MAX_BODY_SIZE env var override', () => {
    const saved = process.env.MAX_BODY_SIZE;
    process.env.MAX_BODY_SIZE = '50kb';
    jest.resetModules();
    const config = require('../backend/src/config');
    expect(config.MAX_BODY_SIZE).toBe('50kb');
    if (saved !== undefined) process.env.MAX_BODY_SIZE = saved;
    else delete process.env.MAX_BODY_SIZE;
    jest.resetModules();
  });
});

describe('Body size limit — app.js middleware', () => {
  it('applies express.json with config.MAX_BODY_SIZE as the global limit', () => {
    expect(APP_SRC).toMatch(/express\.json\(\s*\{[\s\S]*?limit\s*:\s*config\.MAX_BODY_SIZE/);
  });

  it('does not use express.json() without a limit option globally', () => {
    // The bare express.json() call (no options) must not appear
    expect(APP_SRC).not.toMatch(/express\.json\(\s*\)/);
  });
});

describe('Body size limit — bulk import route override', () => {
  it('bulk import route applies a 1mb express.json override', () => {
    expect(STUDENT_ROUTES_SRC).toMatch(/express\.json\(\s*\{\s*limit\s*:\s*['"]1mb['"]\s*\}\s*\)/);
  });

  it('bulk import route places the json override before the handler', () => {
    const bulkLine = STUDENT_ROUTES_SRC
      .split('\n')
      .find((line) => line.includes("'/bulk'") || line.includes('"/bulk"'));
    expect(bulkLine).toBeDefined();
    // The 1mb override must appear before bulkImportStudents in the same route definition
    const overrideIdx = bulkLine.indexOf('1mb');
    const handlerIdx = bulkLine.indexOf('bulkImportStudents');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(handlerIdx).toBeGreaterThan(overrideIdx);
  });
});

describe('Body size limit — documentation', () => {
  it('MAX_BODY_SIZE is documented in .env.example', () => {
    expect(ENV_EXAMPLE).toContain('MAX_BODY_SIZE');
  });

  it('.env.example documents the 413 behaviour', () => {
    expect(ENV_EXAMPLE).toContain('413');
  });
});
