'use strict';

/**
 * #1635 — every router must be reachable and loadable.
 *
 * Unmounted / misrouted routers have shipped before because nothing failed
 * when a route file was never wired into app.js. This suite fails when:
 *   - a new file in backend/src/routes is not required by app.js (or by
 *     another router), unless it is listed in KNOWN_UNMOUNTED below;
 *   - a router throws at require time (e.g. an un-imported middleware);
 *   - a router registers no routes at all.
 *
 * KNOWN_UNMOUNTED is a ratchet: entries may only be removed (by mounting the
 * router or deleting the file), never added.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef';

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '../backend/src/routes');
const SRC_DIR = path.join(__dirname, '../backend/src');

const KNOWN_UNMOUNTED = new Set([
  'internalRoutes',
  'publicConfigRoutes',
  'retryQueueRoutes',
  'students',
]);

const routeNames = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.basename(f, '.js'));

function allSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : allSourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const sources = allSourceFiles(SRC_DIR).map((f) => fs.readFileSync(f, 'utf8'));

function isRequired(name) {
  const needle = new RegExp(`require\\(['"]\\.{1,2}/(?:routes/)?${name}['"]\\)`);
  return sources.some((src) => needle.test(src));
}

describe('router inventory (#1635)', () => {
  test.each(routeNames.filter((n) => !KNOWN_UNMOUNTED.has(n)))('%s is required by the app', (name) => {
    expect(isRequired(name)).toBe(true);
  });

  test('KNOWN_UNMOUNTED only lists routers that are still unmounted', () => {
    const nowMounted = [...KNOWN_UNMOUNTED].filter((n) => !routeNames.includes(n) || isRequired(n));
    expect(nowMounted).toEqual([]);
  });

  test.each(routeNames.filter((n) => !KNOWN_UNMOUNTED.has(n)))('%s loads and registers routes', (name) => {
    let router;
    jest.isolateModules(() => {
      router = require(path.join(ROUTES_DIR, name));
    });
    const handle = router && (router.router || router.default || router);
    expect(typeof handle).toBe('function');
    expect(Array.isArray(handle.stack)).toBe(true);
    expect(handle.stack.length).toBeGreaterThan(0);
  });
});
