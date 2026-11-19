'use strict';

/**
 * Module integrity guard (#1918, #1919, #1920).
 *
 * The backend failed to boot because files were truncated by bad merges, one
 * file was declared twice, and some modules were required but never committed.
 * These checks fail by name when a file no longer compiles, when a relative
 * require points at nothing, or when app.js mounts a router twice.
 *
 * KNOWN_UNRESOLVED lists requires that already pointed at missing files when
 * this guard was added. It is a debt list, not a waiver: remove an entry when
 * its module is restored, and any new unresolved require fails this test.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

const KNOWN_UNRESOLVED = new Set([
  'routes/webhookEndpointRoutes.js -> ../middleware/resolveSchool',
  'services/sessionStore.js -> ./authController',
  'services/paymentService.js -> ../config/stellar',
  'services/consistencyScheduler.js -> ./scheduledJob',
  'services/metricsRollupService.js -> ../utils/metrics',
  'services/stuckPaymentReconciliation.js -> ../utils/scheduledJob',
  'services/__tests__/transactionPollingService.test.js -> ../fiatSnapshotService',
  'controllers/schoolController.js -> ../services/lockoutService',
  'controllers/schoolController.js -> ../services/mfaService',
  'controllers/webhookEndpointsController.js -> ../middleware/stepUpMiddleware',
  'controllers/userController.js -> ../services/emailTemplateService',
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function resolves(fromFile, request) {
  const target = path.normalize(path.join(path.dirname(fromFile), request));
  return [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')]
    .some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

describe('backend/src module integrity (#1918)', () => {
  const files = walk(SRC);
  const requirePattern = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s compiles', (_name, file) => {
    // new Function parses the body without running it, so this catches truncated
    // or otherwise malformed files without loading their dependencies.
    expect(() => new Function(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('has no relative require that resolves to nothing, beyond the known debt list', () => {
    const unexpected = [];
    const unresolved = new Set();
    for (const file of files) {
      const rel = path.relative(SRC, file);
      for (const match of fs.readFileSync(file, 'utf8').matchAll(requirePattern)) {
        const key = `${rel} -> ${match[1]}`;
        if (resolves(file, match[1])) continue;
        unresolved.add(key);
        if (!KNOWN_UNRESOLVED.has(key)) unexpected.push(key);
      }
    }
    expect(unexpected).toEqual([]);
    // An allowlisted entry that now resolves (or whose require was removed) must leave the list.
    const stale = [...KNOWN_UNRESOLVED].filter((key) => !unresolved.has(key));
    expect(stale).toEqual([]);
  });
});

describe('app.js router mounting (#1919)', () => {
  const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');

  it('declares internalRoutes exactly once', () => {
    expect(app.match(/const internalRoutes = require\('\.\/routes\/internalRoutes'\);/g)).toHaveLength(1);
  });

  it('mounts /api/internal exactly once', () => {
    expect(app.match(/app\.use\('\/api\/internal', internalRoutes\);/g)).toHaveLength(1);
  });
});
