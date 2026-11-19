'use strict';

/**
 * Issue #1935 — every router file under src/routes/ must be mounted by app.js.
 *
 * An unmounted router (for example the removed routes/students.js) can import
 * handlers that do not exist and can be wired later with the wrong middleware.
 * This static check reads app.js as text, so it runs without booting the app,
 * MongoDB or Redis.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_SRC = path.resolve(__dirname, '../src');
const ROUTES_DIR = path.join(BACKEND_SRC, 'routes');
const APP_FILE = path.join(BACKEND_SRC, 'app.js');

function routerFiles() {
  return fs
    .readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);
}

describe('#1935 routes/ contains only mounted routers', () => {
  const appSource = fs.readFileSync(APP_FILE, 'utf8');

  it('finds router files to check', () => {
    expect(routerFiles().length).toBeGreaterThan(0);
  });

  it.each(routerFiles())('%s is required by app.js', (fileName) => {
    const base = fileName.replace(/\.js$/, '');
    const requirePattern = new RegExp(`require\\(\\s*['"]\\./routes/${base}['"]\\s*\\)`);
    expect(appSource).toMatch(requirePattern);
  });

  it('does not reintroduce the removed unmounted students.js router', () => {
    expect(fs.existsSync(path.join(ROUTES_DIR, 'students.js'))).toBe(false);
  });
});
