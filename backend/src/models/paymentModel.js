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

// ---------------------------------------------------------------------------
// #1560 — Single authoritative payment lifecycle.
//
// A payment's lifecycle is persisted in exactly ONE field: `status`
// (PAYMENT_STATUS_VALUES, guarded by PAYMENT_STATUS_TRANSITIONS). The two
// legacy fields `confirmationStatus` and `confirmationState` are DERIVED
// views of `status` and must never be treated as authoritative:
//
//   status            confirmationState   confirmationStatus
//   ---------------   -----------------   --------------------
//   PENDING           detected            pending_confirmation
//   SUBMITTED         pending             pending_confirmation
//   SUCCESS           finalized           confirmed
//   FAILED            failed              failed
//   REFUNDED          finalized           confirmed
//   (anything else)   detected            pending_confirmation
//
// `confirmationState` is the fine-grained finality sub-state of `status`
// (issue #747); `confirmationStatus` is the legacy 3-value projection kept
// for backward compatibility with existing queries/UI. Both are recomputed
// from `status` on every save (see the pre('save') hook below) so the three
// fields can no longer disagree. Migration of existing documents is a
// follow-up per #1560's acceptance criteria; this change only makes the
// derivation explicit and enforced.
const STATUS_TO_CONFIRMATION_STATE = Object.freeze({
  PENDING: CONFIRMATION_STATES.DETECTED,
  SUBMITTED: CONFIRMATION_STATES.PENDING,
  SUCCESS: CONFIRMATION_STATES.FINALIZED,
  FAILED: CONFIRMATION_STATES.FAILED,
  REFUNDED: CONFIRMATION_STATES.FINALIZED,
});

const STATUS_TO_CONFIRMATION_STATUS = Object.freeze({
  PENDING: 'pending_confirmation',
  SUBMITTED: 'pending_confirmation',
  SUCCESS: 'confirmed',
  FAILED: 'failed',
  REFUNDED: 'confirmed',
});

/**
 * Derive the fine-grained confirmation state from the authoritative `status`.
 * @param {string} status
 * @returns {string} one of CONFIRMATION_STATES
 */
function deriveConfirmationState(status) {
  return STATUS_TO_CONFIRMATION_STATE[status] || CONFIRMATION_STATES.DETECTED;
}

/**
 * Derive the legacy 3-value confirmation status from the authoritative `status`.
 * @param {string} status
 * @returns {'pending_confirmation'|'confirmed'|'failed'}
 */
function deriveConfirmationStatus(status) {
  return STATUS_TO_CONFIRMATION_STATUS[status] || 'pending_confirmation';
}

/**
 * #1560 — The single shared predicate for "counted as paid".
 *
 * Every service (reports, summaries, finalisation, reconciliation) must use
 * this instead of consulting `status`, `confirmationStatus` or
 * `confirmationState` independently. A payment counts as paid iff its
 * authoritative `status` is SUCCESS (or REFUNDED, which is a terminal state
 * reached only after a successful payment).
 *
 * @param {object|string} paymentOrStatus a Payment document/lean object, or a raw status string
 * @returns {boolean}
 */
function isCountedAsPaid(paymentOrStatus) {
  const status =
    typeof paymentOrStatus === 'string'
      ? paymentOrStatus
      : paymentOrStatus && paymentOrStatus.status;
  return status === 'SUCCESS' || status === 'REFUNDED';
}

/**
 * #1560 — Mongo filter matching every payment that counts as paid.
 * Use this in queries so reports/summaries agree with isCountedAsPaid().
 * @returns {{status: {$in: string[]}}}
 */
function countedAsPaidFilter() {
  return { status: { $in: ['SUCCESS', 'REFUNDED'] } };
}

const paymentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    // unique: false here — uniqueness is enforced by the compound index { schoolId, txHash, opIndex } below
    txHash: { type: String, required: true, index: true },
    // #1558 — A single Stellar transaction can carry up to 100 payment
    // operations. Payment identity is therefore (txHash, opIndex), not txHash
    // alone. opIndex is the 0-based position of the operation within the
    // transaction (Horizon operation index). Defaults to 0 so existing rows
    // and single-operation transactions keep working unchanged.
    opIndex: {
      type: Number,
      default: 0,
      min: [0, 'opIndex must be non-negative'],
      validate: [
        {
          validator: (v) => Number.isInteger(v),
          message: 'opIndex must be an integer',
        },
      ],
    },
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

    // #1560 — AUTHORITATIVE lifecycle field. Canonical status values are
    // imported from constants/paymentStatus.js (Issue #72). All other
    // lifecycle fields below are derived from this one.
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
    // #1560 — DERIVED (not authoritative). Legacy 3-value status, kept for
    // backward compatibility with existing queries/UI. Always recomputed from
    // `status` in the pre('save') hook below.
    confirmationStatus: { type: String, enum: ['pending_confirmation', 'confirmed', 'failed'], default: 'pending_confirmation' },
    // #1560 — DERIVED (not authoritative). Fine-grained finality state machine
    // (issue #747): detected -> pending -> confirmed -> finalized, with failed
    // as a terminal escape from any non-terminal state. Always recomputed from
    // `status` in the pre('save') hook below. See
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

// #1560 — Keep the derived lifecycle fields in lock-step with the
// authoritative `status` on every write. This is the single place the
// derivation is enforced, so `status`, `confirmationStatus` and
// `confirmationState` can no longer disagree on newly written documents.
paymentSchema.pre('save', function syncDerivedLifecycleFields(next) {
  if (this.isModified('status') || this.isNew) {
    this.confirmationState = deriveConfirmationState(this.status);
    this.confirmationStatus = deriveConfirmationStatus(this.status);
  }
  next();
});

// #1560 — Expose the shared "counted as paid" predicate on the model so all
// services can use one definition instead of consulting the three fields
// independently.
paymentSchema.statics.isCountedAsPaid = isCountedAsPaid;
paymentSchema.statics.countedAsPaidFilter = countedAsPaidFilter;
paymentSchema.statics.deriveConfirmationState = deriveConfirmationState;
paymentSchema.statics.deriveConfirmationStatus = deriveConfirmationStatus;

// Indexes
// Compound unique index enforces per-school, per-operation uniqueness: the same
// transaction may legitimately contain several payment operations (one per
// student), so identity is (schoolId, txHash, opIndex) rather than
// txHash alone.
paymentSchema.index({ schoolId: 1, txHash: 1, opIndex: 1 }, { unique: true });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
module.exports.isCountedAsPaid = isCountedAsPaid;
module.exports.countedAsPaidFilter = countedAsPaidFilter;
module.exports.deriveConfirmationState = deriveConfirmationState;
module.exports.deriveConfirmationStatus = deriveConfirmationStatus;
