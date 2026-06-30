'use strict';

const mongoose = require('mongoose');

const REPORT_STATUSES = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const reportJobSchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    jobId: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      enum: ['report', 'accounting_csv'],
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(REPORT_STATUSES),
      required: true,
      index: true,
    },
    params: {
      startDate: { type: String, default: null },
      endDate: { type: String, default: null },
      timezone: { type: String, default: 'UTC' },
      schemaVersion: { type: Number, default: null },
    },
    result: {
      report: { type: mongoose.Schema.Types.Mixed, default: null },
      csv: { type: String, default: null },
      schemaVersion: { type: Number, default: null },
      error: { type: String, default: null },
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

reportJobSchema.index({ schoolId: 1, createdAt: -1 });
reportJobSchema.index({ status: 1, createdAt: -1 });
reportJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

reportJobSchema.virtual('downloadUrl').get(function () {
  return `/api/reports/jobs/${this.jobId}/download`;
});

reportJobSchema.virtual('statusUrl').get(function () {
  return `/api/reports/jobs/${this.jobId}`;
});

reportJobSchema.set('toJSON', { virtuals: true });
reportJobSchema.set('toObject', { virtuals: true });

module.exports = {
  ReportJob: mongoose.model('ReportJob', reportJobSchema),
  REPORT_STATUSES,
};