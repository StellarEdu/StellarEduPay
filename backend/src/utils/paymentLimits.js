'use strict';

/**
 * ROUNDING POLICY (Issue #751)
 * ─────────────────────────────────────────────────────────────────────────────
 * Monetary comparisons use Decimal to avoid IEEE-754 drift.
 *   XLM  — 7 decimal places (Stellar on-chain precision)
 *   USDC — 7 decimal places
 *   Fiat — 2 decimal places
 *
 * Rule: never use raw JS Number arithmetic on monetary values. Use Decimal for
 * all comparisons and arithmetic; convert to Number only at output boundaries.
 *
 * LIMIT SOURCE (Issue #1117)
 * ─────────────────────────────────────────────────────────────────────────────
 * Limits used to be read once from MIN_PAYMENT_AMOUNT / MAX_PAYMENT_AMOUNT at
 * module load, so changing them meant a redeploy. They now resolve per call via
 * paymentLimitsService, which reads database-backed values and falls back to
 * those same env vars — a deployment that never uses the admin API keeps its
 * existing behaviour exactly.
 *
 * This made validatePaymentAmount async. Every caller was already inside an
 * async function, so the change is an added `await` at each site.
 */

const Decimal = require('decimal.js');
const {
  resolveLimits,
  compareAgainstLimits,
} = require('../services/paymentLimitsService');
const { paymentLimitTriggeredTotal } = require('../metrics');
const logger = require('./logger').child('PaymentLimits');

/**
 * Validate an amount against the effective limits for a school and asset.
 *
 * @param {number} amount
 * @param {object} [context]
 * @param {string} [context.schoolId] - Scopes to a school's override
 * @param {string} [context.asset]    - Asset code, e.g. 'XLM'
 * @returns {Promise<{valid: boolean, error?: string, code?: string}>}
 */
async function validatePaymentAmount(amount, { schoolId, asset } = {}) {
  const limits = await resolveLimits({ schoolId, asset });
  const result = compareAgainstLimits(amount, limits);

  if (!result.valid) {
    try {
      paymentLimitTriggeredTotal.inc({
        school_id: schoolId || 'unknown',
        asset: (asset || 'XLM').toUpperCase(),
        code: result.code,
      });
    } catch (err) {
      // Never let a metrics failure reject a payment that the limits allow, or
      // vice versa — observability is not in the correctness path.
      logger.warn('Failed to record payment limit metric', { err: err.message });
    }
  }

  return result;
}

function validatePaymentAmountAgainstFee(paymentAmount, feeAmount, maxPaymentMultiplier = 3.0) {
  const dPayment = new Decimal(typeof paymentAmount === 'number' && isFinite(paymentAmount) ? paymentAmount : NaN);
  const dFee    = new Decimal(typeof feeAmount    === 'number' && isFinite(feeAmount)    ? feeAmount    : NaN);

  if (!dPayment.isFinite() || dPayment.lte(0))
    return { valid: false, error: 'Payment amount must be a valid positive number', code: 'INVALID_AMOUNT' };
  if (!dFee.isFinite() || dFee.lte(0))
    return { valid: false, error: 'Fee amount must be a valid positive number', code: 'INVALID_FEE' };

  const maxAllowed = dFee.mul(new Decimal(maxPaymentMultiplier));
  if (dPayment.gt(maxAllowed))
    return { valid: false, error: `Payment amount ${paymentAmount} exceeds the maximum of ${maxAllowed.toNumber()} (${maxPaymentMultiplier}× the fee)`, code: 'AMOUNT_TOO_HIGH' };
  return { valid: true };
}

/**
 * The effective limits, for display in payment instructions.
 *
 * @param {object} [context]
 * @param {string} [context.schoolId]
 * @param {string} [context.asset]
 * @returns {Promise<{min: number, max: number}>}
 */
async function getPaymentLimits({ schoolId, asset } = {}) {
  const { min, max } = await resolveLimits({ schoolId, asset });
  return { min, max };
}

module.exports = { validatePaymentAmount, validatePaymentAmountAgainstFee, getPaymentLimits };
