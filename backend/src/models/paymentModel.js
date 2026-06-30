'use strict';

const mongoose = require('mongoose');
const softDelete = require('../utils/softDelete');
const memoEncryption = require('../utils/memoEncryption');
const tenantScope = require('../plugins/tenantScope');
const {
  CONFIRMATION_STATES,
  CONFIRMATION_STATE_TRANSITIONS,
} = require('../services/paymentConfirmationStateMachine');

const paymentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    // unique: false here — uniqueness is enforced by the compound index { schoolId, txHash } below
    txHash: { type: String, required: true, index: true },
    amount: { type: Number, required: true },

    // Correlation ID tying this payment to its full async lifecycle (polling
    // -> queue -> processor -> webhook -> SSE). Deterministically derived
    // from txHash — see utils/correlationId.js.
    correlationId: { type: String, default: null, index: true },
    feeAmount: { type: Number, default: null },
    feeCategory: { type: String, default: null, index: true },
    feeValidationStatus: { type: String, enum: ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'], default: 'unknown' },
    excessAmount: { type: Number, default: 0 },

    assetCode: { type: String, default: null },
    assetType: { type: String, default: null },

    status: { type: String, enum: ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'REFUNDED', 'INVALID'], default: 'PENDING' },
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
// Partial compound index for report queries: filters out orphaned/deleted
// payments so MongoDB only indexes documents that appear in aggregation
// results, keeping the index lean and report queries fast.
paymentSchema.index(
  { schoolId: 1, status: 1, confirmedAt: -1 },
  { partialFilterExpression: { studentDeleted: { $ne: true }, deletedAt: null } }
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
 * Allowed status transitions for normal and admin-authorized paths.
 *
 * Normal transitions (enforced by the pre-save hook):
 *   SUCCESS   → DISPUTED  : admin marks a confirmed payment as disputed
 *   SUCCESS   → REFUNDED  : admin marks a confirmed payment as refunded
 *   PENDING   → FAILED    : admin manually fails a stuck pending payment
 *   SUBMITTED → FAILED    : admin manually fails a stuck submitted payment
 *
 * All other transitions are rejected with INVALID_TRANSITION.
 * Callers with legitimate admin authority may set `payment.$locals.adminOverride = true`
 * before calling .save() to bypass the guard; the override is audited by the caller.
 */
const PAYMENT_STATUS_TRANSITIONS = {
  SUCCESS:   ['DISPUTED', 'REFUNDED'],
  PENDING:   ['FAILED'],
  SUBMITTED: ['FAILED'],
};

/**
 * Additional transitions available only when an admin sets adminOverride = true
 * on the document before calling save(). These paths are audited by the caller.
 *
 * SUCCESS  → REFUNDED  : admin refunds a confirmed payment
 * DISPUTED → REFUNDED  : admin resolves a dispute via refund
 */
const ADMIN_PAYMENT_STATUS_TRANSITIONS = {
  SUCCESS:   ['DISPUTED', 'REFUNDED'],
  PENDING:   ['FAILED'],
  SUBMITTED: ['FAILED'],
  DISPUTED:  ['REFUNDED'],
};

paymentSchema.pre('save', function (next) {
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
      // bypass the guard for legitimate operations (e.g. SUCCESS → REFUNDED).
      // The override must be audited explicitly by the caller.
      if (!this.$locals || !this.$locals.adminOverride) {
        const allowed = PAYMENT_STATUS_TRANSITIONS[originalStatus] || [];
        if (!allowed.includes(newStatus)) {
          const err = new Error(
            `Payment status transition from ${originalStatus} to ${newStatus} is not allowed`,
          );
          err.code = 'INVALID_TRANSITION';
          return next(err);
        }
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
        return next(err);
      }
    }
  }

  // Encrypt memo field at rest using application-level AES-256-GCM encryption.
  // Encryption is a no-op when MEMO_ENCRYPTION_KEY is not set (graceful degradation).
  if (this.isModified('memo') && this.memo != null) {
    this.memo = memoEncryption.encryptMemo(this.memo);
  }

  next();
});

// Decrypt memo transparently after loading from the database.
// This runs for find(), findOne(), findById(), etc.
paymentSchema.post('init', function () {
  if (this.memo != null) {
    this.memo = memoEncryption.decryptMemo(this.memo);
  }
});

// Issue #669: Send payment receipt email on SUCCESS transition
paymentSchema.post('save', async function () {
  try {
    // Check if status transitioned to SUCCESS
    const savedState = this.$__ && this.$__.savedState;
    const originalStatus = savedState ? savedState.status : null;
    const newStatus = this.status;

    if (originalStatus !== 'SUCCESS' && newStatus === 'SUCCESS') {
      // Status transitioned to SUCCESS — queue receipt email
      const Student = require('../models/studentModel');
      const student = await Student.findOne({
        schoolId: this.schoolId,
        studentId: this.studentId,
      });

      if (student && student.contactEmail) {
        // Queue email via BullMQ (non-blocking)
        const emailService = require('./emailService');
        await emailService.sendPaymentReceipt({
          to: student.contactEmail,
          studentName: student.name,
          amount: this.amount,
          txHash: this.txHash,
          confirmedAt: this.confirmedAt,
          remainingBalance: student.feeAmount - this.amount,
        });
      }

      // Invalidate report cache on new successful payments
      const reportCacheInvalidator = require('../services/reportCacheInvalidator');
      reportCacheInvalidator.invalidate(this.schoolId);
    }
  } catch (err) {
    // Log error but don't fail the save
    const logger = require('../utils/logger');
    logger.error({
      msg: 'Failed to queue payment receipt email',
      paymentId: this._id,
      error: err.message,
    });
  }
});

module.exports = mongoose.model('Payment', paymentSchema);
