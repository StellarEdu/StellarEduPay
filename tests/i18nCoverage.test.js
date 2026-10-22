'use strict';

/**
 * Tests for scripts/check-i18n-coverage.js — issue #1793.
 *
 * Covers the coverage calculation (including i18next plural forms) and the
 * enforcement rules: fr must be complete, other locales may not regress past
 * their recorded baseline.
 */

const path = require('path');
const fs = require('fs');
const {
  flatten,
  computeCoverage,
  checkCoverage,
} = require('../scripts/check-i18n-coverage');

const BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'i18n-coverage-baseline.json'), 'utf8')
);

describe('flatten', () => {
  it('joins nested keys with dots', () => {
    expect(flatten({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' });
  });
});

describe('computeCoverage', () => {
  const locales = {
    en: { 'nav.home': 'Home', 'auth.title': 'Login', 'fees.count_one': '1 fee', 'fees.count_other': '{{count}} fees' },
    partial: { 'nav.home': 'Accueil' },
  };

  it('counts a plural key as covered when any plural form exists', () => {
    const report = computeCoverage({
      ...locales,
      partial: { 'nav.home': 'Accueil', 'fees.count_one': '1 frais', 'fees.count_other': '{{count}} frais' },
    });

    expect(report.partial.covered).toBe(3);
    expect(report.partial.missing).toEqual(['auth.title']);
  });

  it('reports every English key as missing when a locale is empty', () => {
    const report = computeCoverage({ ...locales, empty: {} });

    expect(report.empty.covered).toBe(0);
    expect(report.empty.total).toBe(4);
    expect(report.empty.missing).toEqual(['nav.home', 'auth.title', 'fees.count_one', 'fees.count_other']);
  });
});

describe('checkCoverage', () => {
  const report = (fr, es) => ({
    en: { total: 2, covered: 2, missing: [] },
    fr: { total: 2, covered: 2 - fr.length, missing: fr },
    es: { total: 2, covered: 2 - es.length, missing: es },
  });

  it('passes when fr is complete and es is within its baseline', () => {
    expect(checkCoverage(report([], ['a']), { fr: 0, es: 1 })).toEqual([]);
  });

  it('fails when fr is missing any key, even if it is under baseline', () => {
    const failures = checkCoverage(report(['a'], []), { fr: 1, es: 0 });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/fr must be 100% covered/);
  });

  it('fails when another locale regresses above its baseline', () => {
    const failures = checkCoverage(report([], ['a', 'b']), { fr: 0, es: 1 });

    expect(failures).toEqual(['es is missing 2 keys, above its baseline of 1']);
  });

  it('fails for a locale that has no baseline entry', () => {
    const failures = checkCoverage(report([], []), { fr: 0 });

    expect(failures).toEqual(['es has no entry in scripts/i18n-coverage-baseline.json']);
  });
});

describe('repository locales', () => {
  it('pass the coverage check against the committed baseline', () => {
    const { loadLocales } = require('../scripts/check-i18n-coverage');
    const current = computeCoverage(loadLocales());

    expect(checkCoverage(current, BASELINE)).toEqual([]);
  });
});
