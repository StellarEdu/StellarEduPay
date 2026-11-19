'use strict';

/**
 * #1948 — one password policy for change, set, reset and the admin hash script.
 */

const { validatePasswordPolicy } = require('../src/utils/passwordPolicy');

describe('validatePasswordPolicy (#1948)', () => {
  it('accepts a strong, unrelated passphrase', () => {
    expect(validatePasswordPolicy('correct-horse-battery-staple')).toEqual({ valid: true });
  });

  it('rejects non-string and whitespace-only input with PASSWORD_INVALID', () => {
    expect(validatePasswordPolicy(undefined).code).toBe('PASSWORD_INVALID');
    expect(validatePasswordPolicy(null).code).toBe('PASSWORD_INVALID');
    expect(validatePasswordPolicy(12345678901234).code).toBe('PASSWORD_INVALID');
    expect(validatePasswordPolicy('            ').code).toBe('PASSWORD_INVALID');
  });

  it('requires at least 12 characters', () => {
    const result = validatePasswordPolicy('Sh0rt-pass1');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('PASSWORD_TOO_SHORT');
    expect(result.message).toMatch(/at least 12 characters/);
  });

  it('counts characters, not UTF-16 code units, for the minimum', () => {
    // 11 emoji code points: 22 UTF-16 units but only 11 characters.
    const eleven = '\u{1F600}'.repeat(11);
    expect(validatePasswordPolicy(eleven).code).toBe('PASSWORD_TOO_SHORT');
  });

  it('rejects anything over 72 UTF-8 bytes deterministically', () => {
    const seventyTwoAscii = 'a'.repeat(72);
    const seventyThreeAscii = 'a'.repeat(73);
    expect(validatePasswordPolicy(seventyTwoAscii)).toEqual({ valid: true });
    expect(validatePasswordPolicy(seventyThreeAscii).code).toBe('PASSWORD_TOO_LONG');
  });

  it('counts multi-byte characters by bytes for the maximum', () => {
    // 25 three-byte characters = 75 bytes, which passes the 12-character minimum
    // but must still be rejected because bcrypt would ignore the tail.
    const multiByte = '€'.repeat(25);
    expect(multiByte.length).toBe(25);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBe(75);
    expect(validatePasswordPolicy(multiByte).code).toBe('PASSWORD_TOO_LONG');
  });

  it('rejects passwords containing the email local part', () => {
    const result = validatePasswordPolicy('Jane.Doe-2026-secure', { email: 'jane.doe@school.edu' });
    expect(result.code).toBe('PASSWORD_CONTAINS_IDENTITY');
  });

  it('matches the email local part case-insensitively', () => {
    expect(
      validatePasswordPolicy('My-BURSAR-passphrase', { email: 'bursar@school.edu' }).code
    ).toBe('PASSWORD_CONTAINS_IDENTITY');
  });

  it('ignores identifiers shorter than 4 characters', () => {
    // "jo" is too short to be a meaningful identity check.
    expect(validatePasswordPolicy('xx-jo-long-passphrase', { email: 'jo@school.edu' })).toEqual({ valid: true });
  });

  it('rejects passwords containing the username', () => {
    expect(
      validatePasswordPolicy('Registrar-Office-2026', { username: 'registrar' }).code
    ).toBe('PASSWORD_CONTAINS_IDENTITY');
  });

  it('rejects common passwords, including with trailing digits or symbols', () => {
    expect(validatePasswordPolicy('password1234').code).toBe('PASSWORD_COMMON');
    expect(validatePasswordPolicy('Welcome12345').code).toBe('PASSWORD_COMMON');
    expect(validatePasswordPolicy('qwertyuiop123').code).toBe('PASSWORD_COMMON');
    expect(validatePasswordPolicy('Password2026!!').code).toBe('PASSWORD_COMMON');
  });

  it('does not reject a long password that merely contains a common word', () => {
    expect(validatePasswordPolicy('tulip-river-mountain-42')).toEqual({ valid: true });
  });

  it('checks rules in order: length before identity and common-password checks', () => {
    expect(validatePasswordPolicy('admin', { username: 'admin' }).code).toBe('PASSWORD_TOO_SHORT');
  });
});
