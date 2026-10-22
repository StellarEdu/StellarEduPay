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
  // #1761 — A REJECTED row is a durable verification-failure marker, not a
  // credited payment. It maps to the terminal failed sub-state.
  REJECTED: CONFIRMATION_STATES.FAILED,
});

const STATUS_TO_CONFIRMATION_STATUS = Object.freeze({
  PENDING: 'pending_confirmation',
  SUBMITTED: 'pending_confirmation',
  SUCCESS: 'confirmed',
  FAILED: 'failed',
  REFUNDED: 'confirmed',
  // #1761 — REJECTED is a verification-failure marker, never a confirmed payment.
  REJECTED: 'failed',
});

/**
 * #1761 — Statuses that represent a durable verification-failure marker rather
 * than a credited payment. Rows with these statuses must be excluded from every
 * "existing payment" lookup used for idempotency / duplicate detection so that
 * a transaction rejected for a configuration-dependent reason (limits, accepted
 * assets, wrong school) can be re-verified and credited once the configuration
 * changes.
 */
const REJECTION_STATUSES = Object.freeze(['REJECTED']);

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

/**
 * #1761 — Mongo filter matching every payment that should be treated as an
 * "existing" record for idempotency / duplicate detection. REJECTED rows are
 * durable verification-failure markers and must NOT block a later
 * re-verification, so they are excluded.
 *
 * @param {object} [base] additional filter fields to merge in
 * @returns {object} a Mongo filter
 */
function existingPaymentFilter(base = {}) {
  return { ...base, status: { $nin: REJECTION_STATUSES } };
}

/**
 * #1761 — Predicate: is this payment a durable rejection marker?
 * @param {object|string} paymentOrStatus
 * @returns {boolean}
 */
function isRejected(paymentOrStatus) {
  const status =
    typeof paymentOrStatus === 'string'
      ? paymentOrStatus
      : paymentOrStatus && paymentOrStatus.status;
  return REJECTION_STATUSES.includes(status);
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
    // #1766 — Canonical fee-validation vocabulary. Writers MUST assign this
    // field only via utils/money.classifyFeePayment so every code path agrees
    // on the meaning of each value:
    //   'valid'     — cumulative total equals the expected amount
    //   'partial'   — cumulative total is below the fee; the payment is
    //                 accepted as an installment toward the balance
    //   'underpaid' — payment is below the expected *installment* when a
    //                 payment plan exists (see #1379 semantics)
    //   'overpaid'  — cumulative total exceeds the expected amount
    //   'unknown'   — no fee/expected amount is known yet
    // See docs/payment-plans-underpaid-reconciliation.md.
    feeValidationStatus: {
      type: String,
      enum: ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'],
      default: 'unknown',
    },
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
    // #1761 — 'REJECTED' is a durable verification-failure marker (see
    // rejectionCode below). It is never counted as paid and is excluded from
    // every "existing payment" lookup used for idempotency/duplicate detection.
    status: {
      type: String,
      enum: [...PAYMENT_STATUS_VALUES, 'REJECTED'],
      default: 'PENDING',
    },
    // #1761 — Machine-readable reason a payment was rejected during
    // verification (e.g. TX_FAILED, MISSING_MEMO, INVALID_DESTINATION,
    // UNSUPPORTED_ASSET, AMOUNT_TOO_LOW, AMOUNT_TOO_HIGH, UNDERPAID). Only set
    // on REJECTED rows. Several of these are configuration-dependent, so a
    // REJECTED row must never block a later re-verification.
    rejectionCode: { type: String, default: null, index: true },
    rejectionMessage: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    memo: { type: String },
    senderAddress: { type: String, default: null },
    isSuspicious: { type: Boolean, default: false },
    // #1799 — true when the payment arrived at a wallet address this school
    // has rotated away from but is still draining. The school is notified.
    receivedOnRetiredAddress: { type: Boolean, default: false },
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
  // #1761 — Keep rejection metadata consistent with the authoritative status.
  if (this.status === 'REJECTED' && !this.rejectedAt) {
    this.rejectedAt = new Date();
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
// #1761 — Expose the rejection helpers so every idempotency / duplicate
// detection path can share one definition of "existing payment".
paymentSchema.statics.existingPaymentFilter = existingPaymentFilter;
paymentSchema.statics.isRejected = isRejected;
paymentSchema.statics.REJECTION_STATUSES = REJECTION_STATUSES;

// Indexes
// Compound unique index enforces per-school, per-operation uniqueness: the same
// transaction may legitimately contain several payment operations (one per
// student), so identity is (schoolId, txHash, opIndex) rather than
// txHash alone. This is the ONLY unique index on txHash — a legacy
// { schoolId, txHash } unique index would reject the second operation of a
// multi-operation transaction and must not exist (see migration 035).
paymentSchema.index({ schoolId: 1, txHash: 1, opIndex: 1 }, { unique: true });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
module.exports.isCountedAsPaid = isCountedAsPaid;
module.exports.countedAsPaidFilter = countedAsPaidFilter;
module.exports.deriveConfirmationState = deriveConfirmationState;
module.exports.deriveConfirmationStatus = deriveConfirmationStatus;
module.exports.existingPaymentFilter = existingPaymentFilter;
module.exports.isRejected = isRejected;
module.exports.REJECTION_STATUSES = REJECTION_STATUSES;