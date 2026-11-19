'use strict';

/**
 * Token lifetime parsing (#1920).
 *
 * utils/ttl.js is the single implementation used by authController, mfaController,
 * tokenService and sessionStore. It must accept seconds and s/m/h/d suffixes,
 * use the default when the variable is unset, and throw on anything else.
 */

const { parseTTL, parseTTLValue } = require('../src/utils/ttl');

describe('parseTTLValue (#1920)', () => {
  it.each([
    ['3600', 3600],
    ['8h', 8 * 3600],
    ['30d', 30 * 86400],
    ['90s', 90],
    ['15m', 900],
    [' 2h ', 7200],
  ])('parses %j as %i seconds', (input, seconds) => {
    expect(parseTTLValue(input)).toBe(seconds);
  });

  it.each(['', 'abc', '1.5h', '-5', '8 h', '8w', '0', '0h', undefined, null])(
    'throws for invalid value %j',
    (input) => {
      expect(() => parseTTLValue(input)).toThrow(/Invalid TTL/);
    },
  );
});

describe('parseTTL (#1920)', () => {
  const ENV = 'TEST_ISSUE_1920_TTL';
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('returns the default when the variable is unset or blank', () => {
    delete process.env[ENV];
    expect(parseTTL(ENV, 28800)).toBe(28800);
    process.env[ENV] = '   ';
    expect(parseTTL(ENV, 28800)).toBe(28800);
  });

  it('reads and converts the configured value', () => {
    process.env[ENV] = '8h';
    expect(parseTTL(ENV, 1)).toBe(28800);
  });

  it('throws naming the variable when the configured value is invalid', () => {
    process.env[ENV] = 'eight-hours';
    expect(() => parseTTL(ENV, 1)).toThrow(`${ENV}: Invalid TTL "eight-hours"`);
  });
});

describe('single parseTTL implementation (#1920)', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src');

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  it('is defined in exactly one module under backend/src', () => {
    const definitions = walk(SRC).filter((file) =>
      /function\s+parseTTL\s*\(|const\s+parseTTL\s*=\s*\(/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(definitions.map((f) => path.relative(SRC, f))).toEqual(['utils/ttl.js']);
  });
});
