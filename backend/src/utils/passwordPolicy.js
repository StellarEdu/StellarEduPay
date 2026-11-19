'use strict';

/**
 * Single password policy shared by every entrypoint that accepts a new
 * password: change-password, set-password (invitation), reset-password and the
 * admin password hashing script.
 *
 * Rules (checked in this order, first failure wins):
 *   1. PASSWORD_INVALID    — not a non-empty string / whitespace only
 *   2. PASSWORD_TOO_SHORT  — fewer than MIN_LENGTH characters (code points)
 *   3. PASSWORD_TOO_LONG   — more than MAX_BYTES UTF-8 bytes. bcrypt only
 *                            hashes the first 72 bytes, so anything beyond that
 *                            would silently add no strength. Rejecting (rather
 *                            than truncating or pre-hashing) keeps behaviour
 *                            explicit and matches what users are told.
 *   4. PASSWORD_CONTAINS_IDENTITY — contains the email local part or the
 *                            username (case-insensitive). Only applied when the
 *                            identifier is at least 4 characters, to avoid
 *                            rejecting passwords over very short local parts.
 *   5. PASSWORD_COMMON     — is, or is a common word followed by digits/symbols
 *                            (e.g. "password2026!"), from COMMON_PASSWORDS.
 *
 * Reuse of the previous password is a stateful check and lives with the caller
 * (it needs the stored hash); see authController.handleChangePassword.
 */

const MIN_LENGTH = 12;
const MAX_BYTES = 72;
const MIN_IDENTITY_LENGTH = 4;

// A curated starter list of frequently used / breached passwords. Entries are
// lowercase. This is intentionally not the full 10k list: it covers the most
// common patterns; a larger list can be dropped into this file without
// touching callers.
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'password1', 'password123', 'password1234',
  'passwordpassword', 'letmein', 'letmeinplease', 'welcome', 'welcome1',
  'welcome12345', 'welcome123', 'admin', 'administrator', 'adminadmin',
  'admin123', 'changeme', 'changeme1234', 'changeit', 'iloveyou',
  'iloveyou1234', 'monkey', 'dragon', 'master', 'mastermind', 'sunshine',
  'princess', 'football', 'baseball', 'basketball', 'superman', 'batman',
  'trustno1', 'shadow', 'michael', 'jennifer', 'access', 'login', 'qwerty',
  'qwerty123', 'qwertyuiop', 'qwertyuiop123', 'qwerty1234', 'asdfgh',
  'asdfghjkl', 'asdfghjkl123', 'zxcvbnm', 'zxcvbnm123', 'abc123',
  'abcdef', 'abcdefgh', 'abcdefghijkl', 'abcd1234', '1q2w3e4r', '1q2w3e4r5t',
  '1234', '12345', '123456', '1234567', '12345678', '123456789',
  '1234567890', '123456789012', '111111', '000000', '121212', '696969',
  'secret', 'secret123', 'secretpassword', 'school', 'schoolpassword',
  'school123', 'school2024', 'school2025', 'school2026', 'edupay',
  'edupay123', 'stellar', 'stellar123', 'bitcoin', 'blockchain', 'crypto',
  'cryptocurrency', 'ethereum', 'freedom', 'whatever', 'computer', 'internet',
  'hello', 'hello123', 'helloworld', 'testing', 'test1234', 'testtest',
  'testpassword', 'default', 'default123', 'root', 'toor', 'guest',
  'user1234', 'username', 'pass1234', 'passwd', 'p@ssword', 'p@ssw0rd',
  'pa55word', 'letmein123', 'mypassword', 'mypassword123', 'godisgood',
  'liverpool', 'arsenal', 'chelsea', 'summer2024', 'summer2025', 'winter2024',
  'winter2025', 'spring2025', 'autumn2025', 'qazwsxedc', 'mustang', 'jordan23',
]);

function trailingStrip(s) {
  // "password2026!" -> "password"; keeps letters only from the start.
  return s.replace(/[\d\W_]+$/u, '');
}

/**
 * @param {unknown} password
 * @param {{ email?: string|null, username?: string|null }} [identity]
 * @returns {{ valid: true } | { valid: false, code: string, message: string }}
 */
function validatePasswordPolicy(password, identity = {}) {
  if (typeof password !== 'string' || password.trim().length === 0) {
    return fail('PASSWORD_INVALID', 'Password must be a non-empty string.');
  }

  if ([...password].length < MIN_LENGTH) {
    return fail('PASSWORD_TOO_SHORT', `Password must be at least ${MIN_LENGTH} characters.`);
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    return fail(
      'PASSWORD_TOO_LONG',
      `Password must be at most ${MAX_BYTES} bytes (multi-byte characters count more than one byte).`
    );
  }

  const lower = password.toLowerCase();
  const identifiers = [identity.email, identity.username]
    .map((v) => (typeof v === 'string' ? v : ''))
    .map((v, i) => (i === 0 ? v.split('@')[0] : v))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length >= MIN_IDENTITY_LENGTH);
  if (identifiers.some((id) => lower.includes(id))) {
    return fail('PASSWORD_CONTAINS_IDENTITY', 'Password must not contain your email address or username.');
  }

  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(trailingStrip(lower))) {
    return fail('PASSWORD_COMMON', 'This password is too common. Choose a less predictable password.');
  }

  return { valid: true };
}

function fail(code, message) {
  return { valid: false, code, message };
}

module.exports = {
  validatePasswordPolicy,
};
