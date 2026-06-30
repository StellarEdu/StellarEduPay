'use strict';

const crypto = require('crypto');
const StellarSdk = require('@stellar/stellar-sdk');
const School = require('../models/schoolModel');
const { logAudit } = require('../services/auditService');
const { verifyStellarAccountFunding } = require('../services/stellarAccountVerificationService');
const { validateWebhookUrl } = require('../utils/validateWebhookUrl');
const schoolCache = require('../services/schoolCacheInvalidator');
const { isSupportedCurrency } = require('../services/currencyConversionService');

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
    const { isFunded, warning } = await verifyStellarAccountFunding(stellarAddress);

    const schoolId = `SCH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const school = await School.create({
      schoolId,
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      stellarAddress,
      network: network || 'testnet',
      adminEmail: adminEmail || null,
      address: address || null,
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
    const includeInactive = req.query.includeInactive === 'true';

    // ?includeInactive=true is admin-only — verify JWT inline
    if (includeInactive) {
      const jwt = require('jsonwebtoken');
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required to include inactive schools.', code: 'MISSING_AUTH_TOKEN' });
      }
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        if (decoded.role !== 'admin') {
          return res.status(403).json({ error: 'Admin role required to include inactive schools.', code: 'INSUFFICIENT_ROLE' });
        }
      } catch {
        return res.status(401).json({ error: 'Invalid token.', code: 'INVALID_AUTH_TOKEN' });
      }
    }

    const query = includeInactive ? {} : { isActive: true };
    const schools = await School.find(query).sort({ name: 1 }).lean();
    res.json(schools);
  } catch (err) {
    next(err);
  }
}

// GET /api/schools/:schoolSlug
async function getSchool(req, res, next) {
  try {
    const school = await School.findOne({
      slug: req.params.schoolSlug.toLowerCase(),
      isActive: true,
    }, {
      jwtSecret: 0,
      webhookSecret: 0,
      internalNotes: 0,
    }).lean();
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
    const allowed = ['name', 'stellarAddress', 'network', 'adminEmail', 'address', 'suspiciousPaymentMultiplier', 'suspiciousAmountConfig', 'localCurrency'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Issue #670: Step-up authentication for stellarAddress changes
    if (updates.stellarAddress) {
      const expectedPassword = process.env.ADMIN_PASSWORD;
      const providedPassword = req.body.confirmPassword;

      if (!expectedPassword || !providedPassword) {
        return res.status(403).json({
          error: 'Password confirmation required for stellarAddress change',
          code: 'STEP_UP_REQUIRED',
        });
      }

      // Constant-time comparison to prevent timing attacks
      const crypto = require('crypto');
      const bufExpected = Buffer.from(expectedPassword);
      const bufProvided = Buffer.from(providedPassword);
      
      if (bufExpected.length !== bufProvided.length || !crypto.timingSafeEqual(bufExpected, bufProvided)) {
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

    const original = await School.findOne({ slug: req.params.schoolSlug.toLowerCase(), isActive: true }).lean();
    if (!original) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    // Verify Stellar account funding if address is being updated (non-blocking)
    let warning = null;
    if (updates.stellarAddress) {
      const { isFunded, warning: fundingWarning } = await verifyStellarAccountFunding(updates.stellarAddress);
      warning = fundingWarning;
    }

    const school = await School.findOneAndUpdate(
      { slug: req.params.schoolSlug.toLowerCase(), isActive: true },
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

// DELETE /api/schools/:schoolSlug  (soft-delete)
async function deactivateSchool(req, res, next) {
  try {
    const school = await School.findOneAndUpdate(
      { slug: req.params.schoolSlug.toLowerCase() },
      { isActive: false },
      { new: true }
    );
    if (!school) {
      const e = new Error('School not found');
      e.code = 'NOT_FOUND';
      return next(e);
    }

    // Drop the cached copy everywhere so deactivation blocks requests at once.
    schoolCache.invalidate(school);

    // Audit log
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

    res.json({ message: `School "${school.name}" deactivated` });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/schools/:schoolSlug/deactivate
async function deactivateSchoolEndpoint(req, res, next) {
  try {
    const school = await School.findOneAndUpdate(
      { slug: req.params.schoolSlug.toLowerCase() },
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

// PATCH /api/schools/:schoolSlug/activate
async function activateSchool(req, res, next) {
  try {
    const school = await School.findOneAndUpdate(
      { slug: req.params.schoolSlug.toLowerCase() },
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
async function registerWebhook(req, res, next) {
  try {
    const { webhookUrl } = req.body;

    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return res.status(400).json({ error: 'webhookUrl is required', code: 'VALIDATION_ERROR' });
    }

    const validation = await validateWebhookUrl(webhookUrl);
    if (!validation.valid) {
      return res.status(400).json({ error: 'webhookUrl must use https:// and resolve to a public IP address', code: 'INVALID_WEBHOOK_URL' });
    }

    const school = await School.findOneAndUpdate(
      { slug: req.params.slug, isActive: true },
      { webhookUrl },
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
        action: 'school_webhook_register',
        performedBy: req.auditContext.performedBy,
        targetId: school.schoolId,
        targetType: 'school',
        details: { webhookUrl },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    schoolCache.invalidate(school);
    res.json({ webhookUrl: school.webhookUrl });
  } catch (err) {
    next(err);
  }
}

// GET /api/schools/:schoolSlug/settings
async function getSchoolSettings(req, res, next) {
  try {
    const { getSchoolSettings } = require('../services/schoolSettingsService');
    const school = await School.findOne({ slug: req.params.schoolSlug.toLowerCase(), isActive: true }, { schoolId: 1 }).lean();
    if (!school) return next(Object.assign(new Error('School not found'), { code: 'NOT_FOUND' }));
    const settings = await getSchoolSettings(school.schoolId);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/schools/:schoolSlug/settings
async function updateSchoolSettings(req, res, next) {
  try {
    const { setSchoolSetting, SETTING_KEYS } = require('../services/schoolSettingsService');
    const school = await School.findOne({ slug: req.params.schoolSlug.toLowerCase(), isActive: true }, { schoolId: 1 }).lean();
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

// DELETE /api/schools/:schoolSlug/settings/:key
async function clearSchoolSetting(req, res, next) {
  try {
    const { clearSchoolSetting, SETTING_KEYS } = require('../services/schoolSettingsService');
    const school = await School.findOne({ slug: req.params.schoolSlug.toLowerCase(), isActive: true }, { schoolId: 1 }).lean();
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

    res.json({ message: `Setting "${key}" cleared for school`, schoolSlug: req.params.schoolSlug });
  } catch (err) {
    next(err);
  }
}

module.exports = { createSchool, getAllSchools, getSchool, updateSchool, deactivateSchool, deactivateSchoolEndpoint, activateSchool, registerWebhook, getSchoolSettings, updateSchoolSettings, clearSchoolSetting };
