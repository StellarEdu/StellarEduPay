/**
 * Regression test for issue #1789: a bad merge dropped 23 helpers from
 * services/api.js while seven admin pages still imported them by name. Webpack
 * only warns on missing named imports, so the break surfaced at runtime as
 * "(0, _api.getPayments) is not a function". This scans every page and
 * component for named imports from services/api and asserts each one is a
 * function exported by the module.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

function namedImportsFromApi(source) {
  const re = /import\s*\{([^}]+)\}\s*from\s*["']([./]*services\/api)["']/g;
  const names = [];
  for (const match of source.matchAll(re)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

describe('services/api named imports (#1789)', () => {
  const api = require('../api');
  const files = walk(path.join(SRC, 'pages')).concat(walk(path.join(SRC, 'components')));

  it('finds the pages that import from services/api', () => {
    const importing = files.filter((f) => namedImportsFromApi(fs.readFileSync(f, 'utf8')).length > 0);
    expect(importing.length).toBeGreaterThan(0);
  });

  it.each(files)('every named import in %s is an exported function', (file) => {
    const missing = namedImportsFromApi(fs.readFileSync(file, 'utf8')).filter(
      (name) => typeof api[name] !== 'function'
    );
    expect(missing).toEqual([]);
  });
});
