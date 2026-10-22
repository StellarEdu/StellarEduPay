#!/usr/bin/env node
'use strict';

/**
 * Issue #1793 — report and enforce frontend translation coverage.
 *
 * Compares every locale in frontend/src/i18n/locales against en.js, counting a
 * key as covered when it exists directly or as an i18next plural form
 * (`key_one`, `key_other`, ...).
 *
 * Rules:
 *  - fr must stay at 100% coverage.
 *  - Any other locale may not have more missing keys than its entry in
 *    scripts/i18n-coverage-baseline.json. Raise the baseline only when adding
 *    new English strings is intended, and lower it as translations land.
 *
 * Locale files are ES modules (`export default`), so they are evaluated here in
 * a sandbox rather than imported, which keeps this script free of build tooling.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'frontend', 'src', 'i18n', 'locales');
const BASELINE_PATH = path.join(__dirname, 'i18n-coverage-baseline.json');
const REQUIRED_FULL_COVERAGE = ['fr'];
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, keyPath, out);
    } else {
      out[keyPath] = value;
    }
  }
  return out;
}

function hasKey(flat, key) {
  if (key in flat) return true;
  return PLURAL_SUFFIXES.some((suffix) => `${key}${suffix}` in flat);
}

function loadLocale(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const commonJs = source.replace(/export\s+default\s+/, 'module.exports = ');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(commonJs, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

function loadLocales(dir = LOCALES_DIR) {
  const locales = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    locales[path.basename(file, '.js')] = flatten(loadLocale(path.join(dir, file)));
  }
  return locales;
}

/**
 * @param {Record<string, Record<string, unknown>>} locales flattened locales keyed by code
 * @returns {Record<string, { total: number, covered: number, missing: string[] }>}
 */
function computeCoverage(locales) {
  const reference = locales.en;
  const referenceKeys = Object.keys(reference);
  const report = {};
  for (const [code, flat] of Object.entries(locales)) {
    const missing = referenceKeys.filter((key) => !hasKey(flat, key));
    report[code] = {
      total: referenceKeys.length,
      covered: referenceKeys.length - missing.length,
      missing,
    };
  }
  return report;
}

/**
 * @returns {string[]} human-readable failures; empty when coverage passes
 */
function checkCoverage(report, baseline) {
  const failures = [];
  for (const [code, entry] of Object.entries(report)) {
    if (code === 'en') continue;
    if (REQUIRED_FULL_COVERAGE.includes(code) && entry.missing.length > 0) {
      failures.push(`${code} must be 100% covered but is missing ${entry.missing.length} keys (e.g. ${entry.missing[0]})`);
      continue;
    }
    const allowed = baseline[code];
    if (allowed === undefined) {
      failures.push(`${code} has no entry in scripts/i18n-coverage-baseline.json`);
    } else if (entry.missing.length > allowed) {
      failures.push(`${code} is missing ${entry.missing.length} keys, above its baseline of ${allowed}`);
    }
  }
  return failures;
}

function formatReport(report) {
  const lines = ['locale  covered  total  coverage'];
  for (const [code, entry] of Object.entries(report)) {
    const pct = ((entry.covered / entry.total) * 100).toFixed(1);
    lines.push(`${code.padEnd(7)} ${String(entry.covered).padStart(7)}  ${String(entry.total).padStart(5)}  ${pct.padStart(6)}%`);
  }
  return lines.join('\n');
}

function main() {
  const locales = loadLocales();
  const report = computeCoverage(locales);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  console.log(formatReport(report));

  const failures = checkCoverage(report, baseline);
  if (failures.length > 0) {
    console.error('\ni18n coverage check failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\ni18n coverage check passed.');
}

if (require.main === module) {
  main();
}

module.exports = { flatten, loadLocale, loadLocales, computeCoverage, checkCoverage, formatReport };
