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
 *
 * ⚠️ NOT ON THE LIVE PATH: nothing under backend/src/{controllers,routes} requires
 * this module or the `feeEngine` singleton it exports — grep the tree and the only
 * hits are this file and tests/feeAdjustment*.test.js. The rules school admins
 * actually create (via the "Fee Adjustment Rules" admin page → POST/PUT
 * /api/fee-adjustments) are stored in the `FeeAdjustmentRule` Mongo model and
 * evaluated by `feeAdjustmentService.js`, which is what `feeAdjustmentController.js`
 * calls. That service uses ASCENDING priority (lower number first) and an explicit
 * per-rule `conflictResolutionPolicy` ("stack" / "first_only" / "best_for_student") —
 * see the doc comments on `feeAdjustmentService.js` and `feeAdjustmentRuleModel.js`,
 * and the worked example in docs/architecture.md, for the behavior that governs
 * real fee calculations. This class's own order/conflict rules (documented below)
 * are the OPPOSITE of that live engine on priority direction and do not support
 * per-rule conflict policies at all — do not use this file as a reference for how
 * the production admin-configured rules resolve.
 *
 * ── Rule application order (this engine only) ──────────────────────────────
 * Rules are sorted DESCENDING by `priority` (see `loadDefaultRules` and
 * `addRule`) — the HIGHEST priority number runs FIRST. This is the reverse of
 * the live `feeAdjustmentService.js`, where the lowest number runs first.
 *
 * ── Conflict resolution strategy (this engine only) ────────────────────────
 * There is no policy field and no "pick one" behavior: every rule whose
 * `condition(ctx)` returns true is applied — all matches always stack,
 * unconditionally, in priority order. Two rules "conflict" only in the sense
 * that order changes the numeric result:
 *
 *   - Each rule is applied to the RUNNING fee left by every prior rule, not to
 *     the original `baseAmount`. A percentage rule (isFixed !== true and the
 *     description doesn't start with "fixed") computes its adjustment as
 *     `currentFee * value / 100` at the moment it runs, so a percentage
 *     rule that runs later applies to an already-adjusted fee, and a fixed
 *     rule that runs later still subtracts/adds the same flat amount
 *     regardless of position.
 *   - `type: 'discount'` subtracts from the running fee; `type: 'penalty'` adds
 *     to it.
 *   - The final running total is floored at 0 — fees never go negative
 *     (a warning is logged when clamping occurs).
 *
 * Worked example — percentage scholarship (priority 8, "student-discount",
 * 20% off) vs. a flat surcharge added as a custom rule (priority 20, fixed,
 * +100) on a base fee of 1000, run through `calculateFee`:
 *   1. Surcharge runs first (higher priority number): 1000 + 100 = 1100
 *   2. Scholarship runs second: 1100 - 20% of 1100 (220) = 880
 * Reversing the priorities (scholarship first) instead gives:
 *   1. Scholarship: 1000 - 200 = 800
 *   2. Surcharge:   800 + 100 = 900
 * Same two rules, same values — a different final fee purely from priority
 * order, because the percentage is computed against whatever the running fee
 * happens to be at that point in the loop, not the original base amount.
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

// Multi-tenant engine registry (Issue #1475: prevent cross-tenant rule leakage)
// Maps schoolId → engine instance, ensuring rules are isolated by school
const enginesBySchool = new Map();

/**
 * Factory function to get or create a fee adjustment engine for a given school.
 * Ensures that promotional rules created by one school do not leak to others.
 *
 * @param {string} schoolId - School ID for tenant isolation
 * @returns {DynamicFeeAdjustmentEngine} - School-specific engine instance
 */
function getEngineForSchool(schoolId) {
  if (!schoolId || typeof schoolId !== 'string') {
    throw new Error('schoolId is required and must be a string');
  }

  if (!enginesBySchool.has(schoolId)) {
    enginesBySchool.set(schoolId, new DynamicFeeAdjustmentEngine());
  }

  return enginesBySchool.get(schoolId);
}

/**
 * Clear all cached engine instances (primarily for testing).
 * Production code should not call this.
 */
function clearEngineCache() {
  enginesBySchool.clear();
}

// For backward compatibility with tests, export the default singleton-style engine
// (deprecated; new code should use getEngineForSchool)
const feeEngine = new DynamicFeeAdjustmentEngine();

module.exports = {
  DynamicFeeAdjustmentEngine,
  feeEngine,
  getEngineForSchool,
  clearEngineCache,
};