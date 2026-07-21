'use strict';

/**
 * Payment limits resolution (#1117).
 *
 * Limits are a fraud-prevention control, so they need to be tunable while an
 * incident is in progress — not on the next deploy. They now resolve from the
 * database with the environment variables as a fallback, and an admin can
 * change them at runtime through /api/admin/payment-limits.
 *
 * Resolution order, most specific first:
 *
 *   1. School.settings.paymentLimits.assets[ASSET]   per-school, per-asset
 *   2. School.settings.paymentLimits.default         per-school
 *   3. SystemConfig 'paymentLimits'.assets[ASSET]    global, per-asset
 *   4. SystemConfig 'paymentLimits'.default          global
 *   5. MIN_PAYMENT_AMOUNT / MAX_PAYMENT_AMOUNT       env, the pre-#1117 behaviour
 *
 * Falling through to the env values means a deployment that never touches the
 * admin API behaves exactly as it did before this change.
 *
 * Per-asset matters because XLM and USDC occupy very different value ranges: a
 * ceiling that is sane for XLM is absurd for USDC and vice versa. A deployment
 * accepts one asset at a time today (see ACCEPTED_ASSETS), so the asset key is
 * mostly future-proofing — but storing limits without it would bake the same
 * conflation back into the config model that this issue is about.
 *
 * CACHING — resolution sits in the payment hot path, so results are cached in
 * process for CACHE_TTL_MS. Writes through this module invalidate immediately,
 * so the instance serving the admin request is correct at once; other instances
 * converge within the TTL. That bounded staleness is the cost of not doing a
 * database read per payment, and it is still a different order of magnitude
 * from requiring a redeploy.
 */

const Decimal = require('decimal.js');
const School = require('../models/schoolModel');
const SystemConfig = require('../models/systemConfigModel');
const { MIN_PAYMENT_AMOUNT, MAX_PAYMENT_AMOUNT } = require('../config');
const logger = require('../utils/logger').child('PaymentLimits');

const CONFIG_KEY = 'paymentLimits';
const CACHE_TTL_MS = parseInt(process.env.PAYMENT_LIMITS_CACHE_TTL_MS || '30000', 10);
const DEFAULT_ASSET = 'XLM';

// Resolution sits in the payment verification path, so the database read must
// be bounded. Mongoose *buffers* commands while disconnected rather than
// rejecting them, so without this a brief database outage would hang payment
// verification instead of falling back to the env limits.
const READ_TIMEOUT_MS = parseInt(process.env.PAYMENT_LIMITS_READ_TIMEOUT_MS || '2000', 10);

class LimitsReadTimeout extends Error {
  constructor() {
    super(`Payment limits read exceeded ${READ_TIMEOUT_MS}ms`);
    this.name = 'LimitsReadTimeout';
  }
}

function _withTimeout(promise) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new LimitsReadTimeout()), READ_TIMEOUT_MS);
    // Do not hold the event loop open on this timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** @type {Map<string, {value: object, expiresAt: number}>} */
const _cache = new Map();

const ENV_LIMITS = Object.freeze({
  min: MIN_PAYMENT_AMOUNT,
  max: MAX_PAYMENT_AMOUNT,
  source: 'env',
});

function _now() {
  return Date.now();
}

function _cacheKey(schoolId) {
  return schoolId || '__global__';
}

function _readCache(schoolId) {
  const hit = _cache.get(_cacheKey(schoolId));
  if (!hit || hit.expiresAt <= _now()) return null;
  return hit.value;
}

function _writeCache(schoolId, value) {
  _cache.set(_cacheKey(schoolId), { value, expiresAt: _now() + CACHE_TTL_MS });
}

/**
 * Drop cached limits. Called after every write so the writing instance never
 * serves the value it just replaced.
 *
 * @param {string} [schoolId] - Omit to clear every entry.
 */
function invalidateCache(schoolId) {
  if (schoolId === undefined) _cache.clear();
  else _cache.delete(_cacheKey(schoolId));
}

/**
 * Validate a { min, max } pair before it is stored or trusted.
 * Rejects the same conditions config/index.js enforces for the env values, so
 * a bad admin write cannot put the system in a state a fresh boot would refuse.
 *
 * @param {object} limits
 * @returns {{valid: boolean, error?: string}}
 */
function validateLimitPair(limits) {
  if (!limits || typeof limits !== 'object') {
    return { valid: false, error: 'Limits must be an object with min and max' };
  }
  const { min, max } = limits;
  for (const [name, value] of [['min', min], ['max', max]]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { valid: false, error: `${name} must be a finite number` };
    }
  }
  if (min < 0) return { valid: false, error: 'min must not be negative' };
  if (max <= min) return { valid: false, error: 'max must be greater than min' };
  return { valid: true };
}

/**
 * Validate a full limits document ({ default, assets }) before storing it.
 *
 * @param {object} doc
 * @returns {{valid: boolean, error?: string}}
 */
function validateLimitsDocument(doc) {
  if (!doc || typeof doc !== 'object') {
    return { valid: false, error: 'Payment limits must be an object' };
  }
  if (doc.default !== undefined) {
    const check = validateLimitPair(doc.default);
    if (!check.valid) return { valid: false, error: `default: ${check.error}` };
  }
  if (doc.assets !== undefined) {
    if (typeof doc.assets !== 'object' || doc.assets === null || Array.isArray(doc.assets)) {
      return { valid: false, error: 'assets must be an object keyed by asset code' };
    }
    for (const [code, pair] of Object.entries(doc.assets)) {
      const check = validateLimitPair(pair);
      if (!check.valid) return { valid: false, error: `assets.${code}: ${check.error}` };
    }
  }
  if (doc.default === undefined && doc.assets === undefined) {
    return { valid: false, error: 'Provide at least one of default or assets' };
  }
  return { valid: true };
}

function _pick(doc, asset, source) {
  if (!doc || typeof doc !== 'object') return null;

  const assetKey = asset ? String(asset).toUpperCase() : null;
  if (assetKey && doc.assets && doc.assets[assetKey]) {
    const pair = doc.assets[assetKey];
    if (validateLimitPair(pair).valid) {
      return { min: pair.min, max: pair.max, source: `${source}:asset:${assetKey}` };
    }
    logger.warn('Stored per-asset payment limits are invalid; ignoring', { source, asset: assetKey });
  }

  if (doc.default && validateLimitPair(doc.default).valid) {
    return { min: doc.default.min, max: doc.default.max, source: `${source}:default` };
  }
  if (doc.default) {
    logger.warn('Stored default payment limits are invalid; ignoring', { source });
  }
  return null;
}

/**
 * Resolve the effective limits for a school and asset.
 *
 * Never throws: a database failure falls back to the env limits rather than
 * failing open. Losing the ability to read a tightened limit must not turn into
 * accepting an unbounded payment.
 *
 * @param {object} [opts]
 * @param {string} [opts.schoolId]
 * @param {string} [opts.asset] - Asset code, e.g. 'XLM'
 * @returns {Promise<{min: number, max: number, source: string}>}
 */
async function resolveLimits({ schoolId, asset } = {}) {
  const assetKey = (asset || DEFAULT_ASSET).toUpperCase();
  const cached = _readCache(schoolId);
  if (cached) {
    return _pick(cached.school, assetKey, 'school')
      || _pick(cached.system, assetKey, 'system')
      || ENV_LIMITS;
  }

  let schoolDoc = null;
  let systemDoc = null;

  try {
    if (schoolId) {
      const school = await _withTimeout(School.findOne({ schoolId }, { settings: 1 }).lean());
      schoolDoc = school?.settings?.paymentLimits || null;
    }
    systemDoc = await _withTimeout(SystemConfig.get(CONFIG_KEY));
  } catch (err) {
    // Fail closed onto the env limits — see the note above. A timeout lands
    // here too, so a slow or disconnected database degrades to the previous
    // behaviour instead of stalling payment verification.
    logger.error('Failed to load payment limits; falling back to env values', {
      err: err.message,
      schoolId,
    });
    return ENV_LIMITS;
  }

  _writeCache(schoolId, { school: schoolDoc, system: systemDoc });

  return _pick(schoolDoc, assetKey, 'school')
    || _pick(systemDoc, assetKey, 'system')
    || ENV_LIMITS;
}

/**
 * Read the stored limits documents without applying resolution, for the admin
 * UI — an operator needs to see which layer a value actually comes from.
 *
 * @param {string} [schoolId]
 * @returns {Promise<{system: object|null, school: object|null, env: object}>}
 */
async function getStoredLimits(schoolId) {
  const system = await SystemConfig.get(CONFIG_KEY);
  let school = null;
  if (schoolId) {
    const doc = await School.findOne({ schoolId }, { settings: 1 }).lean();
    school = doc?.settings?.paymentLimits || null;
  }
  return { system: system || null, school, env: { ...ENV_LIMITS } };
}

/**
 * Replace the global limits document.
 *
 * @param {object} doc - { default?: {min,max}, assets?: {CODE: {min,max}} }
 * @returns {Promise<object>} The stored document
 */
async function setSystemLimits(doc) {
  const check = validateLimitsDocument(doc);
  if (!check.valid) {
    throw Object.assign(new Error(check.error), { code: 'INVALID_PAYMENT_LIMITS' });
  }
  await SystemConfig.set(CONFIG_KEY, doc);
  // Global change affects every school's resolution, so drop the whole cache.
  invalidateCache();
  return doc;
}

/**
 * Replace one school's limits document.
 *
 * @param {string} schoolId
 * @param {object} doc
 * @returns {Promise<object>} The stored document
 */
async function setSchoolLimits(schoolId, doc) {
  const check = validateLimitsDocument(doc);
  if (!check.valid) {
    throw Object.assign(new Error(check.error), { code: 'INVALID_PAYMENT_LIMITS' });
  }
  const updated = await School.findOneAndUpdate(
    { schoolId },
    { $set: { 'settings.paymentLimits': doc } },
    { new: true },
  ).lean();
  if (!updated) {
    throw Object.assign(new Error(`School ${schoolId} not found`), { code: 'NOT_FOUND' });
  }
  invalidateCache(schoolId);
  return doc;
}

/**
 * Remove a school's override so it falls back to the global limits.
 *
 * @param {string} schoolId
 */
async function clearSchoolLimits(schoolId) {
  const updated = await School.findOneAndUpdate(
    { schoolId },
    { $unset: { 'settings.paymentLimits': '' } },
    { new: true },
  ).lean();
  if (!updated) {
    throw Object.assign(new Error(`School ${schoolId} not found`), { code: 'NOT_FOUND' });
  }
  invalidateCache(schoolId);
}

/**
 * Compare an amount against resolved limits using Decimal, per the rounding
 * policy in utils/paymentLimits.js.
 *
 * @param {number} amount
 * @param {{min: number, max: number}} limits
 * @returns {{valid: boolean, error?: string, code?: string}}
 */
function compareAgainstLimits(amount, limits) {
  const d = new Decimal(typeof amount === 'number' && isFinite(amount) ? amount : NaN);
  if (!d.isFinite() || d.lte(0)) {
    return { valid: false, error: 'Payment amount must be a valid positive number', code: 'INVALID_AMOUNT' };
  }
  if (d.lt(new Decimal(limits.min))) {
    return { valid: false, error: `Payment amount ${amount} is below the minimum of ${limits.min}`, code: 'AMOUNT_TOO_LOW' };
  }
  if (d.gt(new Decimal(limits.max))) {
    return { valid: false, error: `Payment amount ${amount} exceeds the maximum of ${limits.max}`, code: 'AMOUNT_TOO_HIGH' };
  }
  return { valid: true };
}

module.exports = {
  CONFIG_KEY,
  resolveLimits,
  getStoredLimits,
  setSystemLimits,
  setSchoolLimits,
  clearSchoolLimits,
  invalidateCache,
  validateLimitPair,
  validateLimitsDocument,
  compareAgainstLimits,
  _ENV_LIMITS: ENV_LIMITS,
};
