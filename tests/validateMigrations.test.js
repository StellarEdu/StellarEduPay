const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateMigrations } = require('../scripts/validate-migrations.js');

describe('validateMigrations', () => {
  it('fails when forbidden migrate-* scripts exist in the repo scripts directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-migrations-'));

    const backendDir = path.join(tmpDir, 'backend');
    const scriptsDir = path.join(tmpDir, 'scripts');
    const migrationsDir = path.join(backendDir, 'migrations');

    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, '001_example.js'), 'module.exports = { version: "001_example", up: async () => {} };\n');
    fs.writeFileSync(path.join(scriptsDir, 'migrate.js'), "#!/usr/bin/env node\nmodule.exports = true;\n");
    fs.writeFileSync(path.join(scriptsDir, 'migrate-payment-index.js'), "#!/usr/bin/env node\nconsole.log('bad');\n");

    expect(() => validateMigrations({ repoRoot: tmpDir })).toThrow(/migrate-payment-index\.js/);
  });
});
