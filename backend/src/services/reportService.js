'use strict';

const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const FeeStructure = require('../models/feeStructureModel');

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
 * Escape a single CSV field value.
 * Wraps the value in double-quotes if it contains a comma, double-quote, or newline.
 * Internal double-quotes are escaped by doubling them ("" per RFC 4180).
 *
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
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
 * @param {{ schoolId: string, timezone?: string }} options
 */
async function getDashboardMetrics({ schoolId, timezone = 'UTC' } = {}) {
  // Calculate start of today in the school's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const dateMap = {};
  parts.forEach(p => { dateMap[p.type] = p.value; });
  const todayStr = `${dateMap.year}-${dateMap.month}-${dateMap.day}`;
  const startOfToday = new Date(todayStr + 'T00:00:00.000Z');

  const [
    totalStudents,
    paidStudents,
    overdueStudents,
    paymentTotals,
    todayTotals,
    byClass,
    recentPayments,
  ] = await Promise.all([
    Student.countDocuments({ schoolId }),
    Student.countDocuments({ schoolId, feePaid: true }),
    Student.countDocuments({ schoolId, feePaid: false, paymentDeadline: { $lt: now, $ne: null } }),

    // All-time confirmed payment totals
    Payment.aggregate([
      { $match: { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null } },
      { $group: { _id: null, totalCollected: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // Today's payments
    Payment.aggregate([
      { $match: { schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null, confirmedAt: { $gte: startOfToday } } },
      { $group: { _id: null, totalCollected: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // Per-class breakdown
    Student.aggregate([
      { $match: { schoolId } },
      {
        $group: {
          _id: '$class',
          totalStudents:  { $sum: 1 },
          paidStudents:   { $sum: { $cond: ['$feePaid', 1, 0] } },
          totalFees:      { $sum: '$feeAmount' },
          totalPaid:      { $sum: '$totalPaid' },
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

    // 5 most recent successful payments
    Payment.find({ schoolId, status: 'SUCCESS', studentDeleted: { $ne: true }, deletedAt: null })
      .sort({ confirmedAt: -1 })
      .limit(5)
      .select('txHash studentId amount feeValidationStatus confirmedAt')
      .lean(),
  ]);

  const collected = paymentTotals[0] || { totalCollected: 0, count: 0 };
  const today     = todayTotals[0]   || { totalCollected: 0, count: 0 };

  // Expected total fees across all students
  const feeAgg = await Student.aggregate([
    { $match: { schoolId } },
    { $group: { _id: null, totalExpected: { $sum: '$feeAmount' }, totalPaid: { $sum: '$totalPaid' } } },
  ]);
  const feeRow = feeAgg[0] || { totalExpected: 0, totalPaid: 0 };

  return {
    generatedAt: now.toISOString(),
    students: {
      total:   totalStudents,
      paid:    paidStudents,
      unpaid:  totalStudents - paidStudents,
      overdue: overdueStudents,
    },
    fees: {
      totalExpected:   parseFloat(feeRow.totalExpected.toFixed(7)),
      totalCollected:  parseFloat(collected.totalCollected.toFixed(7)),
      outstanding:     parseFloat(Math.max(0, feeRow.totalExpected - feeRow.totalPaid).toFixed(7)),
      collectionRate:  feeRow.totalExpected > 0
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

module.exports = { generateReport, aggregateByDate, reportToCsv, getDashboardMetrics };
