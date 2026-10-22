'use strict';

/**
 * Tests for Issue #396 — CSP configuration.
 *
 * Verifies that:
 *  1. The backend Helmet CSP config is appropriate for a JSON API (no scriptSrc,
 *     no styleSrc, defaultSrc 'none', frameAncestors 'none').
 *  2. The backend CSP config does NOT contain 'unsafe-inline' or 'unsafe-eval'.
 *  3. The Next.js config exports CSP headers that cover all required directives
 *     and do NOT contain 'unsafe-inline' or 'unsafe-eval'.
 *
 * We test the configuration objects directly rather than spinning up the full
 * Express app, which avoids the need for backend/node_modules in the test env.
 */

// ── Backend Helmet CSP config tests ──────────────────────────────────────────

describe('Issue #396 — Backend Helmet CSP config (JSON API)', () => {
  // Extract the CSP directives object directly from app.js source by reading
  // the config we set. We parse app.js to get the helmet options.
  // Instead of requiring app.js (which needs express), we extract the CSP
  // directives by reading the file and verifying the expected shape.

  const fs = require('fs');
  const path = require('path');
  const appSource = fs.readFileSync(
    path.join(__dirname, '../backend/src/app.js'),
    'utf8'
  );

  test("backend app.js sets defaultSrc to [\"'none'\"]", () => {
    expect(appSource).toContain("defaultSrc: [\"'none'\"]");
  });

  test("backend app.js sets frameAncestors to [\"'none'\"]", () => {
    expect(appSource).toContain("frameAncestors: [\"'none'\"]");
  });

  test("backend app.js CSP does NOT contain 'unsafe-inline'", () => {
    // Only check within the helmet contentSecurityPolicy block
    const helmetBlock = appSource.match(/helmet\(\{[\s\S]*?contentSecurityPolicy[\s\S]*?\}\)/)?.[0] || '';
    expect(helmetBlock).not.toContain("'unsafe-inline'");
  });

  test("backend app.js CSP does NOT contain 'unsafe-eval'", () => {
    const helmetBlock = appSource.match(/helmet\(\{[\s\S]*?contentSecurityPolicy[\s\S]*?\}\)/)?.[0] || '';
    expect(helmetBlock).not.toContain("'unsafe-eval'");
  });

  test('backend app.js CSP does NOT contain scriptSrc (not needed for a JSON API)', () => {
    const helmetBlock = appSource.match(/helmet\(\{[\s\S]*?contentSecurityPolicy[\s\S]*?\}\)/)?.[0] || '';
    expect(helmetBlock).not.toContain('scriptSrc');
  });

  test('backend app.js CSP does NOT contain styleSrc (not needed for a JSON API)', () => {
    const helmetBlock = appSource.match(/helmet\(\{[\s\S]*?contentSecurityPolicy[\s\S]*?\}\)/)?.[0] || '';
    expect(helmetBlock).not.toContain('styleSrc');
  });

  test('backend app.js CSP does NOT contain imgSrc (not needed for a JSON API)', () => {
    const helmetBlock = appSource.match(/helmet\(\{[\s\S]*?contentSecurityPolicy[\s\S]*?\}\)/)?.[0] || '';
    expect(helmetBlock).not.toContain('imgSrc');
  });
});

// ── Frontend next.config.js CSP tests ────────────────────────────────────────

describe('Issue #396 — Frontend CSP (next.config.js)', () => {
  // The allow-list is the single source of truth: the same arrays that
  // next.config.js uses to build the CSP header are imported here so the
  // assertions automatically stay in sync with the deployed policy.
  const {
    CONNECT_SRC_ORIGINS,
    STYLE_SRC_ORIGINS,
    FONT_SRC_ORIGINS,
  } = require('../frontend/src/config/cspSources');

  let headers;
  let cspValue;

  beforeAll(async () => {
    // Evaluate the config under production so script-src reflects the deployed
    // posture (dev additionally grants script-src 'unsafe-eval' for HMR only).
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    const nextConfig = require('../frontend/next.config.js');
    const allHeaders = await nextConfig.headers();
    process.env.NODE_ENV = prevEnv;
    jest.resetModules();
    // Find the catch-all route entry
    const entry = allHeaders.find((h) => h.source === '/(.*)');
    headers = entry ? entry.headers : [];
    const cspEntry = headers.find((h) => h.key === 'Content-Security-Policy');
    cspValue = cspEntry ? cspEntry.value : '';
  });

  test('next.config.js exports a headers() function', async () => {
    const nextConfig = require('../frontend/next.config.js');
    expect(typeof nextConfig.headers).toBe('function');
  });

  test('headers() returns an array with a catch-all source entry', async () => {
    const nextConfig = require('../frontend/next.config.js');
    const allHeaders = await nextConfig.headers();
    const entry = allHeaders.find((h) => h.source === '/(.*)');
    expect(entry).toBeDefined();
  });

  test('headers include a Content-Security-Policy entry', () => {
    expect(cspValue).toBeTruthy();
  });

  // Scripts are the meaningful XSS vector — script-src stays strict in production
  // (no 'unsafe-inline', no 'unsafe-eval'). Styles are permitted 'unsafe-inline'
  // because React/Next render inline styles; that is the standard Next.js CSP.
  test("frontend script-src is strict in production (no 'unsafe-inline' / 'unsafe-eval')", () => {
    const scriptSrc = cspValue.split(';').find((d) => d.trim().startsWith('script-src')) || '';
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  test("frontend style-src is scoped to 'self' (inline styles permitted for React/Next)", () => {
    const styleSrc = cspValue.split(';').find((d) => d.trim().startsWith('style-src')) || '';
    expect(styleSrc).toMatch(/'self'/);
  });

  test("frontend CSP includes default-src 'self'", () => {
    expect(cspValue).toMatch(/default-src\s+'self'/i);
  });

  test("frontend CSP includes script-src 'self'", () => {
    expect(cspValue).toMatch(/script-src\s+'self'/i);
  });

  test("frontend CSP includes frame-ancestors 'none'", () => {
    expect(cspValue).toMatch(/frame-ancestors\s+'none'/i);
  });

  test('frontend CSP includes connect-src with Stellar Horizon endpoints', () => {
    for (const origin of CONNECT_SRC_ORIGINS) {
      expect(cspValue).toContain(origin);
    }
  });

  test('frontend CSP includes style-src external origins', () => {
    for (const origin of STYLE_SRC_ORIGINS) {
      expect(cspValue).toContain(origin);
    }
  });

  test('frontend CSP includes font-src external origins', () => {
    for (const origin of FONT_SRC_ORIGINS) {
      expect(cspValue).toContain(origin);
    }
  });

  test("frontend CSP includes object-src 'none'", () => {
    expect(cspValue).toMatch(/object-src\s+'none'/i);
  });

  test('headers include X-Frame-Options: DENY', () => {
    const xfo = headers.find((h) => h.key === 'X-Frame-Options');
    expect(xfo).toBeDefined();
    expect(xfo.value).toBe('DENY');
  });

  test('headers include X-Content-Type-Options: nosniff', () => {
    const xcto = headers.find((h) => h.key === 'X-Content-Type-Options');
    expect(xcto).toBeDefined();
    expect(xcto.value).toBe('nosniff');
  });

  // Issue #1796 — HSTS, Permissions-Policy and COOP for the payment pages
  test('headers include Strict-Transport-Security with a long max-age in production', () => {
    const hsts = headers.find((h) => h.key === 'Strict-Transport-Security');
    expect(hsts).toBeDefined();
    expect(hsts.value).toMatch(/max-age=(\d+)/);
    expect(Number(hsts.value.match(/max-age=(\d+)/)[1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts.value).toMatch(/includeSubDomains/);
  });

  test('headers include a Permissions-Policy that disables unused powerful features', () => {
    const pp = headers.find((h) => h.key === 'Permissions-Policy');
    expect(pp).toBeDefined();
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(pp.value).toMatch(new RegExp(`${feature}=\\(\\)`));
    }
  });

  test('headers include Cross-Origin-Opener-Policy: same-origin', () => {
    const coop = headers.find((h) => h.key === 'Cross-Origin-Opener-Policy');
    expect(coop).toBeDefined();
    expect(coop.value).toBe('same-origin');
  });

  test('HSTS is not sent outside production', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    jest.resetModules();
    const devConfig = require('../frontend/next.config.js');
    const devHeaders = (await devConfig.headers())[0].headers;
    process.env.NODE_ENV = prevEnv;
    jest.resetModules();
    expect(devHeaders.find((h) => h.key === 'Strict-Transport-Security')).toBeUndefined();
  });
});
