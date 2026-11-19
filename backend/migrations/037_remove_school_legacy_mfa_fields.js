'use strict';

/**
 * Migration 037: Remove the legacy school-level MFA fields (#1946).
 *
 * School documents used to carry a single shared TOTP secret (`mfaSecret`), its
 * backup-code hashes (`mfaBackupCodes`) and an `mfaEnabled` flag. #1553 stopped
 * the login flow from reading them, and #1946 removed the endpoints that managed
 * them, so nothing in the application uses them any more. They still widen the
 * blast radius of a database leak, so this migration unsets them.
 *
 * `requireMfa` (the per-school policy flag) is kept.
 *
 * up() is idempotent: re-running it matches no documents and changes nothing.
 * down() is a no-op because the removed secrets cannot be reconstructed, and
 * keeping them would only restore an unused attack surface.
 */

const LEGACY_FIELDS = ['mfaSecret', 'mfaBackupCodes', 'mfaEnabled'];

module.exports = {
  version: '037_remove_school_legacy_mfa_fields',

  async up(db) {
    const unset = Object.fromEntries(LEGACY_FIELDS.map((field) => [field, '']));
    const result = await db.collection('schools').updateMany(
      { $or: LEGACY_FIELDS.map((field) => ({ [field]: { $exists: true } })) },
      { $unset: unset }
    );
    return { schoolsUpdated: result.modifiedCount || 0 };
  },

  async down() {
    console.warn(
      '[migration 037] down() is a no-op; school-level MFA secrets are not restored.'
    );
  },
};
