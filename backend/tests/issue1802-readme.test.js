'use strict';

/**
 * README accuracy (#1802).
 *
 * Verifies:
 *   1. The CI badge points at this repository, not a personal fork.
 *   2. The Node badge matches the Node version pinned in .nvmrc.
 *   3. Every variable declared in the config schema is documented in the README.
 *
 * The schema is read from source rather than by loading the config module,
 * so this check does not depend on the runtime environment.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const configSource = fs.readFileSync(path.join(repoRoot, 'backend', 'src', 'config', 'index.js'), 'utf8');

// Declared in the schema but never read by any code, so documenting it would
// suggest a setting that has no effect. Remove it from the schema (#1802 follow-up).
const UNREAD_KEYS = ['JWT_EXPIRES_IN'];

// Top-level schema keys are two-space indented and declared as `KEY: Joi.…`.
const schemaKeys = [...configSource.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*Joi\./gm)]
  .map(m => m[1])
  .filter(key => !UNREAD_KEYS.includes(key));

describe('README accuracy (#1802)', () => {
  it('finds the configuration keys in the schema', () => {
    expect(schemaKeys.length).toBeGreaterThan(20);
  });

  it('points the CI badge at StellarEdu/StellarEduPay', () => {
    expect(readme).toContain('github.com/StellarEdu/StellarEduPay/actions/workflows/ci.yml');
    expect(readme).not.toContain('manuelusman73-png');
  });

  it('states the Node version pinned in .nvmrc', () => {
    const nodeVersion = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
    expect(readme).toContain(`node-%3E%3D${nodeVersion}-`);
  });

  it.each(schemaKeys)('documents %s', (key) => {
    expect(readme).toContain(`\`${key}\``);
  });
});
