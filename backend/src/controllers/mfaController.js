'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const School = require('../models/schoolModel');
const { logAudit } = require('../services/auditService');
const logger = require('../utils/logger');
const schoolCache = require('../services/schoolCacheInvalidator');
const { revokeAllUserSessions } = require('../services/sessionStore');

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
// #1774 — Backup codes must have >= 50 bits of entropy and be stored with a
// per-code salt and a slow hash. We use Crockford base32 (32 symbols, no
// ambiguous characters) so 10 symbols = 50 bits, formatted XXXXX-XXXXX.
// Codes are hashed with bcrypt (cost 10) which embeds a unique salt per code.

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const BACKUP_CODE_LENGTH = 10; // 10 * log2(32) = 50 bits
const BACKUP_CODE_BCRYPT_COST = 10;
const BACKUP_CODE_HASH_PREFIX = 'bcrypt$'; // distinguishes from legacy sha256 hex
const BACKUP_CODE_MAX_ATTEMPTS = 5;
const BACKUP_CODE_WINDOW_MS = 15 * 60 * 1000;

// In-memory sliding-window rate limiter for backup-code verification attempts.
// Keyed by school slug or user id. Best-effort (per-process); the atomic
// single-use marking below is the authoritative concurrency guard.
const backupCodeAttempts = new Map();

function checkBackupCodeRateLimit(key) {
  const now = Date.now();
  const entry = backupCodeAttempts.get(key);
  if (!entry || now - entry.windowStart > BACKUP_CODE_WINDOW_MS) {
    backupCodeAttempts.set(key, { windowStart: now, count: 0 });
    return { allowed: true };
  }
  if (entry.count >= BACKUP_CODE_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: BACKUP_CODE_WINDOW_MS - (now - entry.windowStart) };
  }
  return { allowed: true };
}

function recordBackupCodeAttempt(key) {
  const now = Date.now();
  const entry = backupCodeAttempts.get(key);
  if (!entry || now - entry.windowStart > BACKUP_CODE_WINDOW_MS) {
    backupCodeAttempts.set(key, { windowStart: now, count: 1 });
  } else {
    entry.count += 1;
  }
}

function clearBackupCodeAttempts(key) {
  backupCodeAttempts.delete(key);
}

function normalizeBackupCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '') // strip dashes/spaces
    // Crockford base32 aliases
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let raw = '';
    // Rejection-free: 32 divides 256 evenly, so modulo bias is zero.
    const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
      raw += BACKUP_CODE_ALPHABET[bytes[j] % BACKUP_CODE_ALPHABET.length];
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

async function hashBackupCode(code) {
  const normalized = normalizeBackupCode(code);
  const hash = await bcrypt.hash(normalized, BACKUP_CODE_BCRYPT_COST);
  return `${BACKUP_CODE_HASH_PREFIX}${hash}`;
}

async function hashBackupCodes(codes) {
  return Promise.all(codes.map((c) => hashBackupCode(c)));
}

function isLegacyBackupCodeHash(hash) {
  return typeof hash === 'string' && !hash.startsWith(BACKUP_CODE_HASH_PREFIX);
}

/**
 * Verify a backup code against a list of stored code entries.
 * Returns the index of the matching unused code, or -1.
 * Legacy (unsalted sha256) hashes are never accepted — users must regenerate.
 */
async function findMatchingBackupCodeIndex(mfaBackupCodes, code) {
  if (!Array.isArray(mfaBackupCodes) || mfaBackupCodes.length === 0) return -1;
  const normalized = normalizeBackupCode(code);
  if (!normalized) return -1;

  for (let i = 0; i < mfaBackupCodes.length; i++) {
    const entry = mfaBackupCodes[i];
    if (!entry || entry.used) continue;
    if (isLegacyBackupCodeHash(entry.hash)) continue; // legacy codes rejected
    const stored = entry.hash.slice(BACKUP_CODE_HASH_PREFIX.length);
    // eslint-disable-next-line no-await-in-loop
    const match = await bcrypt.compare(normalized, stored);
    if (match) return i;
  }
  return -1;
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

/**
 * Verify a backup code against an in-memory list of code entries.
 * Returns the index of the matching unused code, or -1.
 * NOTE: this does not consume the code; callers that persist must use the
 * atomic consumeBackupCode* helpers below.
 */
async function verifyBackupCode(mfaBackupCodes, code) {
  return findMatchingBackupCodeIndex(mfaBackupCodes, code);
}

/**
 * Atomically consume a backup code on a School document.
 * The filter requires the matched array element to still be unused, so two
 * concurrent requests presenting the same code cannot both succeed (#1533).
 * Returns the updated document, or null if the code was already used/invalid.
 */
async function consumeSchoolBackupCode(slug, code) {
  const school = await School.findOne({ slug, isActive: true });
  if (!school) return { status: 'not_found' };

  const rate = checkBackupCodeRateLimit(`school:${slug}`);
  if (!rate.allowed) return { status: 'rate_limited', retryAfterMs: rate.retryAfterMs };

  const idx = await findMatchingBackupCodeIndex(school.mfaBackupCodes, code);
  if (idx === -1) {
    recordBackupCodeAttempt(`school:${slug}`);
    return { status: 'invalid' };
  }

  const updated = await School.findOneAndUpdate(
    {
      slug,
      isActive: true,
      [`mfaBackupCodes.${idx}.used`]: false,
    },
    { $set: { [`mfaBackupCodes.${idx}.used`]: true } },
    { new: true }
  );
  if (!updated) {
    // Lost the race — another request consumed this code.
    recordBackupCodeAttempt(`school:${slug}`);
    return { status: 'invalid' };
  }
  clearBackupCodeAttempts(`school:${slug}`);
  return { status: 'ok', school: updated };
}

/**
 * Atomically consume a backup code on a User document.
 * Returns { status, user? }.
 */
async function consumeUserBackupCode(userId, code) {
  const User = require('../models/userModel');
  const user = await User.findById(userId);
  if (!user) return { status: 'not_found' };

  const rate = checkBackupCodeRateLimit(`user:${userId}`);
  if (!rate.allowed) return { status: 'rate_limited', retryAfterMs: rate.retryAfterMs };

  const idx = await findMatchingBackupCodeIndex(user.mfaBackupCodes, code);
  if (idx === -1) {
    recordBackupCodeAttempt(`user:${userId}`);
    return { status: 'invalid' };
  }

  const updated = await User.findOneAndUpdate(
    { _id: userId, [`mfaBackupCodes.${idx}.used`]: false },
    { $set: { [`mfaBackupCodes.${idx}.used`]: true } },
    { new: true }
  );
  if (!updated) {
    recordBackupCodeAttempt(`user:${userId}`);
    return { status: 'invalid' };
  }
  clearBackupCodeAttempts(`user:${userId}`);
  return { status: 'ok', user: updated };
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

    // #1180 — Refuse to overwrite credentials when MFA is already active.
    // An authenticated admin must call /mfa/disable (with a valid TOTP code)
    // before re-issuing a new secret, preventing silent credential overwrites.
    if (school.mfaEnabled) {
      return res.status(400).json({
        error: 'MFA is already active for this school. Disable MFA before setting it up again.',
        code: 'MFA_ALREADY_ACTIVE',
      });
    }

    const generated = speakeasy.generateSecret({
      name: `StellarEduPay (${school.name || slug})`,
      issuer: 'StellarEduPay',
    });
    // Real speakeasy returns `base32`; test mock may return `secret` — accept both
    const totpSecret = generated.base32 || generated.secret;
    const qrCode = generated.otpauth_url;

    const backupCodes = generateBackupCodes();
    const backupCodeHashes = await hashBackupCodes(backupCodes);

    // Store encrypted secret + hashed backup codes (pending; mfaEnabled stays false)
    school.mfaSecret = encryptMfaSecret(totpSecret);
    school.mfaBackupCodes = backupCodeHashes.map((hash) => ({ hash, used: false }));
    await school.save();
    schoolCache.invalidate(school);

    // #1180 — Audit credential generation so every setup attempt is traceable.
    await logAudit({
      schoolId: school.schoolId || slug,
      action: 'MFA_SECRET_GENERATED',
      performedBy: req.admin?.username || req.user?.userId || req.admin?.email || req.user?.email || 'admin',
      targetId: school._id?.toString() || slug,
      targetType: 'school',
      details: { slug },
      result: 'success',
      severity: 'high',
    });

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

    const updatedSchool = await School.findOneAndUpdate(
      { slug },
      {
        $set: {
          mfaEnabled: true,
          mfaSecret: encryptMfaSecret(verifySecret),
        },
      },
      { new: true }
    );
    if (updatedSchool) schoolCache.invalidate(updatedSchool);

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

    const updatedSchool = await School.findOneAndUpdate(
      { slug },
      { $set: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] } },
      { new: true }
    );
    if (updatedSchool) schoolCache.invalidate(updatedSchool);

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
    const backupCodeHashes = await hashBackupCodes(backupCodes);

    user.mfaSecret = encryptMfaSecret(totpSecret);
    user.mfaBackupCodes = backupCodeHashes.map((hash) => ({ hash, used: false }));
    await user.save();

    await logAudit({
      schoolId: user.schoolId || 'system',
      action: 'USER_MFA_SETUP_INITIATED',
      performedBy: req.auditContext?.performedBy || user.email,
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
      targetId: String(userId),
      targetType: 'user',
      details: { mfaEnabled: false, setupStarted: true },
    });

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

    // #1356 / #1739 — REQUIRE_MFA: this request's token may have been a restricted
    // mfaSetupPending token. Reissue the access-token cookie without that flag so the
    // just-completed enrolment takes effect immediately, without forcing the admin to
    // log in again.
    //
    // Fix 1 (#1739): use parseTTL() so that JWT_ACCESS_TOKEN_TTL="8h" resolves to
    // 28800 seconds instead of parseInt("8h") === 8 (the bug that caused 8-second TTLs).
    //
    // Fix 2 (#1739): rotate the refresh token — revoke the old restricted family and
    // issue a brand-new refresh token whose stored metadata no longer contains
    // mfaSetupPending. Without this, handleRefresh copies the flag from the stored
    // metadata and re-mints a restricted access token on every silent refresh even
    // after enrolment is complete, keeping the user in the /mfa-setup loop.
    if (req.user?.mfaSetupPending) {
      const jwt = require('jsonwebtoken');
      const { parseTTL, getStore, issueRefreshToken } = require('./authController');
      const { role, userId: uid, schoolId, roles } = req.user;

      const accessTTL  = parseTTL('JWT_ACCESS_TOKEN_TTL',  8 * 3600);
      const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

      // Build the full, unrestricted payload (no mfaSetupPending).
      const newPayload = { role, userId: uid, schoolId, roles };
      const newAccessToken = jwt.sign(newPayload, process.env.JWT_SECRET, { expiresIn: accessTTL });

      // Rotate the refresh token: revoke the old family, issue a clean new one.
      const store = getStore();
      const oldRefreshToken = req.cookies?.admin_refresh_token;
      if (oldRefreshToken) {
        const oldMeta = await store.getToken(oldRefreshToken).catch(() => null);
        if (oldMeta?.familyId) {
          await store.revokeFamily(oldMeta.familyId, refreshTTL).catch(() =>
            logger.warn('[MFA] Failed to revoke old refresh-token family after enrolment', { familyId: oldMeta.familyId })
          );
          if (oldMeta.sessionId) {
            await store.delSession(oldMeta.sessionId).catch(() =>
              logger.debug('[MFA] delSession after MFA enrolment missed')
            );
          }
        }
        await store.delToken(oldRefreshToken).catch(() =>
          logger.debug('[MFA] delToken after MFA enrolment missed')
        );
      }

      let newRefreshToken;
      try {
        newRefreshToken = await issueRefreshToken(store, newPayload, refreshTTL, req);
      } catch (err) {
        logger.error('[MFA] Failed to issue new refresh token after enrolment', { error: err.message });
        // Non-fatal for the response, but the refresh rotation didn't happen.
        // The access token is still fresh; the next manual login will clean things up.
      }

      const cookieBase = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      };
      res.cookie('admin_token', newAccessToken, { ...cookieBase, maxAge: accessTTL * 1000 });
      if (newRefreshToken) {
        res.cookie('admin_refresh_token', newRefreshToken, {
          ...cookieBase,
          maxAge: refreshTTL * 1000,
          path: '/api/auth',
        });
      }
    }

    return res.json({ message: 'MFA enabled successfully.' });
  } catch (err) {
    logger.error('[MFA] verifyAndEnableUserMfa error', { error: err.message });
    return res.status(500).json({ error: 'Failed to enable MFA.', code: 'MFA_ENABLE_ERROR' });
  }
}

/**
 * POST /api/auth/mfa/backup-codes/regenerate
 * Headers: X-School-Slug
 * Body: { code } (valid TOTP code) OR { password }
 *
 * Regenerates backup codes for a school. Requires step-up verification
 * (either a valid TOTP code or the school password) to prevent unauthorized
 * backup code rotation. Invalidates all previously issued codes.
 */
async function regenerateBackupCodes(req, res) {
  const slug = req.headers['x-school-slug'];
  const { code, password } = req.body || {};

  if (!slug) {
    return res.status(400).json({ error: 'X-School-Slug header is required.', code: 'MISSING_SCHOOL_SLUG' });
  }

  try {
    const school = await School.findOne({ slug, isActive: true });
    if (!school) {
      return res.status(404).json({ error: 'School not found.', code: 'SCHOOL_NOT_FOUND' });
    }

    // Verify step-up authentication
    let verified = false;

    // Step 1: Try TOTP code verification if provided
    if (code) {
      if (!school.mfaSecret) {
        return res.status(400).json({
          error: 'MFA is not configured for this school. Cannot use TOTP code for verification.',
          code: 'MFA_NOT_CONFIGURED',
        });
      }
      verified = speakeasy.totp.verify({
        secret: decryptMfaSecret(school.mfaSecret),
        encoding: 'base32',
        token: code,
        window: 1,
      });
      if (!verified) {
        return res.status(401).json({
          error: 'Invalid TOTP code.',
          code: 'INVALID_MFA_CODE',
        });
      }
    }

    // Step 2: Try password verification if TOTP failed and password provided
    if (!verified && password) {
      // For school-level MFA, we use an environment-based password or stored hash
      const envPasswordHash = process.env.SCHOOL_ADMIN_PASSWORD_HASH;
      const envPassword = process.env.SCHOOL_ADMIN_PASSWORD;

      if (envPasswordHash) {
        verified = await bcrypt.compare(password, envPasswordHash);
      } else if (envPassword) {
        // Timing-safe comparison for environment-based password
        const crypto = require('crypto');
        verified = crypto.timingSafeEqual(Buffer.from(password), Buffer.from(envPassword));
      }
      if (!verified) {
        return res.status(401).json({
          error: 'Invalid password.',
          code: 'INVALID_PASSWORD',
        });
      }
    }

    // Require at least one form of verification
    if (!verified) {
      return res.status(400).json({
        error: 'Either a valid TOTP code or password is required.',
        code: 'VERIFICATION_REQUIRED',
      });
    }

    // Generate new backup codes and invalidate old ones
    const newCodes = generateBackupCodes();
    const newCodeHashes = await hashBackupCodes(newCodes);
    const updatedSchool = await School.findOneAndUpdate(
      { slug },
      {
        $set: {
          mfaBackupCodes: newCodeHashes.map((hash) => ({ hash, used: false })),
        },
      },
      { new: true }
    );
    if (updatedSchool) schoolCache.invalidate(updatedSchool);

    // Audit the backup code regeneration
    await logAudit({
      schoolId: school.schoolId || slug,
      action: 'MFA_BACKUP_CODES_REGENERATED',
      performedBy: req.admin?.username || req.admin?.email || 'admin',
      targetId: school._id?.toString() || slug,
      targetType: 'school',
      details: {
        slug,
        verificationMethod: code ? 'TOTP' : 'password',
      },
      result: 'success',
      severity: 'high',
    });

    return res.json({
      message: 'Backup codes regenerated successfully.',
      backupCodes: newCodes,
    });
  } catch (err) {
    logger.error('[MFA] regenerateBackupCodes error', { error: err.message });
    return res.status(500).json({ error: 'Failed to regenerate backup codes.', code: 'MFA_REGENERATE_ERROR' });
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

    // Disabling a second factor must not leave pre-existing sessions alive:
    // revoke every refresh-token family for this user so any stolen cookie
    // stops minting access tokens.
    await revokeAllUserSessions(userId);

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
  regenerateBackupCodes,
  setupUserMfa,
  verifyAndEnableUserMfa,
  disableUserMfa,
  // exported for use in authController
  verifyTotpCode,
  verifyBackupCode,
  hashBackupCode,
  hashBackupCodes,
  consumeSchoolBackupCode,
  consumeUserBackupCode,
  normalizeBackupCode,
  isLegacyBackupCodeHash,
  encryptMfaSecret,
  decryptMfaSecret,
};
