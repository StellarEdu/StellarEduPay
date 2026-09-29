'use strict';

/**
 * AcademicPeriod — school-scoped term/academic-year model (Issue #1569).
 *
 * Each school can define one or more academic periods (terms, semesters, full
 * years) and mark exactly one as the current period.  Fee structures and
 * student fee assignments are linked to a period; balances and reports can then
 * be filtered by period while arrears are carried forward explicitly across
 * rollovers.
 *
 * Example periods:
 *   { name: '2026/27 Term 1', startsAt: 2026-09-01, endsAt: 2026-12-20, isCurrent: true }
 *   { name: '2026/27 Term 2', startsAt: 2027-01-08, endsAt: 2027-04-11, isCurrent: false }
 */

const mongoose = require('mongoose');

const academicPeriodSchema = new mongoose.Schema(
  {
    schoolId: {
      type: String,
      required: true,
      index: true,
    },
    /**
     * Human-readable name, e.g. "2026/27 Term 1", "2026 Second Semester".
     * Must be unique per school.
     */
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [100, 'Period name must not exceed 100 characters'],
    },
    /**
     * Inclusive start date (UTC midnight) of the academic period.
     */
    startsAt: {
      type: Date,
      required: true,
    },
    /**
     * Inclusive end date (UTC end-of-day) of the academic period.
     */
    endsAt: {
      type: Date,
      required: true,
    },
    /**
     * Exactly one period per school should be current.  The rollover action
     * sets this to true on the new period and false on all others atomically.
     */
    isCurrent: {
      type: Boolean,
      default: false,
      index: true,
    },
    /**
     * Whether this period has been closed/archived.
     * A closed period cannot receive new fee assignments.
     */
    isClosed: {
      type: Boolean,
      default: false,
      index: true,
    },
    /**
     * Cumulative arrears carried forward INTO this period from the previous
     * period's rollover.  Stored at the period level as an aggregate figure for
     * quick reporting; the per-student breakdown lives in StudentPeriodFee.
     */
    carriedForwardArrears: {
      type: Number,
      default: 0,
      min: [0, 'carriedForwardArrears cannot be negative'],
    },
    /**
     * Optional human-readable notes (e.g. reason for a mid-year period split).
     */
    notes: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// A period name must be unique within a school.
academicPeriodSchema.index({ schoolId: 1, name: 1 }, { unique: true });
// Fast look-up of the current period for a school.
academicPeriodSchema.index({ schoolId: 1, isCurrent: 1 });
// Chronological listing per school.
academicPeriodSchema.index({ schoolId: 1, startsAt: 1 });

module.exports = mongoose.model('AcademicPeriod', academicPeriodSchema);
