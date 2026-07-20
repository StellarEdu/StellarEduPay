'use strict';

/**
 * paymentQueryController — read-only payment queries, all school-scoped.
 */

const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PendingVerification = require('../models/pendingVerificationModel');
const { ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { getPaymentLimits } = require('../utils/paymentLimits');
const {
  convertToLocalCurrency,
  enrichPaymentWithConversion,
} = require('../services/currencyConversionService');

function getExplorerUrl(txHash) {
  if (!txHash) return null;
  const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

// Compute once at startup — changes only when stellarConfig changes.
const _acceptedAssetsBody = JSON.stringify({
  assets: Object.values(ACCEPTED_ASSETS).map((a) => ({
    code: a.code,
    type: a.type,
    displayName: a.displayName,
  })),
});
const _acceptedAssetsETag = `"${crypto.createHash('sha1').update(_acceptedAssetsBody).digest('hex')}"`;

async function getAcceptedAssets(req, res, next) {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('ETag', _acceptedAssetsETag);
    if (req.headers['if-none-match'] === _acceptedAssetsETag) return res.status(304).end();
    res.type('json').send(_acceptedAssetsBody);
  } catch (err) {
    next(err);
  }
}

async function getPaymentLimitsEndpoint(req, res, next) {
  try {
    const limits = await getPaymentLimits({ schoolId: req.schoolId });
    res.json({
      min: limits.min,
      max: limits.max,
      message: `Payment amounts must be between ${limits.min} and ${limits.max}`,
    });
  } catch (err) {
    next(err);
  }
}

async function getStudentPayments(req, res, next) {
  try {
    const targetCurrency = req.school.localCurrency || 'USD';
    const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';

    const student = await Student.findOne({ schoolId: req.schoolId, studentId: req.params.studentId });
    if (!student) return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [total, payments] = await Promise.all([
      Payment.countDocuments({ schoolId: req.schoolId, studentId: req.params.studentId, deletedAt: null }),
      Payment.find({ schoolId: req.schoolId, studentId: req.params.studentId, deletedAt: null })
        .sort({ confirmedAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const enriched = await Promise.all(
      payments.map(async (p) => {
        const hash = p.transactionHash || p.txHash;
        const explorerUrl = hash ? `https://stellar.expert/explorer/${network}/tx/${hash}` : null;
        const converted = await enrichPaymentWithConversion(p, targetCurrency);
        return { ...converted, explorerUrl };
      }),
    );

    res.json({ payments: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
}

async function getAllPayments(req, res, next) {
  try {
    const { schoolId } = req;
    const { page = 1, limit = 50, startDate, endDate, minAmount, maxAmount, status, studentId, isSuspicious } = req.query;

    const filter = { schoolId, studentDeleted: { $ne: true }, deletedAt: null };

    if (startDate || endDate) {
      filter.confirmedAt = {};
      if (startDate) {
        if (isNaN(Date.parse(startDate))) return res.status(400).json({ error: 'Invalid startDate', code: 'VALIDATION_ERROR' });
        filter.confirmedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        if (isNaN(Date.parse(endDate))) return res.status(400).json({ error: 'Invalid endDate', code: 'VALIDATION_ERROR' });
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        filter.confirmedAt.$lte = end;
      }
    }

    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) {
        const min = Number(minAmount);
        if (!Number.isFinite(min)) return res.status(400).json({ error: 'Invalid minAmount', code: 'VALIDATION_ERROR' });
        filter.amount.$gte = min;
      }
      if (maxAmount) {
        const max = Number(maxAmount);
        if (!Number.isFinite(max)) return res.status(400).json({ error: 'Invalid maxAmount', code: 'VALIDATION_ERROR' });
        filter.amount.$lte = max;
      }
    }

    if (status) filter.status = status.toUpperCase();
    if (studentId) filter.studentId = studentId;
    if (isSuspicious !== undefined) filter.isSuspicious = isSuspicious === 'true';

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * pageSize;

    const [payments, total] = await Promise.all([
      Payment.find(filter).sort({ confirmedAt: -1 }).skip(skip).limit(pageSize).lean(),
      Payment.countDocuments(filter),
    ]);

    const enrichedPayments = payments.map((p) => ({
      ...p,
      stellarExplorerUrl: getExplorerUrl(p.transactionHash || p.txHash),
      explorerUrl: getExplorerUrl(p.transactionHash || p.txHash),
    }));

    res.json({
      payments: enrichedPayments,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasNext: pageNum < Math.ceil(total / pageSize),
        hasPrev: pageNum > 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getOverpayments(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = { schoolId: req.schoolId, feeValidationStatus: 'overpaid' };
    const [total, overpayments] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ confirmedAt: -1 }).skip(skip).limit(limit),
    ]);

    const totalExcess = overpayments.reduce((sum, p) => sum + (p.excessAmount || 0), 0);
    res.json({
      count: overpayments.length,
      totalExcess,
      overpayments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

async function getStudentBalance(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });

    const [result, deletedCount] = await Promise.all([
      Payment.aggregate([
        { $match: { schoolId, studentId, deletedAt: null } },
        { $group: { _id: null, totalPaid: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payment.countDocuments({ schoolId, studentId, deletedAt: { $ne: null } }),
    ]);

    const totalPaid = result.length ? parseFloat(result[0].totalPaid.toFixed(7)) : 0;
    const remainingBalance = parseFloat(Math.max(0, student.feeAmount - totalPaid).toFixed(7));
    const excessAmount = totalPaid > student.feeAmount
      ? parseFloat((totalPaid - student.feeAmount).toFixed(7))
      : 0;

    const targetCurrency = req.school.localCurrency || 'USD';
    const [feeConv, paidConv, remainingConv] = await Promise.all([
      convertToLocalCurrency(student.feeAmount, 'XLM', targetCurrency),
      convertToLocalCurrency(totalPaid, 'XLM', targetCurrency),
      convertToLocalCurrency(remainingBalance, 'XLM', targetCurrency),
    ]);

    const buildLocal = (conv) =>
      conv.available ? { amount: conv.localAmount, currency: conv.currency, rate: conv.rate, rateTimestamp: conv.rateTimestamp } : null;

    let categoryBreakdown = [];
    if (student.fees && student.fees.length > 0) {
      const categoryPayments = await Payment.aggregate([
        { $match: { schoolId, studentId, feeCategory: { $ne: null }, deletedAt: null } },
        { $group: { _id: '$feeCategory', totalPaid: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]);
      const categoryPaymentMap = {};
      categoryPayments.forEach((cp) => {
        categoryPaymentMap[cp._id] = { totalPaid: parseFloat(cp.totalPaid.toFixed(7)), installmentCount: cp.count };
      });
      categoryBreakdown = student.fees.map((fee) => {
        const paid = categoryPaymentMap[fee.category] || { totalPaid: 0, installmentCount: 0 };
        return {
          category: fee.category,
          amount: fee.amount,
          totalPaid: paid.totalPaid,
          remainingBalance: Math.max(0, fee.amount - paid.totalPaid),
          paid: paid.totalPaid >= fee.amount,
          installmentCount: paid.installmentCount,
          paymentDeadline: fee.paymentDeadline,
        };
      });
    }

    res.json({
      studentId,
      feeAmount: student.feeAmount,
      totalPaid,
      remainingBalance,
      excessAmount,
      feePaid: totalPaid >= student.feeAmount,
      installmentCount: result.length ? result[0].count : 0,
      categoryBreakdown,
      localCurrency: {
        currency: targetCurrency,
        available: feeConv.available,
        rateTimestamp: feeConv.rateTimestamp,
        feeAmount: buildLocal(feeConv),
        totalPaid: buildLocal(paidConv),
        remainingBalance: buildLocal(remainingConv),
      },
      hasDeletedPayments: deletedCount > 0,
    });
  } catch (err) {
    next(err);
  }
}

async function getSuspiciousPayments(req, res, next) {
  try {
    const suspicious = await Payment.find({ schoolId: req.schoolId, isSuspicious: true }).sort({ confirmedAt: -1 });
    res.json({ count: suspicious.length, suspicious });
  } catch (err) {
    next(err);
  }
}

async function getPendingPayments(req, res, next) {
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (pageNum - 1) * pageSize;
    const filter = { schoolId: req.schoolId, confirmationStatus: 'pending_confirmation' };

    const [pending, total] = await Promise.all([
      Payment.find(filter).sort({ confirmedAt: -1 }).skip(skip).limit(pageSize),
      Payment.countDocuments(filter),
    ]);

    res.json({
      count: pending.length,
      pending,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasNext: pageNum < Math.ceil(total / pageSize),
        hasPrev: pageNum > 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getRetryQueue(req, res, next) {
  try {
    if (!PendingVerification || typeof PendingVerification.find !== 'function') {
      return res.json({ pending: { count: 0, items: [] }, dead_letter: { count: 0, items: [] }, recently_resolved: { count: 0, items: [] } });
    }

    const [pending, deadLetter, resolved] = await Promise.all([
      PendingVerification.find({ schoolId: req.schoolId, status: 'pending' }).sort({ nextRetryAt: 1 }),
      PendingVerification.find({ schoolId: req.schoolId, status: 'dead_letter' }).sort({ updatedAt: -1 }),
      PendingVerification.find({ schoolId: req.schoolId, status: 'resolved' }).sort({ resolvedAt: -1 }).limit(20),
    ]);

    res.json({
      pending: { count: pending.length, items: pending },
      dead_letter: { count: deadLetter.length, items: deadLetter },
      recently_resolved: { count: resolved.length, items: resolved },
    });
  } catch (err) {
    next(err);
  }
}

async function getExchangeRates(req, res, next) {
  try {
    const targetCurrency = req.school.localCurrency || 'USD';
    const { _getRates } = require('../services/currencyConversionService');
    const rateEntry = await _getRates(targetCurrency);

    if (!rateEntry) {
      return res.json({
        available: false,
        currency: targetCurrency,
        rates: null,
        lastFetchedAt: null,
        stale: false,
        staleAge: null,
        message: 'Price feed is currently unavailable. Amounts are shown in XLM only.',
      });
    }

    res.json({
      available: true,
      currency: targetCurrency,
      rates: rateEntry.rates,
      lastFetchedAt: (rateEntry.lastSuccessfulFetch || rateEntry.fetchedAt).toISOString(),
      stale: rateEntry.stale || false,
      staleAge: rateEntry.staleAge || null,
      rateTimestamp: rateEntry.fetchedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

async function getPaymentSummary(req, res, next) {
  try {
    const { schoolId } = req;

    const [studentStats, xlmStats, categoryStats] = await Promise.all([
      Student.aggregate([
        { $match: { schoolId, deletedAt: null } },
        { $group: { _id: null, totalStudents: { $sum: 1 }, paidCount: { $sum: { $cond: ['$feePaid', 1, 0] } }, unpaidCount: { $sum: { $cond: ['$feePaid', 0, 1] } } } },
      ]),
      Payment.aggregate([
        { $match: { schoolId, status: 'SUCCESS', deletedAt: null, studentDeleted: { $ne: true } } },
        { $group: { _id: null, totalXlmCollected: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { schoolId, status: 'SUCCESS', deletedAt: null, studentDeleted: { $ne: true }, feeCategory: { $ne: null } } },
        { $group: { _id: '$feeCategory', totalCollected: { $sum: '$amount' }, paymentCount: { $sum: 1 } } },
      ]),
    ]);

    const s = studentStats[0] || { totalStudents: 0, paidCount: 0, unpaidCount: 0 };
    const x = xlmStats[0] || { totalXlmCollected: 0 };

    res.json({
      totalStudents: s.totalStudents,
      paidCount: s.paidCount,
      unpaidCount: s.unpaidCount,
      totalXlmCollected: parseFloat(x.totalXlmCollected.toFixed(7)),
      categoryBreakdown: categoryStats.map((cat) => ({
        category: cat._id,
        totalCollected: parseFloat(cat.totalCollected.toFixed(7)),
        paymentCount: cat.paymentCount,
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAcceptedAssets,
  getPaymentLimitsEndpoint,
  getStudentPayments,
  getAllPayments,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
  getExchangeRates,
  getPaymentSummary,
};
