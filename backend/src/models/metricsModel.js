'use strict';

// #881 — Materialized aggregates for dashboard / trend queries.
// Each document holds pre-rolled-up totals for one school per day or month.
// Updated incrementally on payment.saved and reconciled by a scheduled job.

const mongoose = require('mongoose');

// #1373 — Daily rollups grow without bound: one document per school per day,
// forever. Only today's document is ever read (reportService reads it as a
// point-read for the dashboard), so old ones are dead weight in storage and in
// the unique index. A TTL index lets MongoDB reclaim them.
//
// Monthly rollups are deliberately NOT expired. getDashboardMetrics derives
// all-time totals by summing MonthlyMetrics, so dropping old months would
// silently shrink historical figures rather than just free space. They are also
// tiny — twelve documents per school per year.
// 400 days keeps a full year plus headroom, so a year-over-year read added
// later still has data. Seconds, matching PAYMENT_INTENT_TTL_SECONDS.
const DAILY_METRICS_TTL_SECONDS = parseInt(
  process.env.DAILY_METRICS_TTL_SECONDS || String(400 * 24 * 60 * 60),
  10
);

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
dailyMetricsSchema.index({ createdAt: 1 }, { expireAfterSeconds: DAILY_METRICS_TTL_SECONDS });

const monthlyMetricsSchema = new mongoose.Schema(metricsShape, { timestamps: true });
monthlyMetricsSchema.index({ schoolId: 1, period: 1 }, { unique: true });

const DailyMetrics   = mongoose.model('DailyMetrics',   dailyMetricsSchema);
const MonthlyMetrics = mongoose.model('MonthlyMetrics', monthlyMetricsSchema);

module.exports = { DailyMetrics, MonthlyMetrics, DAILY_METRICS_TTL_SECONDS };
