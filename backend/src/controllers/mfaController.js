'use strict';

const crypto = require('crypto');
const speakeasy = require('speakeasy');
const School = require('../models/schoolModel');
const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger');

// ── MFA secret encryption (AES-256-GCM) ──────────────────────────────────────
// Key is derived from JWT_SECRET so no extra env var is needed.

function getMfaEncryptionKey() {
  const master = process.env.JWT_SECRET;
  if (!master) throw new Error('JWT_SECRET is required for MFA secret encryption');
  return crypto.createHmac('sha256', master)
    .update('stellaredupay-mfa-secret-v1')
    .digest(); // 32 bytes → AES-256
}

function encryptMfaSecret(plaintext) {
  const key = getMfaEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Layout: iv[12] || tag[16] || ciphertext
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptMfaSecret(ciphertext) {
  const key = getMfaEncryptionKey();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const enc = data.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ── Backup code helpers ───────────────────────────────────────────────────────

const BACKUP_CODE_COUNT = 10;

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // Format: XXXX-XXXX (8 hex chars split by dash, uppercase)
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

// ── Helpers exported for use in authController ────────────────────────────────

function verifyTotpCode(encryptedSecret, token) {
  try {
    const secret = decryptMfaSecret(encryptedSecret);
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 1,
    });
  } catch {
    return false;
  }
}

function verifyBackupCode(mfaBackupCodes, code) {
  const hash = hashBackupCode(code);
  return mfaBackupCodes.findIndex((bc) => !bc.used && bc.hash === hash);
}

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * POST /api/auth/mfa/setup
 * Headers: X-School-Slug
 *
 * Generates a TOTP secret and backup codes, stores them (unenabled) on the
 * school document, and returns the plaintext versions to the caller.
 * MFA is not active until /mfa/verify is called.
 */
async function setupMfa(req, res) {
  const slug = req.headers['x-school-slug'];
  if (!slug) {
    return res.status(400).json({ error: 'X-School-Slug header is required.', code: 'MISSING_SCHOOL_SLUG' });
  }

  try {
    const school = await School.findOne({ slug, isActive: true });
    if (!school) {
      return res.status(404).json({ error: 'School not found.', code: 'SCHOOL_NOT_FOUND' });
    }

    const generated = speakeasy.generateSecret({
      name: `StellarEduPay (${school.name || slug})`,
      issuer: 'StellarEduPay',
    });
    // Real speakeasy returns `base32`; test mock may return `secret` — accept both
    const totpSecret = generated.base32 || generated.secret;
    const qrCode = generated.otpauth_url;

    const backupCodes = generateBackupCodes();

    // Store encrypted secret + hashed backup codes (pending; mfaEnabled stays false)
    school.mfaSecret = encryptMfaSecret(totpSecret);
    school.mfaBackupCodes = backupCodes.map((c) => ({ hash: hashBackupCode(c), used: false }));
    await school.save();

    return res.json({
      secret: totpSecret,
      qrCode,
      backupCodes,
    });
  } catch (err) {
    logger.error('[MFA] setupMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to set up MFA.', code: 'MFA_SETUP_ERROR' });
  }
}

/**
 * POST /api/auth/mfa/verify
 * Headers: X-School-Slug
 * Body: { secret, code }
 *
 * Verifies the TOTP code against the provided base32 secret, then enables MFA
 * for the school.  The client must call /mfa/setup first so that backup codes
 * are already stored.
 */
async function verifyAndEnableMfa(req, res) {
  const slug = req.headers['x-school-slug'];
  const { secret, code } = req.body || {};

  if (!slug) {
    return res.status(400).json({ error: 'X-School-Slug header is required.', code: 'MISSING_SCHOOL_SLUG' });
  }
  if (!code) {
    return res.status(400).json({ error: 'TOTP code is required.', code: 'MISSING_MFA_CODE' });
  }

  try {
    const school = await School.findOne({ slug, isActive: true });
    if (!school) {
      return res.status(404).json({ error: 'School not found.', code: 'SCHOOL_NOT_FOUND' });
    }

    // Accept the secret from the request body (client sends it back after scanning QR)
    // OR fall back to the pending secret already stored on the school.
    const verifySecret = secret || (school.mfaSecret ? decryptMfaSecret(school.mfaSecret) : null);
    if (!verifySecret) {
      return res.status(400).json({ error: 'MFA setup must be completed first.', code: 'MFA_NOT_SETUP' });
    }

    const valid = speakeasy.totp.verify({
      secret: verifySecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      return res.status(400).json({ error: 'Invalid TOTP code.', code: 'INVALID_MFA_CODE' });
    }

    await School.findOneAndUpdate(
      { slug },
      {
        $set: {
          mfaEnabled: true,
          mfaSecret: encryptMfaSecret(verifySecret),
        },
      }
    );

    await logAudit({
      schoolId: school.schoolId || slug,
      action: 'MFA_ENABLED',
      performedBy: req.admin?.username || req.user?.userId || 'admin',
      targetId: school._id?.toString() || slug,
      targetType: 'school',
      details: { slug },
      result: 'success',
      severity: 'high',
    });

    return res.json({ message: 'MFA enabled successfully.' });
  } catch (err) {
    logger.error('[MFA] verifyAndEnableMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to enable MFA.', code: 'MFA_ENABLE_ERROR' });
  }
}

/**
 * POST /api/auth/mfa/disable
 * Headers: X-School-Slug
 * Body: { code }  — valid TOTP code required to confirm intent
 */
async function disableMfa(req, res) {
  const slug = req.headers['x-school-slug'];
  const { code } = req.body || {};

  if (!slug) {
    return res.status(400).json({ error: 'X-School-Slug header is required.', code: 'MISSING_SCHOOL_SLUG' });
  }
  if (!code) {
    return res.status(400).json({ error: 'TOTP code is required to disable MFA.', code: 'MISSING_MFA_CODE' });
  }

  try {
    const school = await School.findOne({ slug, isActive: true });
    if (!school) {
      return res.status(404).json({ error: 'School not found.', code: 'SCHOOL_NOT_FOUND' });
    }
    if (!school.mfaSecret) {
      return res.status(400).json({ error: 'MFA is not configured for this school.', code: 'MFA_NOT_CONFIGURED' });
    }

    const valid = speakeasy.totp.verify({
      secret: decryptMfaSecret(school.mfaSecret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      return res.status(400).json({ error: 'Invalid TOTP code.', code: 'INVALID_MFA_CODE' });
    }

    await School.findOneAndUpdate(
      { slug },
      { $set: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] } }
    );

    await logAudit({
      schoolId: school.schoolId || slug,
      action: 'MFA_DISABLED',
      performedBy: req.admin?.username || req.user?.userId || 'admin',
      targetId: school._id?.toString() || slug,
      targetType: 'school',
      details: { slug },
      result: 'success',
      severity: 'high',
    });

    return res.json({ message: 'MFA disabled successfully.' });
  } catch (err) {
    logger.error('[MFA] disableMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to disable MFA.', code: 'MFA_DISABLE_ERROR' });
  }
}

// ── User-level MFA route handlers ────────────────────────────────────────────
// These operate on the authenticated User document (req.user.userId) rather than
// a school document. User-level MFA takes precedence over school-level MFA at
// login time, giving individual admins/owners their own second factor.

/**
 * POST /api/auth/mfa/user/setup
 *
 * Generates a TOTP secret and backup codes for the currently authenticated user.
 * MFA is not active until /mfa/user/verify is called.
 */
async function setupUserMfa(req, res) {
  const userId = req.user?.userId;
  if (!userId || userId === 'super_admin') {
    return res.status(403).json({
      error: 'User-level MFA is not available for environment-based super-admin accounts.',
      code: 'MFA_NOT_AVAILABLE',
    });
  }

  try {
    const User = require('../models/userModel');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const generated = speakeasy.generateSecret({
      name: `StellarEduPay (${user.email})`,
      issuer: 'StellarEduPay',
    });
    const totpSecret = generated.base32 || generated.secret;
    const qrCode = generated.otpauth_url;

    const backupCodes = generateBackupCodes();

    user.mfaSecret = encryptMfaSecret(totpSecret);
    user.mfaBackupCodes = backupCodes.map((c) => ({ hash: hashBackupCode(c), used: false }));
    await user.save();

    return res.json({ secret: totpSecret, qrCode, backupCodes });
  } catch (err) {
    logger.error('[MFA] setupUserMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to set up MFA.', code: 'MFA_SETUP_ERROR' });
  }
}

/**
 * POST /api/auth/mfa/user/verify
 * Body: { secret, code }
 *
 * Verifies the TOTP code and activates user-level MFA.
 */
async function verifyAndEnableUserMfa(req, res) {
  const userId = req.user?.userId;
  const { secret, code } = req.body || {};

  if (!userId || userId === 'super_admin') {
    return res.status(403).json({
      error: 'User-level MFA is not available for environment-based super-admin accounts.',
      code: 'MFA_NOT_AVAILABLE',
    });
  }
  if (!code) {
    return res.status(400).json({ error: 'TOTP code is required.', code: 'MISSING_MFA_CODE' });
  }

  try {
    const User = require('../models/userModel');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const verifySecret = secret || (user.mfaSecret ? decryptMfaSecret(user.mfaSecret) : null);
    if (!verifySecret) {
      return res.status(400).json({ error: 'MFA setup must be completed first.', code: 'MFA_NOT_SETUP' });
    }

    const valid = speakeasy.totp.verify({
      secret: verifySecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      return res.status(400).json({ error: 'Invalid TOTP code.', code: 'INVALID_MFA_CODE' });
    }

    await User.findByIdAndUpdate(userId, {
      $set: {
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(verifySecret),
      },
    });

    await logAudit({
      schoolId: user.schoolId || 'system',
      action: 'USER_MFA_ENABLED',
      performedBy: user.email,
      targetId: userId,
      targetType: 'user',
      details: { email: user.email },
      result: 'success',
      severity: 'high',
    });

    return res.json({ message: 'MFA enabled successfully.' });
  } catch (err) {
    logger.error('[MFA] verifyAndEnableUserMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to enable MFA.', code: 'MFA_ENABLE_ERROR' });
  }
}

/**
 * POST /api/auth/mfa/user/disable
 * Body: { code }
 *
 * Disables user-level MFA. Requires a valid TOTP code to confirm intent.
 */
async function disableUserMfa(req, res) {
  const userId = req.user?.userId;
  const { code } = req.body || {};

  if (!userId || userId === 'super_admin') {
    return res.status(403).json({
      error: 'User-level MFA is not available for environment-based super-admin accounts.',
      code: 'MFA_NOT_AVAILABLE',
    });
  }
  if (!code) {
    return res.status(400).json({ error: 'TOTP code is required to disable MFA.', code: 'MISSING_MFA_CODE' });
  }

  try {
    const User = require('../models/userModel');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    }
    if (!user.mfaSecret) {
      return res.status(400).json({ error: 'MFA is not configured for this user.', code: 'MFA_NOT_CONFIGURED' });
    }

    const valid = speakeasy.totp.verify({
      secret: decryptMfaSecret(user.mfaSecret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      return res.status(400).json({ error: 'Invalid TOTP code.', code: 'INVALID_MFA_CODE' });
    }

    await User.findByIdAndUpdate(userId, {
      $set: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
    });

    await logAudit({
      schoolId: user.schoolId || 'system',
      action: 'USER_MFA_DISABLED',
      performedBy: user.email,
      targetId: userId,
      targetType: 'user',
      details: { email: user.email },
      result: 'success',
      severity: 'high',
    });

    return res.json({ message: 'MFA disabled successfully.' });
  } catch (err) {
    logger.error('[MFA] disableUserMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to disable MFA.', code: 'MFA_DISABLE_ERROR' });
  }
}

module.exports = {
  setupMfa,
  verifyAndEnableMfa,
  disableMfa,
  setupUserMfa,
  verifyAndEnableUserMfa,
  disableUserMfa,
  // exported for use in authController
  verifyTotpCode,
  verifyBackupCode,
  hashBackupCode,
  encryptMfaSecret,
  decryptMfaSecret,
};
