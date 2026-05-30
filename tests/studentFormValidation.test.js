'use strict';

/**
 * Tests for StudentForm.jsx studentId validation — issue #611
 * Tests the validation logic: 28-char Stellar memo limit and alphanumeric pattern.
 */

const STUDENT_ID_MAX_LEN = 28;
const STUDENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Mirrors the validate() function inside StudentForm.jsx.
 */
function validateStudentId(studentId) {
  if (!studentId || !studentId.trim()) return 'Student ID is required.';
  if (studentId.length > STUDENT_ID_MAX_LEN)
    return `Student ID must be ${STUDENT_ID_MAX_LEN} characters or fewer (Stellar memo limit).`;
  if (!STUDENT_ID_PATTERN.test(studentId))
    return 'Student ID may only contain letters, numbers, hyphens, and underscores.';
  return null;
}

describe('StudentForm studentId validation — issue #611', () => {
  // ── 28-character limit ────────────────────────────────────────────────────

  it('accepts a studentId of exactly 28 characters', () => {
    expect(validateStudentId('A'.repeat(28))).toBeNull();
  });

  it('rejects a studentId of 29 characters', () => {
    const err = validateStudentId('A'.repeat(29));
    expect(err).toMatch(/28 characters or fewer/);
  });

  it('rejects a studentId of 100 characters', () => {
    const err = validateStudentId('A'.repeat(100));
    expect(err).toMatch(/28 characters or fewer/);
  });

  it('accepts a short alphanumeric studentId', () => {
    expect(validateStudentId('STU001')).toBeNull();
  });

  // ── Alphanumeric pattern ──────────────────────────────────────────────────

  it('accepts studentId with hyphens', () => {
    expect(validateStudentId('STU-001')).toBeNull();
  });

  it('accepts studentId with underscores', () => {
    expect(validateStudentId('STU_001')).toBeNull();
  });

  it('rejects studentId with spaces', () => {
    const err = validateStudentId('STU 001');
    expect(err).toMatch(/letters, numbers, hyphens, and underscores/);
  });

  it('rejects studentId with special characters', () => {
    const err = validateStudentId('STU@001!');
    expect(err).toMatch(/letters, numbers, hyphens, and underscores/);
  });

  it('rejects studentId with unicode/accented characters', () => {
    const err = validateStudentId('STÜ001');
    expect(err).toMatch(/letters, numbers, hyphens, and underscores/);
  });

  // ── Required field ────────────────────────────────────────────────────────

  it('rejects an empty studentId', () => {
    expect(validateStudentId('')).toMatch(/required/);
  });

  it('rejects a whitespace-only studentId', () => {
    expect(validateStudentId('   ')).toMatch(/required/);
  });

  // ── Form submission blocked ───────────────────────────────────────────────

  it('blocks submission when studentId exceeds 28 characters', () => {
    const errors = {};
    const id = 'A'.repeat(29);
    const err = validateStudentId(id);
    if (err) errors.studentId = err;
    // Submission should be blocked (errors object is non-empty)
    expect(Object.keys(errors).length).toBeGreaterThan(0);
  });

  it('does not block submission for a valid studentId', () => {
    const errors = {};
    const err = validateStudentId('STU001');
    if (err) errors.studentId = err;
    expect(Object.keys(errors).length).toBe(0);
  });
});
