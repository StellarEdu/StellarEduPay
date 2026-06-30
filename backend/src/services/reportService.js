'use strict';

const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const FeeStructure = require('../models/feeStructureModel');

/**
 * Get the data version for cache key generation.
 * Returns the timestamp of the most recent confirmed payment for a school,
 * which can be used to invalidate cached reports when data changes.
 *
 * @param {string} schoolId
 * @returns {Promise<string>} ISO timestamp or '0' if no payments
 */
async function getDataVersion(schoolId) {
  const latest = await Payment.findOne(
    { schoolId, status: 'SUCCESS', deletedAt: null },
    'confirmedAt'
  ).sort({ confirmedAt: -1 }).lean();

  return latest?.confirmedAt ? new Date(latest.confirmedAt).toISOString() : '0';
}

/**
 * Aggregate confirmed payments grouped by date (YYYY-MM-DD), scoped to a school.
 *
 * @param {{ schoolId: string, startDate?: string, endDate?: string, timezone?: string }} options
 */
async function aggregateByDate({ schoolId, startDate, endDate, timezone = 'UTC' } = {}) {
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };

  if (startDate || endDate) {
    match.confirmedAt = {};
    if (startDate) match.confirmedAt.$gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate)   match.confirmedAt.$lte = new Date(endDate   + 'T23:59:59.999Z');
  }

  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$confirmedAt', timezone } },
        totalAmount:   { $sum: '$amount' },
        paymentCount:  { $sum: 1 },
        validCount:    { $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'valid'] }, 1, 0] } },
        overpaidCount: { $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'overpaid'] }, 1, 0] } },
        underpaidCount:{ $sum: { $cond: [{ $eq: ['$feeValidationStatus', 'underpaid'] }, 1, 0] } },
        uniqueStudents:{ $addToSet: '$studentId' },
        // #883 — sum historical fiat amounts from locked snapshots
        totalFiatAmount:{ $sum: { $ifNull: ['$fiatSnapshot.fiatAmount', 0] } },
        fiatCurrency:  { $first: '$fiatSnapshot.fiatCurrency' },
      },
    },
    {
      $project: {
        _id: 0,
        date: '$_id',
        totalAmount: { $round: ['$totalAmount', 7] },
        paymentCount: 1,
        validCount: 1,
        overpaidCount: 1,
        underpaidCount: 1,
        uniqueStudentCount: { $size: '$uniqueStudents' },
        totalFiatAmount: { $round: ['$totalFiatAmount', 2] },
        fiatCurrency: 1,
      },
    },
    { $sort: { date: 1 } },
  ], { hint: { schoolId: 1, status: 1, confirmedAt: -1 } });

  return rows;
}

/**
 * Build a full summary report for one school.
 * Includes all students, even those with no payment history.
 *
 * @param {{ schoolId: string, startDate?: string, endDate?: string, timezone?: string }} options
 */
async function generateReport({ schoolId, startDate, endDate, timezone = 'UTC' } = {}) {
  const byDate = await aggregateByDate({ schoolId, startDate, endDate, timezone });

  const totals = byDate.reduce(
    (acc, row) => {
      acc.totalAmount    = parseFloat((acc.totalAmount + row.totalAmount).toFixed(7));
      acc.paymentCount  += row.paymentCount;
      acc.validCount    += row.validCount;
      acc.overpaidCount += row.overpaidCount;
      acc.underpaidCount+= row.underpaidCount;
      return acc;
    },
    { totalAmount: 0, paymentCount: 0, validCount: 0, overpaidCount: 0, underpaidCount: 0 }
  );

  // Count students who have fully paid within the period
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };
  if (startDate || endDate) {
    match.confirmedAt = {};
    if (startDate) match.confirmedAt.$gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate)   match.confirmedAt.$lte = new Date(endDate   + 'T23:59:59.999Z');
  }

  const paidStudentIds = await Payment.distinct('studentId', match);
  const fullyPaidCount = await Student.countDocuments({
    schoolId,
    studentId: { $in: paidStudentIds },
    feePaid: true,
  });

  // Per-class breakdown: start from Student collection and lookup payments
  // This ensures students with no payments are included
  const byClass = await Student.aggregate([
    { $match: { schoolId, deletedAt: null } },
    {
      $lookup: {
        from: 'payments',
        let: { studentId: '$studentId' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$studentId', '$$studentId'] },
              schoolId,
              status: 'SUCCESS',
              studentDeleted: { $ne: true },
              deletedAt: null,
            },
          },
          {
            $match: startDate || endDate ? {
              confirmedAt: {
                ...(startDate ? { $gte: new Date(startDate + 'T00:00:00.000Z') } : {}),
                ...(endDate ? { $lte: new Date(endDate + 'T23:59:59.999Z') } : {}),
              },
            } : {},
          },
        ],
        as: 'payments',
      },
    },
    {
      $group: {
        _id: '$class',
        totalCollected: { $sum: { $sum: '$payments.amount' } },
        paymentCount: { $sum: { $size: '$payments' } },
        paidStudentIds: { $addToSet: { $cond: ['$feePaid', '$studentId', '$$REMOVE'] } },
        unpaidStudentIds: { $addToSet: { $cond: ['$feePaid', '$$REMOVE', '$studentId'] } },
      },
    },
    {
      $project: {
        _id: 0,
        className: '$_id',
        totalCollected: { $round: ['$totalCollected', 7] },
        paymentCount: 1,
        paidCount: { $size: '$paidStudentIds' },
        unpaidCount: { $size: '$unpaidStudentIds' },
      },
    },
    { $sort: { className: 1 } },
  ]);

  // Calculate dateRangeDays to indicate actual range returned
  let dateRangeDays = null;
  if (startDate && endDate) {
    const start = new Date(startDate + 'T00:00:00.000Z');
    const end = new Date(endDate + 'T23:59:59.999Z');
    dateRangeDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    schoolId,
    period: { startDate: startDate || null, endDate: endDate || null },
    dateRangeDays,
    summary: { ...totals, fullyPaidStudentCount: fullyPaidCount },
    byDate,
    byClass,
  };
}

/**
 * Escape a single CSV field value per RFC 4180.
 * Wraps in double-quotes when the value contains a comma, double-quote, or newline.
 * Internal double-quotes are doubled ("").
 * Leading formula-injection characters (=, +, -, @, tab, CR) are prefixed with
 * a single-quote so spreadsheet apps do not evaluate them as formulas.
 *
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
  let str = String(value ?? '');
  // Neutralize CSV injection: prefix with single-quote if the value starts with
  // a formula-trigger character.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert a report object to CSV string.
 * All user-supplied string fields (school name, class name, etc.) are passed
 * through csvEscape so that commas, quotes, and newlines do not break parsers.
 */
function reportToCsv(report) {
  const lines = [];
  lines.push(`Generated At,${csvEscape(report.generatedAt)}`);
  lines.push(`School ID,${csvEscape(report.schoolId)}`);
  lines.push(`Period Start,${csvEscape(report.period.startDate || 'all time')}`);
  lines.push(`Period End,${csvEscape(report.period.endDate || 'all time')}`);
  if (report.dateRangeDays !== null) {
    lines.push(`Date Range Days,${csvEscape(report.dateRangeDays)}`);
  }
  lines.push('');
  lines.push('--- Summary ---');
  lines.push(`Total Amount,${csvEscape(report.summary.totalAmount)}`);
  lines.push(`Total Payments,${csvEscape(report.summary.paymentCount)}`);
  lines.push(`Valid Payments,${csvEscape(report.summary.validCount)}`);
  lines.push(`Overpaid,${csvEscape(report.summary.overpaidCount)}`);
  lines.push(`Underpaid,${csvEscape(report.summary.underpaidCount)}`);
  lines.push(`Fully Paid Students,${csvEscape(report.summary.fullyPaidStudentCount)}`);
  lines.push('');
  lines.push('--- Daily Breakdown ---');
  lines.push('Date,Total Amount,Payment Count,Valid,Overpaid,Underpaid,Unique Students');
  for (const row of report.byDate) {
    lines.push([
      csvEscape(row.date),
      csvEscape(row.totalAmount),
      csvEscape(row.paymentCount),
      csvEscape(row.validCount),
      csvEscape(row.overpaidCount),
      csvEscape(row.underpaidCount),
      csvEscape(row.uniqueStudentCount),
    ].join(','));
  }
  if (report.byClass && report.byClass.length > 0) {
    lines.push('');
    lines.push('--- Class Breakdown ---');
    lines.push('Class,Total Collected,Payment Count,Paid Students,Unpaid Students');
    for (const row of report.byClass) {
      lines.push([
        csvEscape(row.className),
        csvEscape(row.totalCollected),
        csvEscape(row.paymentCount),
        csvEscape(row.paidCount),
        csvEscape(row.unpaidCount),
      ].join(','));
    }
  }
  return lines.join('\n');
}

/**
 * Aggregate dashboard metrics for a school.
 * #881 — Reads all-time and today totals from pre-aggregated rollups (O(1));
 * falls back to raw aggregation if no rollup exists yet.
 * @param {{ schoolId: string, timezone?: string }} options
 */
async function getDashboardMetrics({ schoolId, timezone = 'UTC' } = {}) {
  const { DailyMetrics, MonthlyMetrics } = require('../models/metricsModel');
  const now = new Date();

  // Today's key in UTC
  const todayKey = now.toISOString().slice(0, 10);

  const [
    totalStudents,
    paidStudents,
    overdueStudents,
    allTimeRollup,   // sum of all MonthlyMetrics for this school
    todayRollup,     // DailyMetrics for today
    byClass,
    recentPayments,
    feeAgg,
  ] = await Promise.all([
    Student.countDocuments({ schoolId }),
    Student.countDocuments({ schoolId, feePaid: true }),
    Student.countDocuments({ schoolId, feePaid: false, paymentDeadline: { $lt: now, $ne: null } }),

    // All-time totals from monthly rollups (O(months), not O(payments))
    MonthlyMetrics.aggregate([
      { $match: { schoolId } },
      { $group: { _id: null, totalCollected: { $sum: '$totalAmount' }, count: { $sum: '$paymentCount' } } },
    ]),

    // Today from daily rollup (O(1) point-read)
    DailyMetrics.findOne({ schoolId, period: todayKey }).lean(),

    // Per-class breakdown (from Student collection — these are small)
    Student.aggregate([
      { $match: { schoolId } },
      {
        $group: {
          _id: '$class',
          totalStudents: { $sum: 1 },
          paidStudents:  { $sum: { $cond: ['$feePaid', 1, 0] } },
          totalFees:     { $sum: '$feeAmount' },
          totalPaid:     { $sum: '$totalPaid' },
        },
      },
      {
        $project: {
          _id: 0,
          class: '$_id',
          totalStudents: 1,
          paidStudents: 1,
          unpaidStudents: { $subtract: ['$totalStudents', '$paidStudents'] },
          totalFees:  { $round: ['$totalFees', 7] },
          totalPaid:  { $round: ['$totalPaid', 7] },
          outstanding: { $round: [{ $subtract: ['$totalFees', '$totalPaid'] }, 7] },
        },
      },
      { $sort: { class: 1 } },
    ]),

    // 5 most recent successful payments (small bounded query, always fast)
    Payment.find({ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null })
      .sort({ confirmedAt: -1 })
      .limit(5)
      .select('txHash studentId amount feeValidationStatus confirmedAt')
      .lean(),

    Student.aggregate([
      { $match: { schoolId } },
      { $group: { _id: null, totalExpected: { $sum: '$feeAmount' }, totalPaid: { $sum: '$totalPaid' } } },
    ]),
  ]);

  const collected = allTimeRollup[0] || { totalCollected: 0, count: 0 };
  const today     = { totalCollected: todayRollup?.totalAmount || 0, count: todayRollup?.paymentCount || 0 };
  const feeRow    = feeAgg[0] || { totalExpected: 0, totalPaid: 0 };

  return {
    generatedAt: now.toISOString(),
    fromRollup: true,
    students: {
      total:   totalStudents,
      paid:    paidStudents,
      unpaid:  totalStudents - paidStudents,
      overdue: overdueStudents,
    },
    fees: {
      totalExpected:  parseFloat(feeRow.totalExpected.toFixed(7)),
      totalCollected: parseFloat(collected.totalCollected.toFixed(7)),
      outstanding:    parseFloat(Math.max(0, feeRow.totalExpected - feeRow.totalPaid).toFixed(7)),
      collectionRate: feeRow.totalExpected > 0
        ? parseFloat((feeRow.totalPaid / feeRow.totalExpected * 100).toFixed(2))
        : 0,
    },
    today: {
      totalCollected: parseFloat(today.totalCollected.toFixed(7)),
      paymentCount:   today.count,
    },
    byClass,
    recentPayments,
  };
}

/**
 * #884 — Versioned accounting export.
 *
 * Produces a flat transaction-level CSV with a stable, documented schema
 * that accounting systems (QuickBooks, Xero, custom) can import reliably.
 *
 * Schema version 1 columns (never removed; new columns added at the end):
 *   schema_version, exported_at, school_id, tx_hash, student_id, class,
 *   confirmed_at, asset_code, asset_type, crypto_amount, fee_amount,
 *   fee_validation_status, excess_amount, fiat_amount_at_payment,
 *   fiat_currency_at_payment, fiat_rate_at_payment, reference_code, status
 *
 * The schema_version column and the X-Export-Schema-Version response header
 * let consumers pin to a specific version and detect breaking changes.
 */

// Current accounting export schema version — increment when columns change shape.
const ACCOUNTING_SCHEMA_VERSION = 1;

const ACCOUNTING_HEADERS_V1 = [
  'schema_version', 'exported_at', 'school_id', 'tx_hash', 'student_id', 'class',
  'confirmed_at', 'asset_code', 'asset_type', 'crypto_amount', 'fee_amount',
  'fee_validation_status', 'excess_amount',
  'fiat_amount_at_payment', 'fiat_currency_at_payment', 'fiat_rate_at_payment',
  'reference_code', 'status',
];

/**
 * Build the accounting CSV for a school, pulling transaction-level rows
 * directly from the payments collection so every payment appears as one line.
 *
 * @param {{ schoolId: string, startDate?: string, endDate?: string }} options
 * @returns {{ csv: string, schemaVersion: number }}
 */
async function generateAccountingCsv({ schoolId, startDate, endDate } = {}) {
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };
  if (startDate || endDate) {
    match.confirmedAt = {};
    if (startDate) match.confirmedAt.$gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate)   match.confirmedAt.$lte = new Date(endDate   + 'T23:59:59.999Z');
  }

  // Enrich with student class via a $lookup
  const rows = await Payment.aggregate([
    { $match: match },
    {
      $lookup: {
        from: 'students',
        let: { sid: '$studentId', scid: '$schoolId' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$studentId', '$$sid'] }, { $eq: ['$schoolId', '$$scid'] }] } } },
          { $project: { class: 1 } },
        ],
        as: '_student',
      },
    },
    { $sort: { confirmedAt: 1 } },
  ]);

  const exportedAt = new Date().toISOString();
  const lines = [ACCOUNTING_HEADERS_V1.map(csvEscape).join(',')];

  for (const r of rows) {
    const studentClass = r._student?.[0]?.class ?? '';
    // #883 — use stored fiat snapshot when available, else leave blank
    const fiatAmount   = r.fiatSnapshot?.fiatAmount   ?? '';
    const fiatCurrency = r.fiatSnapshot?.fiatCurrency ?? '';
    const fiatRate     = r.fiatSnapshot?.fiatRate     ?? '';

    lines.push([
      ACCOUNTING_SCHEMA_VERSION,
      exportedAt,
      csvEscape(r.schoolId),
      csvEscape(r.txHash),
      csvEscape(r.studentId),
      csvEscape(studentClass),
      r.confirmedAt ? new Date(r.confirmedAt).toISOString() : '',
      csvEscape(r.assetCode ?? 'XLM'),
      csvEscape(r.assetType ?? 'crypto'),
      r.amount,
      r.feeAmount ?? '',
      csvEscape(r.feeValidationStatus ?? ''),
      r.excessAmount ?? 0,
      fiatAmount,
      csvEscape(fiatCurrency),
      fiatRate,
      csvEscape(r.referenceCode ?? ''),
      csvEscape(r.status),
    ].map(v => csvEscape(v)).join(','));
  }

  return { csv: lines.join('\n'), schemaVersion: ACCOUNTING_SCHEMA_VERSION };
}

module.exports = {
  generateReport,
  aggregateByDate,
  reportToCsv,
  generateAccountingCsv,
  ACCOUNTING_SCHEMA_VERSION,
  getDashboardMetrics,
  getDataVersion,
};
