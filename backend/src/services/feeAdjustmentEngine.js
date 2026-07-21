'use strict';

/**
 * ROUNDING POLICY (Issue #751)
 * ─────────────────────────────────────────────────────────────────────────────
 * All monetary arithmetic in this engine uses decimal.js (Decimal) to avoid
 * IEEE-754 floating-point drift.
 *
 * Scale and rounding mode per asset:
 *   XLM  — 7 decimal places, ROUND_HALF_UP (Stellar native precision)
 *   USDC — 7 decimal places, ROUND_HALF_UP (stablecoin, same on-chain scale)
 *   Fiat — 2 decimal places, ROUND_HALF_UP (standard currency display)
 *
 * Rule: NO raw JS Number arithmetic (+, -, *, /) on monetary values anywhere
 * in the fee/payment path. Always construct `new Decimal(value)` and chain
 * Decimal operations; convert back to Number only at the final output boundary
 * via `.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()`.
 */

const Decimal = require('decimal.js');
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const logger = require('../utils/logger');

/**
 * Dynamic Fee Adjustment Engine
 * 
 * Handles flexible discounts, penalties, and promotions for StellarEduPay payments.
 * This engine is used during payment validation to calculate the final fee.
 */

class DynamicFeeAdjustmentEngine {
  constructor() {
    this.rules = [];
    this.loadDefaultRules();
  }

  /**
   * Load default fee adjustment rules
   */
  loadDefaultRules() {
    this.rules = [
      {
        id: 'early-payment',
        name: 'Early Payment Discount',
        type: 'discount',
        condition: (ctx) => ctx.isEarly === true,
        value: 15,                    // 15% discount
        priority: 10,
        description: '15% discount for payments made at least 7 days in advance',
      },
      {
        id: 'student-discount',
        name: 'Student Discount',
        type: 'discount',
        condition: (ctx) => ctx.userType === 'student',
        value: 20,                    // 20% discount
        priority: 8,
        description: '20% discount for verified students',
      },
      {
        id: 'late-penalty',
        name: 'Late Payment Penalty',
        type: 'penalty',
        condition: (ctx) => ctx.isLate === true,
        value: 12,                    // 12% penalty
        priority: 15,
        description: '12% penalty for late payments',
      },
      {
        id: 'volume-discount',
        name: 'Volume Discount',
        type: 'discount',
        condition: (ctx) => ctx.totalPaymentsThisMonth >= 3,
        value: 10,                    // 10% discount
        priority: 12,
        description: '10% discount for 3 or more payments in a month',
      },
      {
        id: 'promo-edu2026',
        name: 'Promo Code Discount',
        type: 'discount',
        condition: (ctx) => ctx.promoCode && ctx.promoCode.toUpperCase() === 'EDU2026',
        value: 25,                    // 25% discount
        priority: 5,
        description: 'Special 25% discount with promo code EDU2026',
      },
    ];

    // Sort rules by priority (highest priority applied first)
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Add a new custom rule dynamically.
   * Validates required fields. Percentage discounts may exceed 100 — the
   * resulting negative fee is clamped to 0 in calculateFee (with a warning).
   * @param {Object} rule
   */
  addRule(rule) {
    if (!rule || typeof rule !== 'object') throw new Error('rule must be an object');
    if (!rule.id || typeof rule.id !== 'string') throw new Error('rule.id is required');
    if (!rule.name || typeof rule.name !== 'string') throw new Error('rule.name is required');
    if (!['discount', 'penalty'].includes(rule.type)) throw new Error('rule.type must be "discount" or "penalty"');
    if (typeof rule.value !== 'number' || rule.value < 0) throw new Error('rule.value must be a non-negative number');
    if (typeof rule.condition !== 'function') throw new Error('rule.condition must be a function');
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Calculate final fee after applying all matching rules.
   * All arithmetic uses Decimal to prevent floating-point drift (Issue #751).
   *
   * @param {Object} context - Fee calculation context
   * @returns {Object} Fee calculation result
   */
  calculateFee(context) {
    // Use Decimal throughout — no raw Number arithmetic on monetary values.
    let currentFee = new Decimal(context.baseAmount || 0);
    const adjustments = [];

    for (const rule of this.rules) {
      if (rule.condition(context)) {
        const isFixed = rule.isFixed === true ||
          (typeof rule.description === 'string' && rule.description.toLowerCase().startsWith('fixed'));
        const ruleValue = new Decimal(rule.value);
        let adjustmentAmount;

        if (rule.type === 'discount') {
          adjustmentAmount = isFixed
            ? ruleValue.negated()
            : currentFee.mul(ruleValue).div(100).negated();
        } else if (rule.type === 'penalty') {
          adjustmentAmount = isFixed
            ? ruleValue
            : currentFee.mul(ruleValue).div(100);
        } else {
          adjustmentAmount = ruleValue;
        }

        currentFee = currentFee.plus(adjustmentAmount);

        adjustments.push({
          ruleName: rule.name,
          type: rule.type,
          value: rule.value,
          amountAdjusted: adjustmentAmount.abs().toDecimalPlaces(2).toNumber(),
          finalFeeAfterRule: currentFee.toDecimalPlaces(2).toNumber(),
          reason: rule.description,
        });
      }
    }

    // Clamp to zero — no negative fees.
    const finalFee = Decimal.max(new Decimal(0), currentFee);

    if (currentFee.lt(0)) {
      logger.warn({
        msg: 'Fee clamped to 0 after adjustments',
        studentId: context.studentId || null,
        unclampedAmount: currentFee.toDecimalPlaces(2).toNumber(),
      });
    }

    const baseDecimal = new Decimal(context.baseAmount || 0);
    const effectiveRate = baseDecimal.gt(0)
      ? finalFee.div(baseDecimal).mul(100).toDecimalPlaces(2).toNumber()
      : 100;

    return {
      baseFee: baseDecimal.toDecimalPlaces(2).toNumber(),
      finalFee: finalFee.toDecimalPlaces(2).toNumber(),
      adjustments,
      effectiveRate,
      totalAdjustments: adjustments.length,
    };
  }
}

// Export singleton instance
const feeEngine = new DynamicFeeAdjustmentEngine();

module.exports = {
  DynamicFeeAdjustmentEngine,
  feeEngine
};