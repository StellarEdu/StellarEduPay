'use strict';

const mongoose = require('mongoose');
const softDelete = require('../utils/softDelete');
const tenantScope = require('../plugins/tenantScope');
const {
  CONFIRMATION_STATES,
  CONFIRMATION_STATE_TRANSITIONS,
} = require('../services/paymentConfirmationStateMachine');
const {
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_TRANSITIONS,
  ADMIN_PAYMENT_STATUS_TRANSITIONS,
  isTransitionAllowed,
} = require('../constants/paymentStatus');
const logger = require('../utils/logger');
// Student/emailService/reportCacheInvalidator are required lazily inside the
// post('save') hook below, not hoisted here: emailService pulls in
// services/email -> config, which throws at require time if MONGO_URI isn't
// set. paymentModel.js is required by ~30 unrelated modules (and by tests
// that never touch email), so eagerly loading that chain would make the
// model unrequireable outside a fully-configured environment.

const paymentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    // unique: false here — uniqueness is enforced by the compound index { schoolId, txHash } below
    txHash: { type: String, required: true, index: true },
    amount: {
      type: Number,
      required: true,
      min: [0, 'amount must be non-negative'],
      validate: [
        {
          validator: (v) => Number.isFinite(v),
          message: 'amount must be a finite number',
        },
      ],
    },

    // Correlation ID tying this payment to its full async lifecycle (polling
    // -> queue -> processor -> webhook -> SSE). Deterministically derived
    // from txHash — see utils/correlationId.js.
    correlationId: { type: String, default: null, index: true },
    feeAmount: {
      type: Number,
      default: null,
      min: [0, 'feeAmount must be non-negative'],
      validate: [
        {
          validator: (v) => v === null || v === undefined || Number.isFinite(v),
          message: 'feeAmount must be a finite number or null',
        },
      ],
    },
    feeCategory: { type: String, default: null, index: true },
    feeValidationStatus: { type: String, enum: ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'], default: 'unknown' },
    excessAmount: {
      type: Number,
      default: 0,
      min: [0, 'excessAmount must be non-negative'],
      validate: [
        {
          validator: (v) => Number.isFinite(v),
          message: 'excessAmount must be a finite number',
        },
      ],
    },

    // Underpaid Payment Reconciliation (Issue #1039)
    // Tracks reconciliation status and details for partial/underpaid payments
    underpaidReconciliation: {
      status: {
        type: String,
        enum: ['pending', 'partial_credited', 'refund_initiated', 'refund_completed'],
        default: 'pending',
      },
      appliedCredit: {
        type: Number,
        default: 0,
        min: [0, 'appliedCredit must be non-negative'],
        validate: [
          {
            validator: (v) => Number.isFinite(v),
            message: 'appliedCredit must be a finite number',
          },
        ],
      },
      creditAppliedAt: { type: Date, default: null },
      creditAppliedBy: { type: String, default: null },
      refundTxHash: { type: String, default: null },
      refundInitiatedAt: { type: Date, default: null },
      refundCompletedAt: { type: Date, default: null },
      refundNote: { type: String, default: null },
    },

    assetCode: {
      type: String,
      default: null,
      enum: {
        values: ['XLM', 'USDC', null],
        message: "assetCode must be 'XLM', 'USDC', or null",
      },
    },
    assetType: { type: String, default: null },

    // Canonical status values are imported from constants/paymentStatus.js (Issue #72).
    status: { type: String, enum: PAYMENT_STATUS_VALUES, default: 'PENDING' },
    memo: { type: String },
    senderAddress: { type: String, default: null },
    isSuspicious: { type: Boolean, default: false },
    suspicionReason: { type: String, default: null },
    // Review workflow for flagged payments (issue #852). A flag starts as
    // 'flagged'; an admin clears it (false positive → 'cleared', restoring the
    // payment) or confirms it as fraud ('confirmed_fraud'). All transitions are
    // captured in the audit log.
    suspicionReviewStatus: {
      type: String,
      enum: ['flagged', 'cleared', 'confirmed_fraud'],
      default: 'flagged',
    },
    suspicionReviewedBy: { type: String, default: null },
    suspicionReviewedAt: { type: Date, default: null },
    suspicionReviewNote: { type: String, default: null },

    ledger: { type: Number, default: null },
    ledgerSequence: { type: Number, default: null },
    // Legacy 3-value status, kept for backward compatibility with existing
    // queries/UI. Always derived from confirmationState (see
    // paymentConfirmationStateMachine.deriveLegacyConfirmationStatus).
    confirmationStatus: { type: String, enum: ['pending_confirmation', 'confirmed', 'failed'], default: 'pending_confirmation' },
    // Fine-grained finality state machine (issue #747):
    // detected -> pending -> confirmed -> finalized, with failed as a
    // terminal escape from any non-terminal state. See
    // backend/src/services/paymentConfirmationStateMachine.js for the policy.
    confirmationState: {
      type: String,
      enum: Object.values(CONFIRMATION_STATES),
      default: CONFIRMATION_STATES.DETECTED,
    },

    // Audit trail
    transactionHash: { type: String, default: null, index: true },
    startedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null, index: true },
    verifiedAt: { type: Date, default: null },

    // Payment locking
    lockedUntil: { type: Date, default: null },
    lockHolder: { type: String, default: null },

    // Reference code
    referenceCode: { type: String, default: null },

    // Orphan flag — set to true when the associated student is deleted
    studentDeleted: { type: Boolean, default: false, index: true },

    // Soft Delete
    deletedAt: { type: Date, default: null, index: true },

    // #883 — Fiat snapshot: rate locked at confirmation time.
    // Storing this prevents historical report totals from drifting as exchange
    // rates move. Reports use this field; a separate "current-rate" mode can
    // convert on-the-fly by ignoring fiatSnapshot.
    fiatSnapshot: {
      fiatAmount:   { type: Number, default: null },  // crypto_amount × fiatRate
      fiatCurrency: { type: String, default: null },  // e.g. 'USD'
      fiatRate:     { type: Number, default: null },  // rate at confirmation
      rateSource:   { type: String, default: null },  // 'coingecko' | 'coinbase' | etc.
      rateTimestamp:{ type: Date,   default: null },  // when the rate was fetched
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

softDelete(paymentSchema);
paymentSchema.plugin(tenantScope, { modelName: 'Payment' });

// Indexes
// Compound unique index enforces per-school txHash uniqueness (same tx can exist in two schools).
// The single-field txHash index (inline, non-unique) is kept for cross-school lookups.
paymentSchema.index({ schoolId: 1, txHash: 1 }, { unique: true });
// Unique sparse index on txHash for fast duplicate detection across all schools.
// sparse: true excludes documents where txHash is null (manually created records).
paymentSchema.index({ txHash: 1 }, { unique: true, sparse: true });
paymentSchema.index({ studentId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, studentId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, feeValidationStatus: 1 });
paymentSchema.index({ schoolId: 1, isSuspicious: 1 });
paymentSchema.index({ schoolId: 1, confirmationStatus: 1 });
paymentSchema.index({ confirmationState: 1 });
// Partial compound index for report queries: filters out soft-deleted
// payments so MongoDB only indexes documents that appear in aggregation
// results, keeping the index lean and report queries fast. The
// studentDeleted clause used by the application-level query is intentionally
// not part of this filter — MongoDB partial index filters don't support
// $ne, so "studentDeleted !== true" cannot be expressed directly (see
// migrations/015_add_payment_report_index.js, which creates the equivalent
// named index used in production).
paymentSchema.index(
  { schoolId: 1, status: 1, confirmedAt: -1 },
  { partialFilterExpression: { deletedAt: null } }
);
paymentSchema.index({ schoolId: 1, studentId: 1, feeCategory: 1 });

paymentSchema.virtual('explorerUrl').get(function () {
  const hash = this.transactionHash || this.txHash;
  if (!hash) return null;
  const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${hash}`;
});

paymentSchema.virtual('stellarExplorerUrl').get(function () {
  return this.explorerUrl;
});

/**
 * Status transition guard (pre-save hook).
 *
 * Uses the canonical transition tables imported from constants/paymentStatus.js
 * (Issue #72). See that module for the full allowed-transitions specification.
 *
 * Callers with admin authority may set `payment.$locals.adminOverride = true`
 * before calling .save() to use the wider admin transition table; the override
 * must be audited explicitly by the caller.
 */
paymentSchema.pre('save', async function () {
  // Use in-memory Mongoose helpers instead of a DB query to avoid an N+1
  // round-trip on every save. this.isNew is true for inserts; for existing
  // documents Mongoose tracks the original field values so we can check the
  // persisted status without any additional database call.
  if (!this.isNew) {
    // For the transition check we need the *original* persisted status.
    // Mongoose stores it in this.$__.savedState when the document was loaded.
    const savedState = this.$__ && this.$__.savedState;
    const originalStatus = savedState ? savedState.status : null;
    const newStatus = this.status;

    if (originalStatus !== null && originalStatus !== newStatus) {
      // Callers with admin authority may set $locals.adminOverride = true to
      // use the wider admin transition table (e.g. DISPUTED → REFUNDED).
      // The override must be audited explicitly by the caller.
      const adminOverride = !!(this.$locals && this.$locals.adminOverride);
      if (!isTransitionAllowed(originalStatus, newStatus, adminOverride)) {
        const err = new Error(
          `Payment status transition from ${originalStatus} to ${newStatus} is not allowed`,
        );
        err.code = 'INVALID_TRANSITION';
        throw err;
      }
    }

    // Same backstop for the finality state machine (issue #747). Callers are
    // expected to compute the next value via
    // paymentConfirmationStateMachine.resolveNextState() before assigning it
    // here; this guard catches any caller that bypasses that and tries to
    // persist an illegal jump (e.g. finalized -> pending).
    const originalConfirmationState = savedState ? savedState.confirmationState : null;
    const newConfirmationState = this.confirmationState;

    if (
      originalConfirmationState != null &&
      originalConfirmationState !== newConfirmationState
    ) {
      const allowedStates = CONFIRMATION_STATE_TRANSITIONS[originalConfirmationState] || [];
      if (!allowedStates.includes(newConfirmationState)) {
        const err = new Error(
          `Payment confirmationState transition from ${originalConfirmationState} to ${newConfirmationState} is not allowed`,
        );
        err.code = 'INVALID_CONFIRMATION_TRANSITION';
        throw err;
      }
    }
  }

  // Issue #68 — Normalize numeric precision to 7 decimal places (Stellar's
  // canonical precision) so aggregates never accumulate floating-point drift.
  // Also rejects any non-finite value that somehow slipped past the validator
  // (e.g. values written directly via update operators bypass Mongoose validators).
  const STELLAR_DECIMALS = 7;
  const normalize = (v) => (v != null && Number.isFinite(v) ? parseFloat(v.toFixed(STELLAR_DECIMALS)) : v);

  if (this.isModified('amount') && this.amount != null) {
    this.amount = normalize(this.amount);
  }
  if (this.isModified('feeAmount') && this.feeAmount != null) {
    this.feeAmount = normalize(this.feeAmount);
  }
  if (this.isModified('excessAmount') && this.excessAmount != null) {
    this.excessAmount = normalize(this.excessAmount);
  }

});

// Issue #669: Send payment receipt email on SUCCESS transition
paymentSchema.post('save', async function () {
  // Check if status transitioned to SUCCESS
  const savedState = this.$__ && this.$__.savedState;
  const originalStatus = savedState ? savedState.status : null;
  const newStatus = this.status;

  if (originalStatus !== 'SUCCESS' && newStatus === 'SUCCESS') {
    // Status transitioned to SUCCESS — queue receipt email
    let student;
    try {
      const Student = require('./studentModel');
      student = await Student.findOne({
        schoolId: this.schoolId,
        studentId: this.studentId,
      });
    } catch (err) {
      logger.error({
        msg: 'Failed to look up student for payment receipt email',
        paymentId: this._id,
        error: err.message,
      });
    }

    if (student && student.parentEmail) {
      try {
        const emailService = require('../services/emailService');
        // Use cumulative totalPaid for accurate remaining balance (issue #1031)
        const totalPaid = student.totalPaid || 0;
        await emailService.sendPaymentReceipt({
          schoolId: this.schoolId,
          studentId: this.studentId,
          to: student.parentEmail,
          studentName: student.name,
          amount: this.amount,
          txHash: this.txHash,
          confirmedAt: this.confirmedAt,
          remainingBalance: student.feeAmount - totalPaid,
        });
      } catch (err) {
        // Log error but don't fail the save, and don't let it block cache invalidation below
        logger.error({
          msg: 'Failed to send payment receipt email',
          paymentId: this._id,
          error: err.message,
        });
      }
    }

    // Invalidate report cache on new successful payments — independent of the
    // email dispatch above, so a broken email path can never suppress this.
    try {
      const reportCacheInvalidator = require('../services/reportCacheInvalidator');
      reportCacheInvalidator.invalidate(this.schoolId);
    } catch (err) {
      logger.error({
        msg: 'Failed to invalidate report cache',
        paymentId: this._id,
        schoolId: this.schoolId,
        error: err.message,
      });
    }
  }
});

module.exports = mongoose.model('Payment', paymentSchema);
