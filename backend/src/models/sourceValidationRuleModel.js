'use strict';

/**
 * SourceValidationRule
 *
 * Tenant isolation
 * ----------------
 * Rules are scoped per school via `schoolId`.  All queries MUST include
 * `schoolId` so that School A can never read, modify, or trigger on rules
 * belonging to School B.
 *
 * Unmatched-sender default behaviour
 * ------------------------------------
 * When a payment arrives from a sender address that does not match any active
 * rule for the school the default action is **ALLOW** — the payment is not
 * automatically blocked.  Admins who want a strict allowlist must create
 * explicit "whitelist" rules.  The rationale:
 *
 *   - Deny-by-default would silently block legitimate first-time payers who
 *     have not yet been enrolled in the allowlist.
 *   - Suspicious-payment detection (via the `suspicious_multiplier` threshold)
 *     already flags unusual amounts for manual review.
 *
 * Operators can override this by creating a catch-all "blacklist" rule with a
 * wildcard pattern (`value: ".*"`) that is overridden by specific whitelist
 * entries of higher priority.
 *
 * Rule types
 * ----------
 *   blacklist        — reject payments from a specific sender address.
 *   whitelist        — explicitly allow a specific sender address.
 *   pattern          — apply a RegExp match against the sender address.
 *   new_sender_limit — cap the number of daily transactions from first-time
 *                      senders (rate-limiting).
 */

const mongoose = require('mongoose');

const sourceValidationRuleSchema = new mongoose.Schema({
  /**
   * schoolId — required; scopes this rule to a single school tenant.
   * All controller queries must filter by schoolId derived from req.schoolId.
   */
  schoolId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: {
    type: String,
    enum: ['blacklist', 'whitelist', 'pattern', 'new_sender_limit'],
    required: true,
  },
  value: { type: String },                    // account ID or regex pattern
  description: { type: String },
  isActive: { type: Boolean, default: true },
  /**
   * priority — lower value = evaluated first.
   * Whitelist rules with priority 1 will be checked before a catch-all
   * blacklist with priority 100.
   */
  priority: { type: Number, default: 10 },
  maxTransactionsPerDay: { type: Number, default: null }, // for new_sender_limit
  // Last time an incoming payment's sender address matched this rule; null
  // until the rule has matched at least once.
  lastMatchedAt: { type: Date, default: null },
}, { timestamps: true });

// Compound unique index: rule names must be unique per school, not globally
sourceValidationRuleSchema.index({ schoolId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SourceValidationRule', sourceValidationRuleSchema);
