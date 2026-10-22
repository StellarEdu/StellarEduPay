const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateMigrations } = require('../scripts/validate-migrations.js');

// Helper: create a minimal temp repo with a migrations dir and a scripts dir.
function makeTempRepo(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-migrations-'));

  const backendDir = path.join(tmpDir, 'backend');
  const scriptsDir = path.join(tmpDir, 'scripts');
  const migrationsDir = path.join(backendDir, 'migrations');

  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  // A well-formed migration with proper version export
  const defaultContent = opts.defaultContent ||
    'module.exports = { version: "001_example", up: async () => {}, down: async () => {} };\n';
  fs.writeFileSync(path.join(migrationsDir, '001_example.js'), defaultContent);

  fs.writeFileSync(
    path.join(scriptsDir, 'migrate.js'),
    "#!/usr/bin/env node\nmodule.exports = true;\n"
  );

  return { tmpDir, migrationsDir, scriptsDir };
}

describe('validateMigrations', () => {
  it('fails when forbidden migrate-* scripts exist in the repo scripts directory', () => {
    const { tmpDir, scriptsDir } = makeTempRepo();
    fs.writeFileSync(
      path.join(scriptsDir, 'migrate-payment-index.js'),
      "#!/usr/bin/env node\nconsole.log('bad');\n"
    );

    expect(() => validateMigrations({ repoRoot: tmpDir })).toThrow(/migrate-payment-index\.js/);
  });

  // ── Export-contract tests ────────────────────────────────────────────────

  it('passes when every migration exports version === basename', () => {
    const { tmpDir } = makeTempRepo();
    expect(() => validateMigrations({ repoRoot: tmpDir })).not.toThrow();
  });

  it('fails when a migration exports no version field', () => {
    const { tmpDir, migrationsDir } = makeTempRepo({
      defaultContent: 'module.exports = { up: async () => {}, down: async () => {} };\n',
    });

    expect(() => validateMigrations({ repoRoot: tmpDir })).toThrow(/missing or empty.*version/i);
  });

  it('fails when a migration exports an empty string version', () => {
    const { tmpDir, migrationsDir } = makeTempRepo({
      defaultContent: 'module.exports = { version: "", up: async () => {}, down: async () => {} };\n',
    });

    expect(() => validateMigrations({ repoRoot: tmpDir })).toThrow(/missing or empty.*version/i);
  });

  it('fails when version does not match the filename', () => {
    const { tmpDir, migrationsDir } = makeTempRepo({
      defaultContent: 'module.exports = { version: "999_wrong_name", up: async () => {}, down: async () => {} };\n',
    });

    expect(() => validateMigrations({ repoRoot: tmpDir })).toThrow(/version mismatch/i);
  });

  it('reports both the exported value and the expected value on a mismatch', () => {
    const { tmpDir, migrationsDir } = makeTempRepo({
      defaultContent: 'module.exports = { version: "999_wrong_name", up: async () => {}, down: async () => {} };\n',
    });

    let msg = '';
    try {
      validateMigrations({ repoRoot: tmpDir });
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toMatch(/999_wrong_name/);
    expect(msg).toMatch(/001_example/);
  });

  it('flags every non-conforming file, not just the first one', () => {
    const { tmpDir, migrationsDir } = makeTempRepo({
      defaultContent: 'module.exports = { up: async () => {}, down: async () => {} };\n', // no version
    });

    // Add a second non-conforming migration.
    fs.writeFileSync(
      path.join(migrationsDir, '002_another.js'),
      'module.exports = { up: async () => {}, down: async () => {} };\n'
    );

    let msg = '';
    try {
      validateMigrations({ repoRoot: tmpDir });
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toMatch(/001_example/);
    expect(msg).toMatch(/002_another/);
  });
});

