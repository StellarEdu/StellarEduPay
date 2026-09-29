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
// Compound unique index enforces per-school, per-operation uniqueness: the same
// transaction may legitimately contain several payment operations (one per
// student), so identity is (schoolId, txHash, opIndex) rather than
// (schoolId, txHash). The single-field txHash index (inline, non-unique) is kept
// for cross-school lookups.
paymentSchema.index({ schoolId: 1, txHash: 1, opIndex: 1 }, { unique: true });
// Unique sparse index on (txHash, opIndex) for fast duplicate detection across
// all schools. sparse: true excludes documents where txHash is null (manually
// created records). Replaces the previous global unique { txHash: 1 } index,
// which rejected the second payment row of a multi-operation transaction with
// E11000.
paymentSchema.index({ txHash: 1, opIndex: 1 }, { unique: true, sparse: true });
paymentSchema.index({ studentId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, studentId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, feeValidationStatus: 1 });
paymentSchema.index({ schoolId: 1, isSuspicious: 1 });
paymentSchema.index({ schoolId: 1, confirmationStatus: 1 });
paymentSch

/* … truncated 6988 chars — edit only what you need near the top … */
