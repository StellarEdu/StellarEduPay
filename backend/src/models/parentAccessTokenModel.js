'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * ParentAccessToken — a revocable, expiring grant behind a parent portal
 * magic link (#1637).
 *
 * The link itself carries a signed JWT whose `jti` is `tokenId`; this record
 * is what makes the link revocable and scopes it to one school and to the
 * listed students. Only a SHA-256 hash of the JWT is stored, so a database
 * read alone cannot be replayed as a link.
 */
const parentAccessTokenSchema = new mongoose.Schema(
  {
    schoolId:   { type: String, required: true, index: true },
    tokenId:    { type: String, required: true },
    tokenHash:  { type: String, required: true, select: false },

    // Students this link can see. Always within schoolId.
    studentIds: {
      type: [String],
      required: true,
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'At least one student is required' },
    },
    // Blind index of the parent email the link was issued for (no plaintext).
    parentEmailHash: { type: String, default: null },

    expiresAt:  { type: Date, required: true },
    revokedAt:  { type: Date, default: null },
    revokedBy:  { type: String, default: null },
    revokeReason: { type: String, default: null, maxlength: 500 },

    createdBy:  { type: String, required: true }, // staff user id, or 'system'
    lastUsedAt: { type: Date, default: null },
    useCount:   { type: Number, default: 0 },
  },
  { timestamps: true }
);

parentAccessTokenSchema.index({ schoolId: 1, tokenId: 1 }, { unique: true });
parentAccessTokenSchema.index({ schoolId: 1, studentIds: 1, revokedAt: 1 });
// Purge records 30 days after they expire; an expired link is useless anyway.
parentAccessTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

parentAccessTokenSchema.methods.isActive = function isActive(now = new Date()) {
  return !this.revokedAt && this.expiresAt > now;
};

parentAccessTokenSchema.plugin(tenantScope, { modelName: 'ParentAccessToken' });

module.exports = mongoose.model('ParentAccessToken', parentAccessTokenSchema);
