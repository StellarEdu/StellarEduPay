'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const StellarSdk = require('@stellar/stellar-sdk');
const School = require('../models/schoolModel');
const { logAudit } = require('../services/auditService');
const { verifyStellarAccountFunding } = require('../services/stellarAccountVerificationService');
const { validateWebhookUrl } = require('../utils/validateWebhookUrl');
const schoolCache = require('../services/schoolCacheInvalidator');
const { buildWalletRotation } = require('../services/walletRotationService');
const {
  parseOverlapSeconds,
  applySecretRotation,
  findLegacySchoolEndpoint,
  upsertLegacySchoolEndpoint,
  setWebhookDeprecationHeaders,
  generateWebhookSecret,
} = require('../services/webhookEndpointService');
const { isSupportedCurrency } = require('../services/currencyConversionService');

// Issue #1773: constant-time string comparison that does not leak length.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

// Issue #1773: shared step-up confirmation for sensitive actions (wallet
// rotation, webhook-secret rotation). Replaces the old plaintext
// ADMIN_PASSWORD comparison, which:
//   - could never pass on hashed-credential (ADMIN_PASSWORD_HASH) deployments,
//   - checked DB users against the wrong (shared env) credential,
//   - acted as an unthrottled password oracle.
// Now: bcrypt against ADMIN_PASSWORD_HASH for the env super-admin (legacy
// safeEqual fallback to ADMIN_PASSWORD only when the hash is unset), bcrypt
// against user.passwordHash for DB users, a required TOTP code when MFA is
// enabled, failures counted toward the same lockout as login, and both
// success and failure audited.
async function verifyStepUp(req, { password, mfaCode } = {}) {
  const auditContext = req.auditContext || {};
  const performedBy = auditContext.performedBy || (req.user && (req.user.email || req.user.id)) || 'unknown';
  const schoolId = req.params && req.params.schoolId;

  const audit = async (result, details) => {
    try {
      await logAudit({
        schoolId,
        action: 'step_up_verification',
        performedBy,
        targetId: schoolId,
        targetType: 'school',
        details,
        result,
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });
    } catch {
      // Auditing must never mask the step-up outcome.
    }
  };

  const fail = async (reason) => {
    await audit('failure', { reason });
    return { ok: false, reason };
  };

  const user = req.user || null;
  const isDbUser = !!(user && user.passwordHash);

  // --- Lockout check (same path as login) -------------------------------
  const lockoutService = require('../services/lockoutService');
  const lockoutKey = isDbUser
    ? (user.email || user.id)
    : (req.ip || (req.connection && req.connection.remoteAddress) || 'env-admin');

  try {
    const locked = await lockoutService.isLockedOut(lockoutKey);
    if (locked) {
      return fail('locked_out');
    }
  } catch {
    // If the lockout store is unavailable, fail closed on the password check
    // below rather than blocking all step-ups.
  }

  // --- Password verification -------------------------------------------
  if (!password || typeof password !== 'string') {
    return fail('missing_password');
  }

  let passwordOk = false;
  if (isDbUser) {
    passwordOk = await bcrypt.compare(password, user.passwordHash);
  } else {
    const hash = process.env.ADMIN_PASSWORD_HASH;
    if (hash) {
      passwordOk = await bcrypt.compare(password, hash);
    } else if (process.env.ADMIN_PASSWORD) {
      // Legacy fallback: plaintext env var, only when no hash is configured.
      passwordOk = safeEqual(password, process.env.ADMIN_PASSWORD);
    }
  }

  if (!passwordOk) {
    try {
      await lockoutService.recordLoginFailure(lockoutKey);
    } catch {
      // best-effort
    }
    return fail('invalid_password');
  }

  // --- MFA verification -------------------------------------------------
  const mfaEnabled = isDbUser
    ? !!user.mfaEnabled
    : !!(req.school && req.school.mfaEnabled);

  if (mfaEnabled) {
    if (!mfaCode || typeof mfaCode !== 'string') {
      return fail('missing_mfa_code');
    }
    let mfaOk = false;
    try {
      const mfaService = require('../services/mfaService');
      const secret = isDbUser ? user.mfaSecret : (req.school && req.school.mfaSecret);
      if (typeof mfaService.verifyToken === 'function') {
        mfaOk = await mfaService.verifyToken(secret, mfaCode);
      } else if (typeof mfaService.verifyTotp === 'function') {
        mfaOk = await mfaService.verifyTotp(secret, mfaCode);
      }
    } catch {
      mfaOk = false;
    }
    if (!mfaOk) {
      try {
        await lockoutService.recordLoginFailure(lockoutKey);
      } catch {
        // best-effort
      }
      return fail('invalid_mfa_code');
    }
  }

  // Success — reset the failure counter, same as a successful login.
  try {
    if (typeof lockoutService.resetLoginFailures === 'function') {
      await lockoutService.resetLoginFailures(lockoutKey);
    }
  } catch {
    // best-effort
  }

  await audit('success', { mfaUsed: mfaEnabled });
  return { ok: true };
}

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// POST /api/schools
async function createSchool(req, res, next) {
  try {
    const { name, slug, stellarAddress, network, adminEmail, address, timezone, suspiciousPaymentMultiplier, suspiciousAmountConfig } = req.body;

    const errors = [];
    if (!name || typeof name !== 'string' || !name.trim())
      errors.push('name is required');
    if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug.trim().toLowerCase()))
      errors.push('slug must be 2–60 lowercase alphanumeric characters or hyphens');
    if (!stellarAddress)
      errors.push('stellarAddress is required');
    else if (!StellarSdk.StrKey.isValidEd25519PublicKey(stellarAddress))
      errors.push('stellarAddress must be a valid Stellar public key (Ed25519)');
    if (network && !['testnet', 'mainnet'].includes(network))
      errors.push('network must be "testnet" or "mainnet"');
    if (suspiciousPaymentMultiplier !== undefined) {
      if (typeof suspiciousPaymentMultiplier !== 'number' || suspiciousPaymentMultiplier < 1.1 || suspiciousPaymentMultiplier > 100) {
        errors.push('suspiciousPaymentMultiplier must be a number between 1.1 and 100');
      }
    }
    if (errors.length) return res.status(400).json({ errors, code: 'VALIDATION_ERROR' });

    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({
        error: 'Invalid timezone. Must be a valid IANA timezone string (e.g. Africa/Lagos)',
        code: 'INVALID_TIMEZONE',
      });
    }

    // Issue #889: Validate localCurrency against CoinGecko supported list
    const { localCurrency } = req.body;
    if (localCurrency !== undefined) {
      const { valid } = await isSupportedCurrency(localCurrency);
      if (!valid) {
        return res.status(400).json({
          error: `Currency "${localCurrency.toUpperCase()}" is not supported by the price feed. Use a valid ISO 4217 fiat code (e.g. USD, EUR, NGN).`,
          code: 'UNSUPPORTED_CURRENCY',
        });
      }
    }

    // Verify Stellar account funding (non-blocking)
    const { warning } = await verifyStellarAccountFunding(stellarAddress);

    const schoolId = `SCH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const school = await School.create({
      schoolId,
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      stellarAddress,
      network: network || 'testnet',
      adminEmail: adminEmail || null,
      address: address || null,
      // A new wallet's pre-existing history is not ingested (#1818).
      ingestStartsAt: new Date(),
      ...(localCurrency !== undefined && { localCurrency: localCurrency.toUpperCase() }),
      ...(timezone !== undefined && { timezone }),
      ...(suspiciousPaymentMultiplier !== undefined && { suspiciousPaymentMultiplier }),
      ...(suspiciousAmountConfig !== undefined && { suspiciousAmountConfig }),
    });

    // Audit log
    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'school_create',
        performedBy: req.auditContext.performedBy,
        targetId: schoolId,
        targetType: 'school',
        details: { name, slug, stellarAddress, network: network || 'testnet' },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    schoolCache.invalidate(school);

    // Return 202 with warning if account is unfunded
    if (warning) {
      return res.status(202).json({ ...school.toObject(), warning });
    }

    res.status(201).json(school);
  } catch (err) {
    if (err.code === 11000) {
      const field = err.message.includes('slug') ? 'slug' : 'schoolId';
      const e = new Error(`A school with this ${field} already exists`);
      e.code = 'DUPLICATE_SCHOOL';
      e.status = 409;
      return next(e);
    }
    // Handle Mongoose validation errors
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ errors: validationErrors, code: 'VALIDATION_ERROR' });
    }
    next(err);
  }
}

// GET /api/schools
async function getAllSchools(req, res, next) {
  try {
    // ?includeInactive=true is gated by requireAdminAuth in schoolRoutes.js
    const includeInactive = req.query.includeInactive === 'true';

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const query = includeInactive ? {} : { isActive: true };
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const escaped = req.query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.name = { $regex: escaped, $options: 'i' };
    }
    const publicFields = {
      schoolId: 1,
      name: 1,
      slug: 1,
      stellarAddress: 1,
      previousStellarAddress: 1,
      network: 1,
      isActive: 1,
      adminEmail: 1,
      address: 1,
      contactEmail: 1,
      localCurrency: 1,
      timezone: 1,
      suspiciousPaymentMultiplier: 1,
      suspiciousAmountConfig: 1,
      maxPaymentMultiplier: 1,
      maxStudents: 1,
      logoUrl: 1,
      supportContact: 1,
      primaryColor: 1,
      emailLocale: 1,
      maintenanceMode: 1,
      webhookPayloadConfig: 1,
      classOptions: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const [schools, total] = await Promise.all([
      School.find(query, publicFields)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      School.countDocuments(query),
    ]);
    res.json({
      schools,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// Allow-list for the anonymous single-school endpoint. Anything not listed
// here (emails, webhook config, fraud thresholds, MFA, settings) stays private,
// including fields added to the schema in future.
const PUBLIC_SCHOOL_FIELDS = {
  schoolId: 1,
  name: 1,
  slug: 1,
  stellarAddress: 1,
  localCurrency: 1,
  timezone: 1,
  logoUrl: 1,
  primaryColor: 1,
  supportContact: 1,
  classOptions: 1,
  emailLocale: 1,
};

// GET /api/schools/:schoolId
async function getSchool(req, res, next) {
  try {
    const school = await School.findOne({
      schoolId: req.params.schoolId,
      isActive: true,
    }, PUBLIC_SCHOOL_FIELDS).lean();
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }
    res.json(school);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/schools/:schoolSlug
async function updateSchool(req, res, next) {
  try {
    const allowed = ['name', 'stellarAddress', 'network', 'adminEmail', 'address', 'suspiciousPaymentMultiplier', 'suspiciousAmountConfig', 'localCurrency', 'classOptions'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Issue #670 / #1773: Step-up authentication for stellarAddress changes
    if (updates.stellarAddress) {
      const stepUp = await verifyStepUp(req, {
        password: req.body.confirmPassword,
        mfaCode: req.body.mfaCode,
      });

      if (!stepUp.ok) {
        return res.status(403).json({
          error: 'Password confirmation required for stellarAddress change',
          code: 'STEP_UP_REQUIRED',
        });
      }
    }

    // Validate stellarAddress if being updated
    if (updates.stellarAddress && !StellarSdk.StrKey.isValidEd25519PublicKey(updates.stellarAddress)) {
      return res.status(400).json({
        error: 'stellarAddress must be a valid Stellar public key (Ed25519)',
        code: 'INVALID_STELLAR_ADDRESS',
      });
    }

    // Validate suspiciousPaymentMultiplier if being updated
    if (updates.suspiciousPaymentMultiplier !== undefined) {
      if (typeof updates.suspiciousPaymentMultiplier !== 'number' || updates.suspiciousPaymentMultiplier < 1.1 || updates.suspiciousPaymentMultiplier > 100) {
        return res.status(400).json({
          error: 'suspiciousPaymentMultiplier must be a number between 1.1 and 100',
          code: 'INVALID_SUSPICIOUS_PAYMENT_MULTIPLIER',
        });
      }
    }

    // Validate suspiciousAmountConfig if being updated
    if (updates.suspiciousAmountConfig !== undefined) {
      const cfg = updates.suspiciousAmountConfig;
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        return res.status(400).json({ error: 'suspiciousAmountConfig must be an object', code: 'INVALID_SUSPICIOUS_AMOUNT_CONFIG' });
      }
      if (cfg.mode !== undefined && !['fee_multiplier', 'historical'].includes(cfg.mode)) {
        return res.status(400).json({ error: "suspiciousAmountConfig.mode must be 'fee_multiplier' or 'historical'", code: 'INVALID_SUSPICIOUS_AMOUNT_CONFIG' });
      }
    }

    // Issue #889: Validate localCurrency against CoinGecko supported list
    if (updates.localCurrency !== undefined) {
      const { valid } = await isSupportedCurrency(updates.localCurrency);
      if (!valid) {
        return res.status(400).json({
          error: `Currency "${String(updates.localCurrency).toUpperCase()}" is not supported by the price feed. Use a valid ISO 4217 fiat code (e.g. USD, EUR, NGN).`,
          code: 'UNSUPPORTED_CURRENCY',
        });
      }
      updates.localCurrency = String(updates.localCurrency).toUpperCase();
    }

    // Issue #1337: Validate classOptions if being updated
    if (updates.classOptions !== undefined) {
      if (!Array.isArray(updates.classOptions) || updates.classOptions.length === 0) {
        return res.status(400).json({
          error: 'classOptions must be a non-empty array of class/grade names',
          code: 'INVALID_CLASS_OPTIONS',
        });
      }
      if (!updates.classOptions.every(opt => typeof opt === 'string' && opt.trim().length > 0)) {
        return res.status(400).json({
          error: 'All classOptions must be non-empty strings',
          code: 'INVALID_CLASS_OPTIONS',
        });
      }
      updates.classOptions = updates.classOptions.map(opt => opt.trim());
    }

    const original = await School.findOne({ schoolId: req.params.schoolId, isActive: true }).lean();
    if (!original) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    // Verify Stellar account funding if address is being updated (non-blocking)
    let warning = null;
    if (updates.stellarAddress) {
      const { warning: fundingWarning } = await verifyStellarAccountFunding(updates.stellarAddress);
      warning = fundingWarning;
    }

    // Changing the address through this route is a rotation too: retire the
    // old address and start the new cursor at its current ledger (#1799).
    if (updates.stellarAddress && updates.stellarAddress !== original.stellarAddress) {
      let rotation;
      try {
        rotation = await buildWalletRotation(original, updates.stellarAddress);
      } catch {
        return res.status(503).json({
          error: 'Could not read the new wallet\'s transaction history from Horizon. Retry the change.',
          code: 'HORIZON_UNAVAILABLE',
        });
      }
      updates.syncCursor = rotation.syncCursor;
      updates.walletActiveFrom = rotation.walletActiveFrom;
      updates.$push = { walletHistory: rotation.retired };
    }

    const school = await School.findOneAndUpdate(
      { schoolId: req.params.schoolId, isActive: true },
      updates,
      { new: true, runValidators: true }
    );

    // Drop the stale lean copy on every replica so the rotated address /
    // changed config is served within seconds, not after the 5-minute TTL.
    schoolCache.invalidate(school);

    // Audit log — mark stellarAddress changes as high-severity
    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: updates.stellarAddress ? 'school_update_stellar_address' : 'school_update',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { 
          before: original, 
          after: updates,
          severity: updates.stellarAddress ? 'high' : 'normal',
        },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    // Return 202 with warning if account is unfunded
    if (warning) {
      return res.status(202).json({ ...school.toObject(), warning });
    }

    res.json(school);
  } catch (err) {
    // Handle Mongoose validation errors
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ errors: validationErrors, code: 'VALIDATION_ERROR' });
    }
    next(err);
  }
}

// PUT /api/schools/:schoolId/stellar-address
// Issue #1387: a dedicated, audited wallet-rotation endpoint. Requires the
// same step-up password confirmation as the stellarAddress path in
// updateSchool() above, plus a mandatory `reason` — rotating a school's
// payment-receiving wallet has no legitimate "no reason given" case, and the
// reason is what makes the audit trail (and docs/runbooks/wallet-rotation.md)
// useful during an incident review.
async function rotateStellarAddress(req, res, next) {
  try {
    const { stellarAddress, reason, confirmPassword, backfill } = req.body || {};

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        error: 'A reason is required when rotating a school\'s Stellar wallet address.',
        code: 'REASON_REQUIRED',
      });
    }

    if (!stellarAddress || !StellarSdk.StrKey.isValidEd25519PublicKey(stellarAddress)) {
      return res.status(400).json({
        error: 'stellarAddress must be a valid Stellar public key (Ed25519)',
        code: 'INVALID_STELLAR_ADDRESS',
      });
    }

    // Step-up authentication — same pattern as updateSchool()'s stellarAddress
    // path: a valid admin session alone (requireAdminAuth) is not sufficient
    // to move where a school's fee payments are received.
    const stepUp = await verifyStepUp(req, {
      password: confirmPassword,
      mfaCode: req.body && req.body.mfaCode,
    });

    if (!stepUp.ok) {
      return res.status(403).json({
        error: 'Password confirmation required for stellarAddress rotation',
        code: 'STEP_UP_REQUIRED',
      });
    }

    const school = await School.findOne({ schoolId: req.params.schoolId, isActive: true });
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    if (school.stellarAddress === stellarAddress) {
      return res.status(400).json({
        error: 'New stellarAddress must differ from the current address',
        code: 'STELLAR_ADDRESS_UNCHANGED',
      });
    }

    const previousStellarAddress = school.stellarAddress;

    // Verify the new Stellar account is funded (non-blocking — same as
    // updateSchool()'s stellarAddress path).
    const { warning } = await verifyStellarAccountFunding(stellarAddress);

    // The new address starts at its current ledger, so an existing account's
    // history is not replayed; `backfill: true` opts in to a full replay (#1799).
    let rotation;
    try {
      rotation = await buildWalletRotation(school, stellarAddress, { backfill: backfill === true });
    } catch {
      return res.status(503).json({
        error: 'Could not read the new wallet\'s transaction history from Horizon. Retry the rotation.',
        code: 'HORIZON_UNAVAILABLE',
      });
    }

    // The old address stays in walletHistory and keeps being polled until its
    // drain window closes (docs/runbooks/wallet-rotation.md).
    school.walletHistory.push(rotation.retired);
    school.previousStellarAddress = previousStellarAddress;
    school.stellarAddress = stellarAddress;
    school.syncCursor = rotation.syncCursor;
    school.walletActiveFrom = rotation.walletActiveFrom;
    // The new wallet's pre-existing history must not be credited as fees (#1818).
    school.ingestStartsAt = new Date();
    await school.save();

    schoolCache.invalidate(school);

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_stellar_address_rotated',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: {
          previousStellarAddress,
          newStellarAddress: stellarAddress,
          drainUntil: rotation.retired.drainUntil,
          backfill: backfill === true,
          reason: reason.trim(),
          severity: 'high',
        },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    if (warning) {
      return res.status(202).json({ ...school.toObject(), warning });
    }

    res.json(school);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ errors: validationErrors, code: 'VALIDATION_ERROR' });
    }
    next(err);
  }
}

// PUT /api/schools/:schoolId/webhook-secret
// Issue #1412: regenerating the webhook secret controls webhook signature
// verification, so — like stellarAddress — it requires the same step-up
// password confirmation before a new session-hijacked admin can silently
// take over webhook delivery for a school.
//
// DEPRECATED (#1640): School.webhookSecret no longer exists. This rotates the
// secret of the school's legacy WebhookEndpoint (with the same dual-signing
// overlap as POST /api/webhook-endpoints/:id/rotate-secret). Will be removed
// in the next release.
async function rotateWebhookSecret(req, res, next) {
  try {
    setWebhookDeprecationHeaders(res);
    const { confirmPassword, mfaCode, overlapSeconds } = req.body || {};

    const stepUp = await verifyStepUp(req, { password: confirmPassword, mfaCode });

    if (!stepUp.ok) {
      return res.status(403).json({
        error: 'Password confirmation required for webhookSecret rotation',
        code: 'STEP_UP_REQUIRED',
      });
    }

    const school = await School.findOne({ schoolId: req.params.schoolId, isActive: true });
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    const overlap = parseOverlapSeconds(overlapSeconds);
    if (!overlap.ok) {
      return res.status(400).json({ error: overlap.error, code: 'VALIDATION_ERROR' });
    }

    const endpoint = await findLegacySchoolEndpoint(school.schoolId, { withSecrets: true });
    if (!endpoint) {
      return res.status(404).json({
        error: 'No school webhook is registered. Manage webhooks via /api/webhook-endpoints.',
        code: 'NOT_FOUND',
      });
    }

    const newSecret = generateWebhookSecret();
    applySecretRotation(endpoint, newSecret, overlap.value);
    await endpoint.save();

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_webhook_secret_rotated',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: {
          severity: 'high',
          endpointId: String(endpoint._id),
          overlapSeconds: overlap.value,
          previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
          deprecatedRoute: true,
        },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    // The plaintext secret is only ever returned once, at rotation time — it
    // is encrypted at rest (webhookEndpointModel's pre-save hook).
    res.json({
      webhookSecret: newSecret,
      endpointId: String(endpoint._id),
      previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
      deprecated: true,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/schools/:schoolId/deactivate
// Single code path for soft-deactivating a school. Side effects:
//   - sets isActive=false
//   - writes a school_deactivate audit log entry
//   - invalidates the school cache so requests for it are blocked at once
async function deactivateSchool(req, res, next) {
  try {
    const school = await School.findOneAndUpdate(
      { schoolId: req.params.schoolId },
      { isActive: false },
      { new: true }
    );
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_deactivate',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { name: school.name, slug: school.slug },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    schoolCache.invalidate(school);
    res.json({ message: `School "${school.name}" deactivated`, schoolId: school.schoolId, isActive: false });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/schools/:schoolId — deprecated alias for PATCH /:schoolId/deactivate
function deprecatedDeleteSchool(req, res, next) {
  res.set('Deprecation', 'true');
  res.set('Link', `</api/schools/${req.params.schoolId}/deactivate>; rel="successor-version"`);
  return deactivateSchool(req, res, next);
}

// PATCH /api/schools/:schoolId/activate
async function activateSchool(req, res, next) {
  try {
    const school = await School.findOneAndUpdate(
      { schoolId: req.params.schoolId },
      { isActive: true },
      { new: true }
    );
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_activate',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { name: school.name, slug: school.slug },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    schoolCache.invalidate(school);
    res.json({ message: `School "${school.name}" activated`, schoolId: school.schoolId, isActive: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/schools/:slug/webhooks
//
// DEPRECATED (#1640): WebhookEndpoint is the only webhook configuration model.
// This route now creates (or re-points) the school's legacy WebhookEndpoint,
// subscribed to the events the old School.webhookUrl path delivered, and
// answers with a Deprecation header. Will be removed in the next release —
// use POST /api/webhook-endpoints.
async function registerWebhook(req, res, next) {
  try {
    setWebhookDeprecationHeaders(res);
    const { webhookUrl } = req.body;

    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return res.status(400).json({ error: 'webhookUrl is required', code: 'VALIDATION_ERROR' });
    }

    const validation = await validateWebhookUrl(webhookUrl);
    if (!validation.valid) {
      return res.status(400).json({ error: 'webhookUrl must use https:// and resolve to a public IP address', code: 'INVALID_WEBHOOK_URL' });
    }

    const school = await School.findOne({ slug: req.params.slug, isActive: true });

    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    const { endpoint, created, secret } = await upsertLegacySchoolEndpoint({
      schoolId: school.schoolId,
      url: webhookUrl,
      createdBy: req.auditContext?.performedBy || null,
    });

    if (req.auditContext) {
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_webhook_register',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { webhookUrl, endpointId: String(endpoint._id), created, deprecatedRoute: true },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    const body = {
      webhookUrl: endpoint.url,
      endpointId: String(endpoint._id),
      subscribedEvents: endpoint.subscribedEvents,
      deprecated: true,
    };
    // A newly created endpoint's secret is returned once, like
    // POST /api/webhook-endpoints.
    if (created) body.webhookSecret = secret;
    res.status(created ? 201 : 200).json(body);
  } catch (err) {
    next(err);
  }
}

// GET /api/schools/:schoolId/settings
async function getSchoolSettings(req, res, next) {
  try {
    const { getSchoolSettings } = require('../services/schoolSettingsService');
    const school = await School.findOne({ schoolId: req.params.schoolId, isActive: true }, { schoolId: 1 }).lean();
    if (!school) return next(Object.assign(new Error('School not found'), { code: 'NOT_FOUND' }));
    const settings = await getSchoolSettings(school.schoolId);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/schools/:schoolId/settings
async function updateSchoolSettings(req, res, next) {
  try {
    const { setSchoolSetting, SETTING_KEYS } = require('../services/schoolSettingsService');
    const school = await School.findOne({ schoolId: req.params.schoolId, isActive: true }, { schoolId: 1 }).lean();
    if (!school) return next(Object.assign(new Error('School not found'), { code: 'NOT_FOUND' }));

    const updated = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (SETTING_KEYS.has(key)) {
        await setSchoolSetting(school.schoolId, key, value);
        updated[key] = value;
      }
    }

    if (req.auditContext) {
      const { logAudit } = require('../services/auditService');
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_settings_update',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { updated },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ updated });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/schools/:schoolId/settings/:key
async function clearSchoolSetting(req, res, next) {
  try {
    const { clearSchoolSetting, SETTING_KEYS } = require('../services/schoolSettingsService');
    const school = await School.findOne({ schoolId: req.params.schoolId, isActive: true }, { schoolId: 1 }).lean();
    if (!school) return next(Object.assign(new Error('School not found'), { code: 'NOT_FOUND' }));

    const { key } = req.params;
    if (!SETTING_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}`, code: 'INVALID_SETTING_KEY' });
    }

    await clearSchoolSetting(school.schoolId, key);

    if (req.auditContext) {
      const { logAudit } = require('../services/auditService');
      await logAudit({
        schoolId: school.schoolId,
        action: 'school_settings_clear',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { key },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ message: `Setting "${key}" cleared for school`, schoolId: req.params.schoolId });
  } catch (err) {
    next(err);
  }
}

module.exports = { createSchool, getAllSchools, getSchool, updateSchool, rotateStellarAddress, rotateWebhookSecret, deactivateSchool, deprecatedDeleteSchool, activateSchool, registerWebhook, getSchoolSettings, updateSchoolSettings, clearSchoolSetting };
