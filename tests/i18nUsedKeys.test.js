'use strict';

/**
 * Issue #1794 — every literal translation key referenced in frontend source
 * must exist in en.js (directly or as an i18next plural form). Otherwise the
 * UI renders the raw key path, e.g. "analytics.subtitle".
 *
 * Dynamic keys such as `analytics.period.${p}` are skipped because their value
 * is only known at runtime.
 */

const fs = require('fs');
const path = require('path');
const { loadLocales } = require('../scripts/check-i18n-coverage');

const SRC_DIR = path.join(__dirname, '..', 'frontend', 'src');
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
// Matches t("key"), t('key'), t(`key`) — but not template literals with ${}.
const T_CALL = /\bt\(\s*(["'`])([A-Za-z0-9_.]+)\1/g;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, files);
    } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function referencedKeys() {
  const refs = new Map();
  for (const file of walk(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(T_CALL)) {
      const key = match[2];
      if (!refs.has(key)) refs.set(key, path.relative(SRC_DIR, file));
    }
  }
  return refs;
}

function isDefined(enFlat, key) {
  return key in enFlat || PLURAL_SUFFIXES.some((suffix) => `${key}${suffix}` in enFlat);
}

describe('translation keys referenced by the frontend (#1794)', () => {
  it('are all defined in en.js', () => {
    const { en: enFlat } = loadLocales();
    const undefinedKeys = [...referencedKeys()]
      .filter(([key]) => !isDefined(enFlat, key))
      .map(([key, file]) => `${key} (${file})`);

    expect(undefinedKeys).toEqual([]);
  });
});
