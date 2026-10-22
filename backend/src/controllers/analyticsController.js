'use strict';

const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');

async function getPaymentVolumeTrend(req, res, next) {
  try {
    const { schoolId } = req;
    const { period = 'daily' } = req.query;

    let dateFormat;
    if (period === 'daily') {
      dateFormat = '%Y-%m-%d';
    } else if (period === 'weekly') {
      dateFormat = '%Y-W%V';
    } else if (period === 'monthly') {
      dateFormat = '%Y-%m';
    } else {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly', code: 'VALIDATION_ERROR' });
    }

    const trend = await Payment.aggregate([
      { $match: { schoolId, deletedAt: null, status: 'SUCCESS' } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: dateFormat, date: '$confirmedAt' } },
            assetCode: '$assetCode',
          },
          totalAmount: { $sum: '$amount' },
          paymentCount: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1, '_id.assetCode': 1 } },
      {
        $group: {
          _id: '$_id.date',
          assets: {
            $push: {
              assetCode: '$_id.assetCode',
              totalAmount: '$totalAmount',
              paymentCount: '$paymentCount',
            },
          },
          paymentCount: { $sum: '$paymentCount' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          date: '$_id',
          totals: {
            $arrayToObject: {
              $map: {
                input: '$assets',
                as: 'a',
                in: {
                  k: { $ifNull: ['$$a.assetCode', 'UNKNOWN'] },
                  v: { $toString: '$$a.totalAmount' },
                },
              },
            },
          },
          paymentCount: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ data: trend, period });
  } catch (err) {
    next(err);
  }
}

async function getClassPaymentCompletion(req, res, next) {
  try {
    const { schoolId } = req;

    const completion = await Student.aggregate([
      { $match: { schoolId, deletedAt: null } },
      {
        $group: {
          _id: '$class',
          total: { $sum: 1 },
          paid: {
            $sum: { $cond: ['$feePaid', 1, 0] },
          },
          unpaid: {
            $sum: { $cond: ['$feePaid', 0, 1] },
          },
        },
      },
      {
        $project: {
          class: '$_id',
          total: 1,
          paid: 1,
          unpaid: 1,
          completionRate: { $multiply: [{ $divide: ['$paid', '$total'] }, 100] },
          _id: 0,
        },
      },
      { $sort: { class: 1 } },
    ]);

    res.json({ data: completion });
  } catch (err) {
    next(err);
  }
}

async function getTopUnpaidCohorts(req, res, next) {
  try {
    const { schoolId } = req;
    const limit = Math.min(10, parseInt(req.query.limit || '10', 10));

    const unpaid = await Student.aggregate([
      { $match: { schoolId, deletedAt: null, feePaid: false } },
      {
        $group: {
          _id: '$class',
          count: { $sum: 1 },
          totalOutstanding: { $sum: '$remainingBalance' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
      {
        $project: {
          class: '$_id',
          unpaidCount: '$count',
          totalOutstanding: 1,
          _id: 0,
        },
      },
    ]);

    res.json({ data: unpaid });
  } catch (err) {
    next(err);
  }
}

async function getPaymentAnalyticsSummary(req, res, next) {
  try {
    const { schoolId } = req;

    const [paymentStats, studentStats] = await Promise.all([
      Payment.aggregate([
        { $match: { schoolId, deletedAt: null, status: 'SUCCESS' } },
        {
          $group: {
            _id: '$assetCode',
            totalProcessed: { $sum: '$amount' },
            transactionCount: { $sum: 1 },
            averagePayment: { $avg: '$amount' },
          },
        },
      ]),
      Student.aggregate([
        { $match: { schoolId, deletedAt: null } },
        {
          $group: {
            _id: null,
            totalStudents: { $sum: 1 },
            paidStudents: { $sum: { $cond: ['$feePaid', 1, 0] } },
            totalOutstanding: { $sum: '$remainingBalance' },
          },
        },
      ]),
    ]);

    const student = studentStats[0] || { totalStudents: 0, paidStudents: 0, totalOutstanding: 0 };

    const totals = {};
    const averagePayments = {};
    let transactionCount = 0;
    for (const row of paymentStats) {
      const asset = row._id || 'UNKNOWN';
      totals[asset] = String(row.totalProcessed);
      averagePayments[asset] = String(row.averagePayment);
      transactionCount += row.transactionCount;
    }

    res.json({
      summary: {
        totalStudents: student.totalStudents,
        paidStudents: student.paidStudents,
        unpaidStudents: student.totalStudents - student.paidStudents,
        completionRate: student.totalStudents > 0 ? (student.paidStudents / student.totalStudents) * 100 : 0,
        totals,
        averagePayments,
        transactionCount,
        totalOutstanding: student.totalOutstanding,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPaymentVolumeTrend,
  getClassPaymentCompletion,
  getTopUnpaidCohorts,
  getPaymentAnalyticsSummary,
};
