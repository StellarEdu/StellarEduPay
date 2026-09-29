'use strict';

const Payment = require('../models/paymentModel');
const { csvEscape } = require('../utils/csv');
const Student = require('../models/studentModel');
const FeeStructure = require('../models/feeStructureModel');
const { POOL_CONFIG } = require('../config/database');

/**
 * Convert a local calendar date string (YYYY-MM-DD) and an IANA timezone to a
 * UTC Date representing the **start** of that calendar day in that timezone.
 *
 * Uses the Intl API to find the UTC offset at that local midnight, so it handles
 * DST transitions correctly (e.g. on the day clocks go forward/back, the
 * calendar day is shorter/longer than 24 h).
 *
 * Issue #1572 — replaces the old pattern of appending 'T00:00:00.000Z' which
 * forced UTC boundaries regardless of the school's timezone.
 *
 * @param {string} dateStr   YYYY-MM-DD local calendar date
 * @param {string} timezone  IANA timezone (e.g. 'Pacific/Port_Moresby', 'America/New_York')
 * @returns {Date}           UTC Date for the start of that local day
 */
function localDayStartUTC(dateStr, timezone) {
  // Parse the local date parts
  const [year, month, day] = dateStr.split('-').map(Number);

  // Build a reference instant: treat the date as UTC midnight first, then use
  // Intl to find what UTC offset applies in the target timezone at that time.
  // We iterate once because the offset itself can change near midnight.
  let approxUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  // Determine the UTC offset (in minutes) that the timezone has at this moment.
  // We use Intl.DateTimeFormat to format the same instant in the target timezone
  // and in UTC, then diff the two representations.
  for (let pass = 0; pass < 2; pass++) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    // Format the approxUtc instant in the target timezone
    const parts = fmt.formatToParts(new Date(approxUtc));
    const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
    const localYear  = get('year');
    const localMonth = get('month');
    const localDay   = get('day');
    const localHour  = get('hour') % 24; // guard against 24:00 representation
    const localMin   = get('minute');
    const localSec   = get('second');

    // Compute how far off we are from local midnight
    const localMsFromMidnight = (localHour * 3600 + localMin * 60 + localSec) * 1000;
    // Also adjust if the date shifted (can happen near DST transitions)
    const dateDiff = Date.UTC(year, month - 1, day) -
                     Date.UTC(localYear, localMonth - 1, localDay);

    approxUtc = approxUtc - localMsFromMidnight + dateDiff;
  }

  return new Date(approxUtc);
}

/**
 * UTC Date for the **exclusive** end of a local calendar day: i.e. the start
 * of the next calendar day in the timezone. Used in half-open interval queries:
 *   confirmedAt >= localDayStartUTC(startDate)
 *   confirmedAt <  localDayEndUTC(endDate)
 *
 * A half-open interval avoids the '23:59:59.999' millisecond edge case.
 *
 * @param {string} dateStr   YYYY-MM-DD local calendar date
 * @param {string} timezone  IANA timezone
 * @returns {Date}
 */
function localDayEndUTC(dateStr, timezone) {
  // End of day = start of the *next* calendar day
  const [year, month, day] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)); // safe — Date handles overflow
  const nextStr = next.toISOString().slice(0, 10);           // YYYY-MM-DD of next day
  return localDayStartUTC(nextStr, timezone);
}

/**
 * Build a confirmedAt range filter using timezone-aware boundaries (Issue #1572).
 * Returns an object suitable for spreading into a $match.confirmedAt constraint,
 * or an empty object if neither bound is supplied.
 *
 * Uses a half-open interval [start, end) to avoid edge cases at 23:59:59.999.
 *
 * @param {{ startDate?: string, endDate?: string, timezone?: string }} opts
 * @returns {object} e.g. { $gte: Date, $lt: Date }
 */
function buildDateRangeFilter({ startDate, endDate, timezone = 'UTC' }) {
  const filter = {};
  if (startDate) filter.$gte = localDayStartUTC(startDate, timezone);
  if (endDate)   filter.$lt  = localDayEndUTC(endDate, timezone);
  return filter;
}

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
 * @param {{ schoolId: string, startDate?: string, endDate?: string, timezone?: string, periodId?: string }} options
 */
async function aggregateByDate({ schoolId, startDate, endDate, timezone = 'UTC', periodId } = {}) {
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };

  // Issue #1572 — use timezone-aware boundaries so a report for 'YYYY-MM-DD to
  // YYYY-MM-DD' captures exactly the payments whose local confirmation date
  // falls in that range, regardless of the school's UTC offset.
  if (startDate || endDate) {
    match.confirmedAt = buildDateRangeFilter({ startDate, endDate, timezone });
  }

  // Issue #1569 — optional period-scoped filter: if periodId is supplied,
  // narrow the date range to the period's startsAt/endsAt boundaries.
  if (periodId) {
    const AcademicPeriod = require('../models/academicPeriodModel');
    const period = await AcademicPeriod.findOne({ _id: periodId, schoolId }).lean();
    if (period) {
      if (!match.confirmedAt) match.confirmedAt = {};
      if (!match.confirmedAt.$gte || period.startsAt > match.confirmedAt.$gte) {
        match.confirmedAt.$gte = period.startsAt;
      }
      if (!match.confirmedAt.$lte || period.endsAt < match.confirmedAt.$lte) {
        match.confirmedAt.$lte = period.endsAt;
      }
    }
  }

  const rows = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        // #1362 — confirmedAt may be null for payments recorded but not yet
        // confirmed (e.g. recorded via sync before the horizon confirmation).
        // Fall back to updatedAt so these payments are bucketed to a real date
        // rather than grouped under a null key and sorted before all real dates.
        _id: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$confirmedAt', '$updatedAt'] }, timezone } },
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
  ], {
    hint: { schoolId: 1, status: 1, confirmedAt: -1 },
    maxTimeMS: POOL_CONFIG.reportAggregationMaxTimeMS,
  });

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
    // Issue #1572 — consistent with aggregateByDate: use timezone-aware boundaries.
    match.confirmedAt = buildDateRangeFilter({ startDate, endDate, timezone });
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
              // Issue #1572 — timezone-aware boundaries for the $lookup sub-pipeline.
              confirmedAt: buildDateRangeFilter({ startDate, endDate, timezone }),
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
  ], { maxTimeMS: POOL_CONFIG.reportAggregationMaxTimeMS });

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
    ], { maxTimeMS: POOL_CONFIG.reportAggregationMaxTimeMS }),

    // Today from daily rollup (O(1) point-read)
    DailyMetrics.findOne({ schoolId, period: todayKey }).lean(),

    // Per-class breakdown (from Student collection — these are small)
    Student.aggregate([
      { $match: Student.activeFilter({ schoolId }) },
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
    ], { maxTimeMS: POOL_CONFIG.reportAggregationMaxTimeMS }),

    // 5 most recent successful payments (small bounded query, always fast)
    Payment.find({ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null })
      .sort({ confirmedAt: -1 })
      .limit(5)
      .select('txHash studentId amount feeValidationStatus confirmedAt')
      .lean(),

    Student.aggregate([
      { $match: Student.activeFilter({ schoolId }) },
      { $group: { _id: null, totalExpected: { $sum: '$feeAmount' }, totalPaid: { $sum: '$totalPaid' } } },
    ], { maxTimeMS: POOL_CONFIG.reportAggregationMaxTimeMS }),
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
// Build the $match / $lookup / $sort pipeline shared by the buffered and
// streaming accounting exports.
function buildAccountingPipeline({ schoolId, startDate, endDate }) {
  const match = { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null };
  if (startDate || endDate) {
    match.confirmedAt = {};
    if (startDate) match.confirmedAt.$gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate)   match.confirmedAt.$lte = new Date(endDate   + 'T23:59:59.999Z');
  }

  return [
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
  ];
}

// Format a single aggregation row as one CSV line (no trailing newline).
function formatAccountingRow(r, exportedAt) {
  const studentClass = r._student?.[0]?.class ?? '';
  // #883 — use stored fiat snapshot when available, else leave blank
  const fiatAmount   = r.fiatSnapshot?.fiatAmount   ?? '';
  const fiatCurrency = r.fiatSnapshot?.fiatCurrency ?? '';
  const fiatRate     = r.fiatSnapshot?.fiatRate     ?? '';

  return [
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
  ].map(v => csvEscape(v)).join(',');
}

async function generateAccountingCsv({ schoolId, startDate, endDate } = {}) {
  // Enrich with student class via a $lookup
  const rows = await Payment.aggregate(buildAccountingPipeline({ schoolId, startDate, endDate }));

  const exportedAt = new Date().toISOString();
  const lines = [ACCOUNTING_HEADERS_V1.map(csvEscape).join(',')];

  for (const r of rows) {
    lines.push(formatAccountingRow(r, exportedAt));
  }

  return { csv: lines.join('\n'), schemaVersion: ACCOUNTING_SCHEMA_VERSION };
}

/**
 * Streaming variant of {@link generateAccountingCsv} (Issue #70).
 *
 * Reads the payments collection with an aggregation cursor and writes each
 * row to `res` as it arrives, so the full result set is never buffered in
 * memory. Writes the header row first, then one line per payment, then ends
 * the response.
 *
 * @param {{ schoolId: string, startDate?: string, endDate?: string, res: object }} options
 */
async function generateAccountingCsvStream({ schoolId, startDate, endDate, res } = {}) {
  const cursor = Payment.aggregate(buildAccountingPipeline({ schoolId, startDate, endDate })).cursor();
  const exportedAt = new Date().toISOString();

  res.write(ACCOUNTING_HEADERS_V1.map(csvEscape).join(',') + '\n');

  for await (const r of cursor) {
    res.write(formatAccountingRow(r, exportedAt) + '\n');
  }

  res.end();
  return { schemaVersion: ACCOUNTING_SCHEMA_VERSION };
}

module.exports = {
  generateReport,
  aggregateByDate,
  reportToCsv,
  generateAccountingCsv,
  generateAccountingCsvStream,
  ACCOUNTING_SCHEMA_VERSION,
  getDashboardMetrics,
  getDataVersion,
  // Exported for testing (Issue #1572)
  localDayStartUTC,
  localDayEndUTC,
  buildDateRangeFilter,
};
