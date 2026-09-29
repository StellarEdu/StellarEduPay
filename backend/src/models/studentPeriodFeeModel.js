'use strict';

/**
 * StudentPeriodFee — per-student, per-period fee assignment (Issue #1569).
 *
 * Replaces the single scalar feeAmount/totalPaid/remainingBalance on the
 * Student document with a term-dimensional view.  Each record captures the
 * fee assigned for one student in one academic period along with running
 * payment totals and any arrears carried forward from the previous period.
 *
 * The top-level Student fields remain for backward compatibility but are
 * treated as the "current period" view by the application layer.
 */

const mongoose = require('mongoose');

const studentPeriodFeeSchema = new mongoose.Schema(
  {
    schoolId: {
      type: String,
      required: true,
      index: true,
    },
    studentId: {
      type: String,
      required: true,
      index: true,
    },
    /**
     * Reference to the AcademicPeriod this assignment belongs to.
     */
    periodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AcademicPeriod',
      required: true,
      index: true,
    },
    /**
     * The period's human-readable name — denormalised here so reports
     * remain self-contained without an extra join.
     */
    periodName: {
      type: String,
      required: true,
    },
    /**
     * The gross fee amount due for this period (excluding carried arrears).
     */
    feeAmount: {
      type: Number,
      required: true,
      min: [0, 'feeAmount cannot be negative'],
    },
    /**
     * Arrears explicitly carried forward from the PREVIOUS period's rollover.
     * This is kept separate from the current fee so reports can distinguish
     * "new charges" from "old debt".
     */
    carriedArrears: {
      type: Number,
      default: 0,
      min: [0, 'carriedArrears cannot be negative'],
    },
    /**
     * Total amount paid by the student towards this period's obligation
     * (feeAmount + carriedArrears).
     */
    totalPaid: {
      type: Number,
      default: 0,
      min: [0, 'totalPaid cannot be negative'],
    },
    /**
     * Remaining balance = (feeAmount + carriedArrears) - totalPaid.
     * Recomputed on each payment.
     */
    remainingBalance: {
      type: Number,
      default: null,
    },
    /**
     * Whether the student has fully settled this period's obligation.
     */
    feePaid: {
      type: Boolean,
      default: false,
      index: true,
    },
    /**
     * Optional payment deadline for this specific assignment.
     * Overrides the period's endsAt for reminder purposes.
     */
    paymentDeadline: {
      type: Date,
      default: null,
    },
    /**
     * Manual credit adjustments applied by admins for this period.
     */
    creditAdjustments: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Uniqueness: one fee assignment per student per period.
studentPeriodFeeSchema.index(
  { schoolId: 1, studentId: 1, periodId: 1 },
  { unique: true }
);
// Fast look-up of all assignments for a period (for rollover and reporting).
studentPeriodFeeSchema.index({ schoolId: 1, periodId: 1 });
// Unpaid students within a period (for reminders).
studentPeriodFeeSchema.index({ schoolId: 1, periodId: 1, feePaid: 1 });

module.exports = mongoose.model('StudentPeriodFee', studentPeriodFeeSchema);
