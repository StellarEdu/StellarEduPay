'use strict';

/**
 * #1946 — the school-level MFA API (shared secret + process-wide admin password)
 * is removed, and a migration unsets the stored fields.
 *
 * These checks read the source and generated artefacts directly so they run
 * without booting the app or connecting to MongoDB.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const LEGACY_PATHS = [
  '/api/auth/mfa/setup',
  '/api/auth/mfa/verify',
  '/api/auth/mfa/disable',
  '/api/auth/mfa/backup-codes/regenerate',
];

describe('legacy school-level MFA removal (#1946)', () => {
  it('does not mount the legacy routes', () => {
    const routes = read('backend/src/routes/authRoutes.js');
    for (const p of LEGACY_PATHS) {
      expect(routes).not.toContain(`'${p.replace('/api/auth', '')}'`);
    }
    expect(routes).not.toMatch(/router\.post\('\/mfa\/(setup|verify|disable)'/);
    expect(routes).not.toMatch(/router\.post\([^)]*backup-codes/);
  });

  it('removes the SCHOOL_ADMIN_PASSWORD code path', () => {
    const controller = read('backend/src/controllers/mfaController.js');
    expect(controller).not.toMatch(/SCHOOL_ADMIN_PASSWORD/);
    expect(controller).not.toMatch(/async function (setupMfa|verifyAndEnableMfa|disableMfa|regenerateBackupCodes)\b/);
  });

  it('no longer defines school-level MFA fields on the School schema', () => {
    const model = read('backend/src/models/schoolModel.js');
    expect(model).not.toMatch(/mfaEnabled:\s*\{ type: Boolean/);
    expect(model).not.toMatch(/mfaSecret:\s*\{ type: String/);
    expect(model).not.toMatch(/mfaBackupCodes:\s*\[/);
    // The policy flag stays.
    expect(model).toMatch(/requireMfa:\s*\{ type: Boolean, default: false \}/);
  });

  it('ships a migration that unsets the legacy school fields, with a version export', () => {
    const migration = require(path.join(REPO, 'backend/migrations/037_remove_school_legacy_mfa_fields.js'));
    expect(migration.version).toBe('037_remove_school_legacy_mfa_fields');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');

    const source = read('backend/migrations/037_remove_school_legacy_mfa_fields.js');
    expect(source).toMatch(/'mfaSecret'/);
    expect(source).toMatch(/'mfaBackupCodes'/);
    expect(source).toMatch(/'mfaEnabled'/);
    expect(source).toMatch(/\$unset/);
  });

  it('migration up() unsets only the legacy fields on schools', async () => {
    const migration = require(path.join(REPO, 'backend/migrations/037_remove_school_legacy_mfa_fields.js'));
    const calls = [];
    const db = {
      collection: (name) => ({
        updateMany: async (filter, update) => {
          calls.push({ name, filter, update });
          return { modifiedCount: 2 };
        },
      }),
    };
    const result = await migration.up(db);
    expect(result).toEqual({ schoolsUpdated: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('schools');
    expect(Object.keys(calls[0].update.$unset).sort()).toEqual(['mfaBackupCodes', 'mfaEnabled', 'mfaSecret']);
  });

  it('removes the legacy paths from the OpenAPI spec and the route manifest', () => {
    const openapi = JSON.parse(read('backend/openapi.json'));
    const manifest = JSON.parse(read('routes.json'));
    const manifestPaths = manifest.routes.map((r) => r.path);
    for (const p of LEGACY_PATHS) {
      expect(Object.keys(openapi.paths)).not.toContain(p);
      expect(manifestPaths).not.toContain(p);
    }
    // The per-user endpoints remain.
    expect(manifestPaths).toContain('/api/auth/mfa/user/verify');
  });
});
