'use strict';

/**
 * Regression test for #1932.
 *
 * backend/package.json pointed `main`, `start` and `dev` at src/server.js,
 * which does not exist. The real entrypoint is src/app.js (it self-listens
 * when require.main === module, and the Dockerfile runs `node src/app.js`).
 * This test is dependency-free on purpose: it only reads JSON and checks the
 * filesystem, so it can guard the configuration without booting the app.
 */

const fs = require('fs');
const path = require('path');

const PKG = require('../package.json');
const BACKEND_DIR = path.resolve(__dirname, '..');

describe('backend entrypoint configuration (#1932)', () => {
  const entryScripts = ['main', 'start', 'dev'];

  // Extract a file path from a script command like "node src/app.js".
  function scriptTarget(script) {
    const match = String(script).match(/(?:^|\s)([^\s]+\.js)(?:\s|$)/);
    return match ? match[1] : null;
  }

  it.each(entryScripts)('%s points at an existing file', (key) => {
    const value = key === 'main' ? PKG.main : PKG.scripts[key];
    const target = key === 'main' ? value : scriptTarget(value);

    expect(target).toBeTruthy();
    expect(fs.existsSync(path.resolve(BACKEND_DIR, target))).toBe(true);
  });

  it.each(entryScripts)('%s resolves to src/app.js', (key) => {
    const value = key === 'main' ? PKG.main : PKG.scripts[key];
    const target = key === 'main' ? value : scriptTarget(value);

    expect(path.normalize(target)).toBe(path.normalize('src/app.js'));
  });
});
