'use strict';

// #881 — Materialized aggregates for dashboard / trend queries.
// Each document holds pre-rolled-up totals for one school per day or month.
// Updated incrementally on payment.saved and reconciled by a scheduled job.

const mongoose = require('mongoose');

const metricsShape = {
  schoolId:      { type: String, required: true },
  // 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly
  period:        { type: String, required: true },
  paymentCount:  { type: Number, default: 0 },
  totalAmount:   { type: Number, default: 0 },   // crypto
  totalFiatAmount: { type: Number, default: 0 }, // fiat (from stored snapshots)
  fiatCurrency:  { type: String, default: null },
  validCount:    { type: Number, default: 0 },
  overpaidCount: { type: Number, default: 0 },
  underpaidCount:{ type: Number, default: 0 },
  uniqueStudents:{ type: Number, default: 0 },
  reconciledAt:  { type: Date, default: null },  // last full reconciliation
};

const dailyMetricsSchema = new mongoose.Schema(metricsShape, { timestamps: true });
dailyMetricsSchema.index({ schoolId: 1, period: 1 }, { unique: true });

const monthlyMetricsSchema = new mongoose.Schema(metricsShape, { timestamps: true });
monthlyMetricsSchema.index({ schoolId: 1, period: 1 }, { unique: true });

const DailyMetrics   = mongoose.model('DailyMetrics',   dailyMetricsSchema);
const MonthlyMetrics = mongoose.model('MonthlyMetrics', monthlyMetricsSchema);

module.exports = { DailyMetrics, MonthlyMetrics };
