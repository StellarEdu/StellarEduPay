'use strict';

const mongoose = require('mongoose');
const softDelete = require('../utils/softDelete');
const tenantScope = require('../plugins/tenantScope');
const { encryptStudentPii, decryptStudentPii, hashParentEmail } = require('../services/studentPiiEncryption');
const { toStroops } = require('../utils/stellarAmount');

const feeCategorySchema = new mongoose.Schema(
  {
    category: { type: String, required: true },
    amount: { type: Number, required: true, min: [0, 'Fee amount cannot be negative'] },
    amountStroops: { type: String, default: null },
    paid: { type: Boolean, default: false },
    totalPaid: { type: Number, default: 0 },
    totalPaidStroops: { type: String, default: '0' },
    remainingBalance: { type: Number, default: null },
    remainingBalanceStroops: { type: String, default: null },
    paymentDeadline: { type: Date, default: null },
  },
  { _id: false }
);

const studentSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true, maxlength: [28, 'studentId must not exceed 28 characters (Stellar memo limit)'] },
    name: { type: String, required: true },
    class: { type: String, required: true, index: true },
    academicYear: { type: String },
    feeAmount: { type: Number, required: true, min: [0, 'Fee amount cannot be negative'] },
    feeAmountStroops: { type: String, default: null },
    fees: { type: [feeCategorySchema], default: [] },
    paymentDeadline: { type: Date, default: null },
    feePaid: { type: Boolean, default: false, index: true },
    totalPaid: { type: Number, default: 0 },
    totalPaidStroops: { type: String, default: '0' },
    remainingBalance: { type: Number, default: null },
    remainingBalanceStroops: { type: String, default: null },

    /**
     * Cumulative amount of manual partial-credit adjustments applied by admins.
     * This is a first-class ledger value: the consistency and reconciliation
     * jobs must add it to the raw payment sum when computing the expected
     * balance, so admin-applied credits are never treated as drift and silently
     * reverted. The running total is enforced to never be negative at the
     * application level (see adjustStudentCredit endpoint).
     */
    creditAdjustments: { type: Number, default: 0 },
    creditBalanceStroops: { type: String, default: '0' },

    // Parent contact for fee reminders — encrypted at rest (issue #1480), see
    // pre('save')/post('init') hooks below and studentPiiEncryption.js.
    parentEmail: { type: String, default: null, trim: true, lowercase: true },
    parentPhone: { type: String, default: null, trim: true },
    // Deterministic blind-index hash of parentEmail, used for exact-match
    // lookups (e.g. suppression-list opt-out) since the encrypted value uses
    // a random IV and isn't matchable across records.
    parentEmailHash: { type: String, default: null, index: true, select: false },

    // Reminder tracking
    lastReminderSentAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0 },
    reminderOptOut: { type: Boolean, default: false },
    parentEmailSuppressed: { type: Boolean, default: false },
    parentEmailSuppressionReason: { type: String, default: null },
    parentEmailSuppressedAt: { type: Date, default: null },
    lastEmailDeliveryStatus: { type: String, enum: ['queued', 'sent', 'failed', 'delivered', 'opened', 'bounced', 'complaint', 'skipped'], default: null },
    lastEmailDeliveryAt: { type: Date, default: null },

    /**
     * Academic period to which the current reminderCount applies.
     * Reset reminderCount when a new fee period begins (e.g. "2025-2026").
     * Prevents a perpetually-unpaid fee from generating endless reminders
     * across multiple academic years.
     */
    reminderPeriod: { type: String, default: null },

    // Dispute hold — set to true when an active dispute is opened for this
    // student's payment. Suppresses automated reminders and downstream
    // automation until the dispute is resolved or rejected.
    disputeHold: { type: Boolean, default: false, index: true },

    // Audit fields
    dateOfBirth: { type: Date },
    gender: { type: String },
    parentName: { type: String },
    contactNumber: { type: String },

    // Soft Delete
    deletedAt: { type: Date, default: null, index: true },

    version: { type: Number, default: 0 },
    lastPaymentAt: { type: Date, default: null },
    lastPaymentHash: { type: String, default: null },
    lastTransactionAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Apply soft delete utility
softDelete(studentSchema);
studentSchema.plugin(tenantScope, { modelName: 'Student' });

// isOverdue: true when a deadline is set, the fee is unpaid, and the deadline has passed
studentSchema.virtual('isOverdue').get(function () {
  return !this.feePaid && this.paymentDeadline != null && new Date() > this.paymentDeadline;
});

// Virtual to compute total fee amount from fees array
studentSchema.virtual('totalFeeAmount').get(function () {
  if (this.fees && this.fees.length > 0) {
    return this.fees.reduce((sum, fee) => sum + (fee.amount || 0), 0);
  }
  return this.feeAmount || 0;
});

// Virtual to compute total paid from fees array
studentSchema.virtual('totalPaidFromFees').get(function () {
  if (this.fees && this.fees.length > 0) {
    return this.fees.reduce((sum, fee) => sum + (fee.totalPaid || 0), 0);
  }
  return this.totalPaid || 0;
});

studentSchema.index({ studentId: 1, schoolId: 1 }, { unique: true });
studentSchema.index({ schoolId: 1, class: 1 });
studentSchema.index({ schoolId: 1, feePaid: 1 });
studentSchema.index({ studentId: 1, version: 1 });
studentSchema.index({ feePaid: 1, class: 1 });
studentSchema.index({ totalPaid: 1 });
studentSchema.index({ name: 'text', studentId: 'text' });

function toStroopStringOrNull(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return toStroops(value).toString();
}

function syncStudentStroopsOnDocument(doc) {
  if (doc.feeAmount !== undefined && doc.feeAmount !== null && Number.isFinite(Number(doc.feeAmount))) {
    doc.feeAmountStroops = toStroops(doc.feeAmount).toString();
  }
  if (doc.totalPaid !== undefined && doc.totalPaid !== null && Number.isFinite(Number(doc.totalPaid))) {
    doc.totalPaidStroops = toStroops(doc.totalPaid).toString();
  }
  doc.remainingBalanceStroops = toStroopStringOrNull(doc.remainingBalance);
  const creditVal = doc.creditBalance !== undefined ? doc.creditBalance : doc.creditAdjustments;
  if (creditVal !== undefined && creditVal !== null && Number.isFinite(Number(creditVal))) {
    doc.creditBalanceStroops = toStroops(creditVal).toString();
  }
  if (Array.isArray(doc.fees)) {
    doc.fees.forEach((fee) => {
      if (fee.amount !== undefined && fee.amount !== null && Number.isFinite(Number(fee.amount))) {
        fee.amountStroops = toStroops(fee.amount).toString();
      }
      if (fee.totalPaid !== undefined && fee.totalPaid !== null && Number.isFinite(Number(fee.totalPaid))) {
        fee.totalPaidStroops = toStroops(fee.totalPaid).toString();
      }
      fee.remainingBalanceStroops = toStroopStringOrNull(fee.remainingBalance);
    });
  }
}

// #1819 — Populate exact *Stroops string fields during validation and save.
studentSchema.pre('validate', function syncStudentStroopsPreValidate(next) {
  syncStudentStroopsOnDocument(this);
  next();
});

// ── Parent contact PII encryption at rest — Issue #1480 ─────────────────────
// Encrypt parentEmail/parentPhone before persisting, then decrypt them back
// onto the in-memory document so callers (controllers, reminder/email
// services) keep working with plaintext. Both operations are no-ops when
// STUDENT_PII_ENCRYPTION_KEY is not set.

studentSchema.pre('save', function (next) {
  if (this.isModified('parentEmail') && this.parentEmail != null) {
    this.parentEmailHash = hashParentEmail(this.parentEmail);
    this.parentEmail = encryptStudentPii(this.parentEmail);
  }
  if (this.isModified('parentPhone') && this.parentPhone != null) {
    this.parentPhone = encryptStudentPii(this.parentPhone);
  }
  next();
});

studentSchema.post('save', function () {
  if (this.parentEmail != null) this.parentEmail = decryptStudentPii(this.parentEmail);
  if (this.parentPhone != null) this.parentPhone = decryptStudentPii(this.parentPhone);
});

// Decrypt after loading from DB so callers always receive plaintext.
studentSchema.post('init', function () {
  if (this.parentEmail != null) this.parentEmail = decryptStudentPii(this.parentEmail);
  if (this.parentPhone != null) this.parentPhone = decryptStudentPii(this.parentPhone);
});

studentSchema.pre('save', async function () {
  // Archive overflow fee entries before computing totals.
  // When the array exceeds STUDENT_FEE_HISTORY_CAP, the oldest entries are
  // moved to StudentFeeHistory so the document stays compact.
  const CAP = parseInt(process.env.STUDENT_FEE_HISTORY_CAP, 10) || 100;
  if (this.fees && this.fees.length > CAP) {
    const overflow = this.fees.length - CAP;
    const toArchive = this.fees.splice(0, overflow);
    try {
      const StudentFeeHistory = require('./studentFeeHistoryModel');
      await StudentFeeHistory.insertMany(
        toArchive.map(fee => ({
          schoolId:        this.schoolId,
          studentId:       this.studentId,
          category:        fee.category,
          amount:          fee.amount,
          paid:            fee.paid,
          totalPaid:       fee.totalPaid,
          remainingBalance:fee.remainingBalance,
          paymentDeadline: fee.paymentDeadline,
        }))
      );
    } catch (archiveErr) {
      // Log but don't abort the save — active record integrity takes priority.
      const logger = require('../utils/logger').child('StudentModel');
      logger.error('Failed to archive fee history', { error: archiveErr.message });
    }
  }

  // Sync feeAmount with fees array for backward compatibility
  if (this.fees && this.fees.length > 0) {
    this.feeAmount = this.fees.reduce((sum, fee) => sum + (fee.amount || 0), 0);

    // Update individual fee remaining balances
    this.fees.forEach(fee => {
      fee.remainingBalance = Math.max(0, fee.amount - (fee.totalPaid || 0));
      fee.paid = (fee.totalPaid || 0) >= fee.amount;
    });

    // Update top-level totals
    this.totalPaid = this.fees.reduce((sum, fee) => sum + (fee.totalPaid || 0), 0);
    this.remainingBalance = Math.max(0, this.feeAmount - this.totalPaid);
    this.feePaid = this.fees.every(fee => fee.paid);
  }

  syncStudentStroopsOnDocument(this);
});

module.exports = mongoose.model('Student', studentSchema);
