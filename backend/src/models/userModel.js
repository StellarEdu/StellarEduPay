'use strict';

const mongoose = require('mongoose');

// Single source of truth for assignable roles. Route guards (requireSchoolAuth)
// must only reference roles from this list — see the static scan test in
// backend/src/routes/__tests__/roleGuardRoles.test.js.
const USER_ROLES = ['super_admin', 'owner', 'staff', 'read_only'];

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    // null schoolId = super-admin (break-glass only; prefer env super-admin)
    schoolId: { type: String, default: null, index: true },
    roles: [
      {
        type: String,
        enum: USER_ROLES,
      },
    ],
    isActive: { type: Boolean, default: true, index: true },
    // Bumped on deactivation/demotion to invalidate outstanding access tokens
    tokenVersion: { type: Number, default: 0 },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: null },
    mfaBackupCodes: [
      {
        // Salted slow hash (bcrypt/scrypt). Never store the raw code.
        hash: { type: String, required: true },
        // Which algorithm produced `hash` (e.g. 'bcrypt', 'scrypt', 'sha256').
        algo: { type: String, default: 'bcrypt' },
        // Legacy codes were unsalted SHA-256 with low entropy; they must be
        // regenerated on next login and are rejected for verification.
        legacy: { type: Boolean, default: false },
        used: { type: Boolean, default: false },
        usedAt: { type: Date, default: null },
      },
    ],
    // Invitation flow
    invitationToken: { type: String, default: null },
    invitationExpires: { type: Date, default: null },
    // Password reset flow (only one active token per user; overwritten on each request)
    resetToken: { type: String, default: null },
    resetExpires: { type: Date, default: null },
    resetRequestIp: { type: String, default: null },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.mfaSecret;
    delete ret.mfaBackupCodes;
    delete ret.invitationToken;
    delete ret.resetToken;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

// Expose the role enum so tests and guards can validate against it.
User.USER_ROLES = USER_ROLES;

module.exports = User;
module.exports.USER_ROLES = USER_ROLES;
