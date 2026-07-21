'use strict';

/**
 * paymentController — core payment flow: instructions, intent, submit, verify.
 * req.school and req.schoolId are injected by resolveSchool middleware.
 */

const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  verifyTransaction,
  recordPayment,
  validatePaymentWithDynamicFee,
} = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { server } = require('../config/stellarConfig');
const { ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { validateTransactionHash } = require('../utils/hashValidator');
const { getPaymentLimits, validatePaymentAmount } = require('../utils/paymentLimits');
const { convertToLocalCurrency } = require('../services/currencyConversionService');
const { withStellarRetry } = require('../utils/withStellarRetry');
const { makePaymentAuditLogger } = require('../utils/paymentAuditLogger');
const lock = require('../services/distributedLock');
const logger = require('../utils/logger');

// TTL for the per-school distributed verify lock.  Verify is a fast Horizon
// round-trip; 30 s is more than enough while still auto-expiring on crash.
const VERIFY_LOCK_TTL_MS = parseInt(process.env.VERIFY_LOCK_TTL_MS || '30000', 10);

// Permanent error codes that should NOT be retried
const PERMANENT_FAIL_CODES = [
  'TX_FAILED',
  'MISSING_MEMO',
  'INVALID_DESTINATION',
  'UNSUPPORTED_ASSET',
  'AMOUNT_TOO_LOW',
  'AMOUNT_TOO_HIGH',
  'UNDERPAID',
];

function getExplorerUrl(txHash) {
  if (!txHash) return null;
  const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

// ====================== PAYMENT INSTRUCTIONS ======================
async function getPaymentInstructions(req, res, next) {
  try {
    const limits = getPaymentLimits();
    const targetCurrency = req.school.localCurrency || 'USD';
    const { feeCategory, asset } = req.query;

    if (asset) {
      const assetCode = asset.split(':')[0];
      if (!Object.keys(ACCEPTED_ASSETS).includes(assetCode)) {
        const supportedAssets = Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, displayName: a.displayName }));
        return res.status(400).json({ error: `Asset ${assetCode} is not accepted by this school`, code: 'ASSET_NOT_ACCEPTED', supportedAssets });
      }
    }

    const student = await Student.findOne({ schoolId: req.schoolId, studentId: req.params.studentId });

    let feeAmount = student ? student.feeAmount : null;
    let feeConversion = null;
    let categoryInfo = null;

    if (feeCategory && student?.fees?.length > 0) {
      const fee = student.fees.find((f) => f.category === feeCategory);
      if (fee) {
        feeAmount = fee.amount;
        categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: fee.remainingBalance || fee.amount };
      }
    }

    if (feeAmount) {
      feeConversion = await convertToLocalCurrency(feeAmount, 'XLM', targetCurrency);
    }

    const fees = student?.fees?.length > 0
      ? student.fees.map((f) => ({ category: f.category, amount: f.amount, paid: f.paid, totalPaid: f.totalPaid || 0, remainingBalance: f.remainingBalance || f.amount }))
      : [];

    res.json({
      walletAddress: req.school.stellarAddress,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, type: a.type, displayName: a.displayName, issuer: a.issuer ?? null })),
      paymentLimits: { min: limits.min, max: limits.max },
      feeAmount,
      feeCategory: feeCategory || null,
      categoryInfo,
      fees,
      feeLocalEquivalent: feeConversion?.available
        ? { amount: feeConversion.localAmount, currency: feeConversion.currency, rate: feeConversion.rate, rateTimestamp: feeConversion.rateTimestamp }
        : null,
      note: 'Include the payment intent memo exactly when sending payment. The memo must be sent as a text memo (MEMO_TEXT). Other memo types (MEMO_ID, MEMO_HASH, MEMO_RETURN) will not be recognised and your payment will not be matched.',
      memoType: 'text',
    });
  } catch (err) {
    next(err);
  }
}

// ====================== PAYMENT INTENT ======================
async function createPaymentIntent(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId, feeCategory } = req.body;

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });

    let feeAmount = student.feeAmount;
    let categoryInfo = null;

    if (feeCategory && student.fees?.length > 0) {
      const fee = student.fees.find((f) => f.category === feeCategory);
      if (!fee) return res.status(400).json({ error: `Fee category '${feeCategory}' not found for student`, code: 'INVALID_FEE_CATEGORY' });
      feeAmount = fee.amount;
      categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: fee.remainingBalance || fee.amount };
    }

    const limitValidation = validatePaymentAmount(feeAmount);
    if (!limitValidation.valid) return res.status(400).json({ error: limitValidation.error, code: limitValidation.code });

    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const ttlMs = parseInt(process.env.PAYMENT_INTENT_TTL_MS, 10) || 24 * 60 * 60 * 1000;

    const intent = await PaymentIntent.create({
      schoolId,
      studentId,
      amount: feeAmount,
      feeCategory: feeCategory || null,
      memo,
      status: 'pending',
      expiresAt: new Date(Date.now() + ttlMs),
      startedAt: new Date(),
    });

    res.status(201).json({ ...intent.toObject(), categoryInfo });
  } catch (err) {
    next(err);
  }
}

// ====================== SUBMIT XDR TRANSACTION ======================
async function submitTransaction(req, res, next) {
  try {
    const { xdr } = req.body;
    if (!xdr) return res.status(400).json({ error: 'Missing xdr parameter' });

    const tx = new StellarSdk.Transaction(xdr, require('../config/stellarConfig').networkPassphrase);
    const transactionHash = tx.hash().toString('hex');

    const hashValidation = validateTransactionHash(transactionHash);
    if (!hashValidation.valid) {
      const err = new Error(hashValidation.error);
      err.code = hashValidation.code;
      return next(err);
    }

    const normalizedHash = hashValidation.normalized;
    const memo = tx.memo.value ? tx.memo.value.toString() : null;
    if (!memo) return res.status(400).json({ error: 'Transaction must include the student ID as a memo' });

    let paymentRecord = await Payment.findOne({ schoolId: req.schoolId, memo, status: 'PENDING' }).sort({ createdAt: -1 });
    if (!paymentRecord) {
      const studentObj = await Student.findOne({ schoolId: req.schoolId, studentId: memo });
      if (!studentObj) return res.status(404).json({ error: 'Associated student not found in the database. Cannot process transaction.' });
      paymentRecord = new Payment({ schoolId: req.schoolId, studentId: studentObj.studentId || memo, memo, amount: 0 });
    }

    paymentRecord.transactionHash = normalizedHash;
    paymentRecord.status = 'SUBMITTED';
    paymentRecord.submittedAt = new Date();
    await paymentRecord.save();

    let txResponse;
    try {
      txResponse = await withStellarRetry(() => server.submitTransaction(tx), { label: 'submitTransaction' });
    } catch (err) {
      paymentRecord.status = 'FAILED';
      paymentRecord.suspicionReason = err.response?.data?.extras?.result_codes?.transaction ?? err.message;
      await paymentRecord.save();
      return res.status(400).json({ error: 'Transaction submission failed', code: paymentRecord.suspicionReason });
    }

    if (!txResponse.successful) {
      paymentRecord.status = 'FAILED';
      paymentRecord.confirmationStatus = 'failed';
      paymentRecord.suspicionReason = 'Transaction was included in ledger but failed on-chain';
      await paymentRecord.save();
      return res.status(400).json({ error: 'Transaction was included in the ledger but failed on-chain', code: 'TX_FAILED', hash: transactionHash });
    }

    paymentRecord.status = 'SUCCESS';
    paymentRecord.confirmedAt = new Date();
    paymentRecord.ledgerSequence = txResponse.ledger;
    await paymentRecord.save();

    const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
    res.json({
      verified: true,
      hash: normalizedHash,
      ledger: txResponse.ledger,
      status: 'SUCCESS',
      explorerUrl: `https://stellar.expert/explorer/${network}/tx/${transactionHash}`,
    });
  } catch (err) {
    next(err);
  }
}

// ====================== VERIFY PAYMENT ======================
async function verifyPayment(req, res, next) {
  const startTime = Date.now();

  try {
    const { schoolId } = req;
    const { txHash } = req.body;

    if (!txHash) {
      const audit = makePaymentAuditLogger(req, schoolId, `missing-tx:${schoolId}`);
      await audit.failure('txHash is required', { receivedKeys: Object.keys(req.body || {}) });
      return res.status(400).json({ error: 'txHash is required', code: 'VALIDATION_ERROR' });
    }

    const hashValidation = validateTransactionHash(txHash);
    if (!hashValidation.valid) {
      const audit = makePaymentAuditLogger(req, schoolId, txHash);
      await audit.failure(hashValidation.error, { txHash, validationError: hashValidation.error });
      const err = new Error(hashValidation.error);
      err.code = hashValidation.code;
      return next(err);
    }

    const normalizedHash = hashValidation.normalized;
    const audit = makePaymentAuditLogger(req, schoolId, normalizedHash);

    // Idempotency — return cached result if already recorded
    const existing = await Payment.findOne({ schoolId, txHash: normalizedHash });
    if (existing) {
      await audit.success({ txHash: normalizedHash, cached: true, studentId: existing.studentId, amount: existing.amount });

      const targetCurrency = req.school.localCurrency || 'USD';
      const conversion = await convertToLocalCurrency(existing.amount, existing.assetCode || 'XLM', targetCurrency);
      const stellarExplorerUrl = getExplorerUrl(existing.txHash);

      return res.json({
        verified: true,
        cached: true,
        hash: existing.txHash,
        stellarExplorerUrl,
        explorerUrl: stellarExplorerUrl,
        memo: existing.memo,
        studentId: existing.studentId,
        amount: existing.amount,
        assetCode: existing.assetCode,
        assetType: existing.assetType,
        feeAmount: existing.feeAmount,
        feeValidation: { status: existing.feeValidationStatus, excessAmount: existing.excessAmount },
        networkFee: existing.networkFee || null,
        date: existing.confirmedAt || existing.createdAt,
        status: existing.status,
        confirmationStatus: existing.confirmationStatus,
        localCurrency: {
          amount: conversion.available ? conversion.localAmount : null,
          currency: conversion.currency,
          rate: conversion.rate,
          rateTimestamp: conversion.rateTimestamp,
          available: conversion.available,
        },
      });
    }

    // Issue #69 — distributed lock prevents two replicas from concurrently
    // verifying the same transaction, which would risk a double-write race even
    // though the unique index on Payment { schoolId, txHash } is the ultimate
    // dedup guard.  The lock is keyed per (school, txHash) so only identical
    // concurrent verify calls contend — different hashes proceed in parallel.
    const verifyLockKey = `sync:lock:${schoolId}:verify:${normalizedHash}`;
    // acquire() returns { token, fencingToken } (or null); release() needs the
    // raw token string, so destructure it — otherwise the lock never releases.
    const verifyLockInfo = await lock.acquire(verifyLockKey, VERIFY_LOCK_TTL_MS);
    if (!verifyLockInfo) {
      return res.status(409).json({ error: 'Sync already in progress', code: 'SYNC_IN_PROGRESS' });
    }
    const verifyToken = verifyLockInfo.token;

    try {
      let result;
      try {
        // Pass schoolId so verifyTransaction scopes the student lookup to this school (#845).
        result = await verifyTransaction(normalizedHash, req.school.stellarAddress, schoolId);
      } catch (stellarErr) {
        if (PERMANENT_FAIL_CODES.includes(stellarErr.code)) {
          await audit.failure(stellarErr.message, { txHash: normalizedHash, errorCode: stellarErr.code });
          await Payment.create({ schoolId, studentId: 'unknown', txHash: normalizedHash, amount: 0, status: 'FAILED', feeValidationStatus: 'unknown' }).catch(err => logger.error('[PaymentController] failed to persist permanent failure record', { txHash: normalizedHash, error: err.message }));
          return next(stellarErr);
        }

        await audit.success({ txHash: normalizedHash, queuedForRetry: true, reason: stellarErr.message });
        await queueForRetry(normalizedHash, req.body.studentId || null, stellarErr.message, schoolId);
        return res.status(202).json({
          message: 'Stellar network is temporarily unavailable. Your transaction has been queued and will be verified automatically.',
          txHash: normalizedHash,
          status: 'queued_for_retry',
        });
      }

      if (!result) {
        await audit.failure('Transaction found but contains no valid payment to this school wallet', { txHash: normalizedHash });
        return res.status(404).json({ error: 'Transaction found but contains no valid payment to this school wallet', code: 'NOT_FOUND' });
      }

      const studentStrId = result.studentId || result.memo;
      const studentObj = await Student.findOne({ schoolId, studentId: studentStrId });
      if (!studentObj) {
        await audit.failure('Associated student not found', { txHash: normalizedHash, studentId: studentStrId });
        return res.status(404).json({ error: 'Associated student not found. Cannot record transaction.' });
      }

      // Intents are a UX convenience; an expired intent must not block crediting (#848).
      // Mark it expired for bookkeeping but continue to record the payment.
      const intent = await PaymentIntent.findOne({ memo: result.memo, schoolId });
      if (intent?.expiresAt && intent.expiresAt < new Date()) {
        await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'expired' });
      }

      // Determine cumulative feeValidationStatus (#846).
      // Partial payments (amount < fee) are accepted — money is already on-chain.
      // The cumulative total drives the status; per-payment underpaid rejection
      // is not applied here because a parent may be paying in installments.
      const prevAgg = await Payment.aggregate([
        { $match: { schoolId, studentId: studentStrId, deletedAt: null, status: 'SUCCESS' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const prevTotal = prevAgg.length ? prevAgg[0].total : 0;
      const cumulativeTotal = parseFloat((prevTotal + result.amount).toFixed(7));
      let feeValidationStatus;
      if (cumulativeTotal < studentObj.feeAmount) feeValidationStatus = 'partial';
      else if (cumulativeTotal > studentObj.feeAmount) feeValidationStatus = 'overpaid';
      else feeValidationStatus = 'valid';
      const computedExcessAmount = feeValidationStatus === 'overpaid'
        ? parseFloat((cumulativeTotal - studentObj.feeAmount).toFixed(7))
        : 0;

      const now = new Date();
      try {
        await recordPayment({
          schoolId,
          studentId: studentStrId,
          txHash: result.hash,
          amount: result.amount,
          feeAmount: result.feeAmount || studentObj.feeAmount,
          feeValidationStatus,
          excessAmount: computedExcessAmount,
          networkFee: result.networkFee,
          status: 'SUCCESS',
          memo: result.memo,
          senderAddress: result.senderAddress || null,
          ledgerSequence: result.ledger || null,
          confirmationStatus: 'confirmed',
          confirmedAt: result.date ? new Date(result.date) : now,
          verifiedAt: now,
        });
      } catch (dupErr) {
        if (dupErr.code === 'DUPLICATE_TX') {
          // Concurrent path (poller or another verify call) already recorded this tx.
          // Fetch and return the existing record as a cache hit.
          const cached = await Payment.findOne({ schoolId, txHash: normalizedHash });
          if (cached) {
            await audit.success({ txHash: normalizedHash, cached: true, studentId: studentStrId, amount: cached.amount });
            const targetCurrency = req.school.localCurrency || 'USD';
            const cachedConv = await convertToLocalCurrency(cached.amount, cached.assetCode || 'XLM', targetCurrency);
            return res.json({
              verified: true, cached: true, hash: cached.txHash,
              stellarExplorerUrl: getExplorerUrl(cached.txHash), explorerUrl: getExplorerUrl(cached.txHash),
              memo: cached.memo, studentId: cached.studentId, amount: cached.amount,
              assetCode: cached.assetCode, feeAmount: cached.feeAmount,
              feeValidation: { status: cached.feeValidationStatus, excessAmount: cached.excessAmount },
              date: cached.confirmedAt || cached.createdAt, status: cached.status,
              localCurrency: {
                amount: cachedConv.available ? cachedConv.localAmount : null,
                currency: cachedConv.currency, rate: cachedConv.rate,
                rateTimestamp: cachedConv.rateTimestamp, available: cachedConv.available,
              },
            });
          }
        }
        throw dupErr;
      }

      // Update student record immediately after recording (#846) — sync path also does
      // this, but the verify path never did, leaving totalPaid/remainingBalance stale.
      await Student.findOneAndUpdate(
        { schoolId, studentId: studentStrId },
        {
          totalPaid: cumulativeTotal,
          remainingBalance: parseFloat(Math.max(0, studentObj.feeAmount - cumulativeTotal).toFixed(7)),
          feePaid: cumulativeTotal >= studentObj.feeAmount,
        },
      );

      await audit.success({
        txHash: normalizedHash,
        studentId: studentStrId,
        amount: result.amount,
        assetCode: result.assetCode || 'XLM',
        feeValidationStatus,
        duration: `${Date.now() - startTime}ms`,
      });

      // Auto-generate receipt (fire-and-forget)
      const { createReceipt } = require('../services/receiptService');
      createReceipt({
        txHash: result.hash,
        studentId: studentStrId,
        schoolId,
        amount: result.amount,
        assetCode: result.assetCode || 'XLM',
        feeAmount: result.feeAmount || studentObj.feeAmount,
        feeValidationStatus,
        memo: result.memo,
        confirmedAt: result.date ? new Date(result.date) : now,
      }).catch(err => {
        // Fire-and-forget, but never silent (#1122). A systemic receipt failure
        // (bad template, receipt-model fault, downstream outage) must leave a
        // log trail and a metric, not wait for a parent to report it missing.
        logger.error('[PaymentController] receipt generation failed', {
          txHash: result.hash,
          correlationId: req.correlationId,
          schoolId,
          studentId: studentStrId,
          error: err.message,
          stack: err.stack,
        });
        try {
          require('../metrics').receiptGenerationFailuresTotal.inc({ source: 'verify_controller' });
        } catch (_) {
          // metrics module unavailable — logging above is still the primary signal
        }
      });

      const targetCurrency = req.school.localCurrency || 'USD';
      const conversion = await convertToLocalCurrency(result.amount, result.assetCode || 'XLM', targetCurrency);
      const stellarExplorerUrl = getExplorerUrl(result.hash);
      const remainingBalance = parseFloat(Math.max(0, studentObj.feeAmount - cumulativeTotal).toFixed(7));

      res.json({
        verified: true,
        cached: false,
        hash: result.hash,
        stellarExplorerUrl,
        explorerUrl: stellarExplorerUrl,
        memo: result.memo,
        studentId: studentStrId,
        amount: result.amount,
        assetCode: result.assetCode,
        assetType: result.assetType,
        feeAmount: result.feeAmount || studentObj.feeAmount,
        feeValidation: { status: feeValidationStatus, excessAmount: computedExcessAmount },
        remainingBalance,
        networkFee: result.networkFee,
        date: result.date,
        localCurrency: {
          amount: conversion.available ? conversion.localAmount : null,
          currency: conversion.currency,
          rate: conversion.rate,
          rateTimestamp: conversion.rateTimestamp,
          available: conversion.available,
        },
      });
    } finally {
      await lock.release(verifyLockKey, verifyToken);
    }
  } catch (err) {
    await makePaymentAuditLogger(req, req.schoolId, req.body?.txHash || 'unknown')
      .failure(err.message, { error: err.message })
      .catch(() => logger.debug('[PaymentController] audit failure log missed', { txHash: req.body?.txHash || 'unknown' }));
    next(err);
  }
}

// ====================== VERIFY TX HASH (no school context) ======================
async function verifyTransactionHash(req, res, next) {
  try {
    const { txHash } = req.params;
    const tx = await server.transactions().transaction(txHash).call();
    res.json({
      hash: tx.hash,
      successful: tx.successful,
      created_at: tx.created_at,
      ledger: tx.ledger_attr || tx.ledger,
      memo: tx.memo,
      fee_paid: tx.fee_paid,
      source_account: tx.source_account,
      operations_count: tx.operation_count,
    });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Transaction not found', code: 'NOT_FOUND' });
    next(wrapStellarError(err));
  }
}

module.exports = {
  getPaymentInstructions,
  createPaymentIntent,
  submitTransaction,
  verifyPayment,
  verifyTransactionHash,
  getExplorerUrl,
  wrapStellarError,
  // Re-export from split controllers so tests importing paymentController still work
  ...require('./paymentQueryController'),
  ...require('./paymentAdminController'),
};
