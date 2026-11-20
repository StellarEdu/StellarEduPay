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
  determineConfirmationState,
} = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { server } = require('../config/stellarConfig');
const { ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { validateTransactionHash } = require('../utils/hashValidator');
const { getPaymentLimits, validatePaymentAmount } = require('../utils/paymentLimits');
const { SUPPORTED_MEMO_TYPES } = require('../utils/stellarMemo');
const { convertToLocalCurrency } = require('../services/currencyConversionService');
const { withStellarRetry } = require('../utils/withStellarRetry');
const { makePaymentAuditLogger } = require('../utils/paymentAuditLogger');
const lock = require('../services/distributedLock');
const logger = require('../utils/logger');
const { toMoney, decimalFromMongo, classifyFeePayment } = require('../utils/money');
const { Decimal } = require('decimal.js');

/**
 * Compute the outstanding balance for a fee category (#1759).
 * `remainingBalance || amount` treated a fully-paid category (0) as "missing"
 * and reported the full amount as still owed. Prefer the stored value when it
 * is a real number, otherwise derive it as max(0, amount - totalPaid) in exact
 * Decimal space so a fully-paid category always reports 0.
 */
function computeRemainingBalance(fee) {
  if (fee.remainingBalance !== undefined && fee.remainingBalance !== null) {
    return toMoneyNumber(toMoney(fee.remainingBalance));
  }
  const remaining = Decimal.max(0, toMoney(fee.amount).minus(toMoney(fee.totalPaid || 0)));
  return toMoneyNumber(remaining);
}

function toMoneyNumber(value) {
  return Number(value.toString());
}

// TTL for the per-school distributed verify lock.  Verify is a fast Horizon
// round-trip; 30 s is more than enough while still auto-expiring on crash.
const VERIFY_LOCK_TTL_MS = parseInt(process.env.VERIFY_LOCK_TTL_MS || '30000', 10);

// TTL for the per-student balance lock (#1026). Guards the read-aggregate-then-write
// sequence that computes cumulativeTotal and writes it as an absolute Student.$set,
// which is not safe to run concurrently for the same student — whether the second
// writer is another verifyPayment call or syncPaymentsForSchool.
const STUDENT_BALANCE_LOCK_TTL_MS = parseInt(process.env.STUDENT_BALANCE_LOCK_TTL_MS || '15000', 10);

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

/**
 * Persist a verification failure for audit/support (#1761).
 * Failures are recorded outside the `payments` collection so they never appear
 * in payment lists, never block sync/poller duplicate checks and never prevent
 * a later re-verification from crediting the real payment.
 */
async function recordVerificationAttempt({ schoolId, txHash, code, message }) {
  try {
    const PaymentVerificationAttempt = require('../models/paymentVerificationAttemptModel');
    await PaymentVerificationAttempt.create({
      schoolId,
      txHash,
      code,
      message,
      attemptedAt: new Date(),
    });
  } catch (err) {
    logger.error('[PaymentController] failed to persist verification attempt', {
      txHash,
      schoolId,
      code,
      error: err.message,
    });
  }
}

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

/**
 * Mask a student's name for anonymous payers (#1962). Only the first letter of
 * each name part is kept so a parent can confirm they are paying for the right
 * child without exposing the full name to anyone who guesses a student ID.
 */
function maskStudentName(student) {
  const raw = student?.name || [student?.firstName, student?.lastName].filter(Boolean).join(' ');
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${'*'.repeat(Math.max(part.length - 1, 0))}`)
    .join(' ');
}

/**
 * Whether the caller is allowed to see the per-category fee breakdown
 * (paid / totalPaid / remainingBalance). Only authenticated users or callers
 * presenting a valid pay-link token qualify; anonymous callers get the amount
 * due only (#1962).
 */
async function canSeeFeeBreakdown(req) {
  if (req.user || req.auth || req.isAuthenticated?.()) return true;
  const token = req.query?.token || req.params?.token || req.headers?.['x-pay-link-token'];
  if (!token) return false;
  try {
    const { verifyPayLinkToken } = require('../services/payLinkService');
    if (typeof verifyPayLinkToken !== 'function') return false;
    const result = await verifyPayLinkToken(token, {
      schoolId: req.schoolId,
      studentId: req.params.studentId,
    });
    return Boolean(result && (result.valid === undefined || result.valid));
  } catch (err) {
    logger.debug('[PaymentController] pay-link token rejected', { error: err.message });
    return false;
  }
}

async function getPaymentInstructions(req, res, next) {
  try {
    const targetCurrency = req.school.localCurrency || 'USD';
    const { feeCategory, asset } = req.query;

    if (asset) {
      const assetCode = asset.split(':')[0];
      if (!Object.keys(ACCEPTED_ASSETS).includes(assetCode)) {
        const supportedAssets = Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, displayName: a.displayName }));
        return res.status(400).json({ error: `Asset ${assetCode} is not accepted by this school`, code: 'ASSET_NOT_ACCEPTED', supportedAssets });
      }
    }

    // Resolve the student first: an unknown, soft-deleted or cross-school ID
    // must never receive a wallet address or memo (#1962). The soft-delete
    // plugin already filters deletedAt, but the explicit filter keeps the
    // intent obvious and survives plugin changes.
    const student = await Student.findOne({
      schoolId: req.schoolId,
      studentId: req.params.studentId,
      deletedAt: null,
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    }

    // Resolved after the asset is known so per-asset limits apply (#1117).
    const limits = await getPaymentLimits({
      schoolId: req.schoolId,
      asset: asset ? asset.split(':')[0] : undefined,
    });

    let feeAmount = student.feeAmount;
    let feeConversion = null;
    let categoryInfo = null;

    if (feeCategory && student.fees?.length > 0) {
      const fee = student.fees.find((f) => f.category === feeCategory);
      if (fee) {
        feeAmount = fee.amount;
        categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: computeRemainingBalance(fee) };
      }
    }

    // #1974 — convert the fee using the fee currency, not always XLM, so the
    // displayed local equivalent agrees with the ledger's credited amounts.
    const feeCurrency = student?.feeCurrency || req.school.feeCurrency || 'XLM';
    if (feeAmount) {
      feeConversion = await convertToLocalCurrency(feeAmount, feeCurrency, targetCurrency);
    }

    const includeBreakdown = await canSeeFeeBreakdown(req);

    const fees = includeBreakdown && student.fees?.length > 0
      ? student.fees.map((f) => ({ category: f.category, amount: f.amount, paid: f.paid, totalPaid: f.totalPaid || 0, remainingBalance: computeRemainingBalance(f) }))
      : [];

    const response = {
      walletAddress: req.school.stellarAddress,
      memo: student.studentId || req.params.studentId,
      maskedName: maskStudentName(student),
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, type: a.type, displayName: a.displayName, issuer: a.issuer ?? null })),
      paymentLimits: { min: limits.min, max: limits.max },
      minAmount: limits.min,
      maxAmount: limits.max,
      amountDue: feeAmount,
      feeAmount,
      feeCurrency,
      feeCategory: feeCategory || null,
      feeLocalEquivalent: feeConversion?.available
        ? { amount: feeConversion.localAmount, currency: feeConversion.currency, rate: feeConversion.rate, rateTimestamp: feeConversion.rateTimestamp }
        : null,
      note: 'Include the payment intent memo exactly when sending payment. MEMO_TEXT is recommended; wallets that cannot send text memos may use MEMO_ID or MEMO_HASH with the encoded form of the same reference. MEMO_RETURN is not recognised and such payments will not be matched.',
      // `memoType` keeps its original 'text' spelling — it is part of the
      // published API response and existing clients compare against it
      // directly. New clients should read `supportedMemoTypes` (#1118).
      memoType: 'text',
      supportedMemoTypes: SUPPORTED_MEMO_TYPES,
    };

    // Per-category breakdown (paid / totalPaid / remainingBalance) is only
    // disclosed to authenticated or pay-link callers (#1962).
    if (includeBreakdown) {
      response.categoryInfo = categoryInfo;
      response.fees = fees;
    }

    res.json(response);
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
      categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: computeRemainingBalance(fee) };
    }

    const limitValidation = await validatePaymentAmount(feeAmount, { schoolId });
    if (!limitValidation.valid) return res.status(400).json({ error: limitValidation.error, code: limitValidation.code });

    const ttlMs = parseInt(process.env.PAYMENT_INTENT_TTL_MS, 10) || 24 * 60 * 60 * 1000;

    const feeCurrency = student.feeCurrency || req.school.feeCurrency || 'XLM';

    // #1978 — one memo scheme: a 10-char base32 code derived from the intent
    // _id. Retry on the (schoolId, memo) unique index instead of returning 409.
    let intent = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3 && !intent; attempt += 1) {
      const memo = generateIntentMemo();
      try {
        intent = await PaymentIntent.create({
          schoolId,
          studentId,
          amount: feeAmount,
          feeCurrency,
          feeCategory: feeCategory || null,
          memo,
          status: 'pending',
          expiresAt: new Date(Date.now() + ttlMs),
          startedAt: new Date(),
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        lastErr = err;
      }
    }

    if (!intent) {
      return res.status(503).json({
        error: 'Could not allocate a unique payment memo, please retry',
        code: 'MEMO_ALLOCATION_FAILED',
        detail: lastErr ? lastErr.message : undefined,
      });
    }

    const intentObj = intent.toObject();
    res.status(201).json({
      ...intentObj,
      // Issue #1035: Include intentId in response so client can pass it back in submitTransaction
      // to ensure the submission is matched to the correct PENDING record
      intentId: intent._id.toString(),
      feeCurrency,
      categoryInfo,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A payment intent with that memo already exists for this school', code: 'DUPLICATE_PAYMENT_INTENT' });
    }
    next(err);
  }
}

// ====================== PAYMENT REFERENCE RESOLUTION ======================
/**
 * Resolve a transaction memo to the student it belongs to (#1967).
 *
 * A memo is either a payment-intent code (random 8-hex, created by
 * createPaymentIntent) or, for backward compatibility, a raw student ID.
 * Every path that maps memo -> student (submit, verify, sync, poller) must use
 * this helper so the two flows can never diverge.
 *
 * Returns { intent, studentId, student } or null when nothing matches.
 */
async function resolvePaymentReference(schoolId, memo) {
  if (!memo) return null;
  const memoStr = memo.toString();

  const intent = await PaymentIntent.findOne({ schoolId, memo: memoStr, status: 'pending' });
  if (intent) {
    const student = await Student.findOne({ schoolId, studentId: intent.studentId });
    return { intent, studentId: intent.studentId, student: student || null };
  }

  // Backward compatibility: the memo may be the student ID itself.
  const student = await Student.findOne({ schoolId, studentId: memoStr });
  if (student) {
    return { intent: null, studentId: student.studentId, student };
  }

  return null;
}

/**
 * Locally inspect the operations of a parsed transaction (#1966).
 * Returns the list of operations that pay `schoolAddress` in an accepted
 * asset. Empty list means the transaction is not a school payment.
 */
function findSchoolPaymentOps(tx, schoolAddress) {
  const acceptedCodes = new Set(Object.keys(ACCEPTED_ASSETS));
  const matches = [];

  const ops = tx.operations || [];
  ops.forEach((op, index) => {
    let destination = null;
    let asset = null;

    if (op.type === 'payment') {
      destination = op.destination;
      asset = op.asset;
    } else if (op.type === 'pathPaymentStrictReceive' || op.type === 'pathPaymentStrictSend') {
      destination = op.destination;
      asset = op.destAsset || op.sendAsset;
    } else {
      return;
    }

    if (destination !== schoolAddress) return;

    const assetCode = asset && asset.code ? asset.code : null;
    if (!assetCode || !acceptedCodes.has(assetCode)) return;

    matches.push({ index, type: op.type, assetCode, amount: op.amount || op.destAmount || op.sendAmount });
  });

  return matches;
}

// ====================== SUBMIT XDR TRANSACTION ======================
async function submitTransaction(req, res, next) {
  try {
    const { xdr, paymentIntentId } = req.body;
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

    // #1966: never relay a transaction that does not actually pay this school.
    // Checked locally before submission so the endpoint cannot be used as a
    // generic free relay for arbitrary signed transactions.
    const schoolAddress = req.school.stellarAddress;
    const schoolOps = findSchoolPaymentOps(tx, schoolAddress);
    if (schoolOps.length === 0) {
      return res.status(400).json({
        error: 'Transaction does not contain a payment to this school wallet in an accepted asset',
        code: 'NO_SCHOOL_PAYMENT',
      });
    }

    // #1967: resolve memo -> intent -> student through the shared helper.
    const reference = await resolvePaymentReference(req.schoolId, memo);
    if (!reference) {
      return res.status(404).json({ error: 'Associated student not found in the database. Cannot process transaction.' });
    }

    // Issue #1035: when paymentIntentId is supplied it must match the intent
    // the memo resolves to, so a submission cannot be attributed to another
    // student's intent.
    if (paymentIntentId) {
      const intent = await PaymentIntent.findOne({ _id: paymentIntentId, schoolId: req.schoolId });
      if (!intent) {
        return res.status(404).json({ error: 'Payment intent not found', code: 'INTENT_NOT_FOUND' });
      }
      if (intent.status !== 'pending') {
        return res.status(400).json({ error: `Payment intent is not in pending status (status: ${intent.status})`, code: 'INTENT_NOT_PENDING' });
      }
      if (!reference.intent || reference.intent._id.toString() !== intent._id.toString()) {
        return res.status(400).json({ error: 'Transaction memo does not match the supplied payment intent', code: 'INTENT_MISMATCH' });
      }
    }

    // Upsert a SUBMITTED record keyed by the transaction hash. The record is
    // never marked SUCCESS here — only verification against the on-chain
    // operations may do that (#1966).
    const submittedAt = new Date();
    const paymentRecord = await Payment.findOneAndUpdate(
      { schoolId: req.schoolId, txHash: normalizedHash, opIndex: 0 },
      {
        $set: {
          studentId: reference.studentId,
          memo,
          status: 'SUBMITTED',
          submittedAt,
        },
        $setOnInsert: {
          schoolId: req.schoolId,
          txHash: normalizedHash,
          opIndex: 0,
          amount: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

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

    // Hand the hash to the same verification pipeline as verifyPayment. It
    // re-checks destination, asset/issuer, amount limits and memo against the
    // on-chain operations before anything is recorded as SUCCESS.
    let result = null;
    try {
      result = await verifyTransaction(normalizedHash, schoolAddress, req.schoolId);
    } catch (verifyErr) {
      logger.warn('[PaymentController] post-submit verification failed; leaving record SUBMITTED for the poller', {
        schoolId: req.schoolId,
        txHash: normalizedHash,
        code: verifyErr.code,
        error: verifyErr.message,
      });
    }

    if (!result) {
      // Verification could not confirm the payment (network hiccup or the tx
      // does not pay this school). Leave the record SUBMITTED so the poller can
      // pick it up; never claim SUCCESS from the submit response alone.
      return res.status(202).json({
        verified: false,
        hash: normalizedHash,
        ledger: txResponse.ledger,
        status: 'SUBMITTED',
        explorerUrl: getExplorerUrl(normalizedHash),
      });
    }

    const studentStrId = result.studentId || result.memo || reference.studentId;
    const studentObj = reference.student || await Student.findOne({ schoolId: req.schoolId, studentId: studentStrId });
    if (!studentObj) {
      return res.status(404).json({ error: 'Associated student not found. Cannot record transaction.' });
    }

    const now = new Date();
    const confirmation = await determineConfirmationState(result.ledger || txResponse.ledger || null, undefined, false);

    let recorded;
    try {
      recorded = await recordPayment({
        schoolId: req.schoolId,
        studentId: studentStrId,
        txHash: result.hash,
        opIndex: 0,
        amount: result.amount,
        feeAmount: result.feeAmount || studentObj.feeAmount,
        feeValidationStatus: 'PENDING',
        networkFee: result.networkFee,
        status: 'SUCCESS',
        memo: result.memo,
        senderAddress: result.senderAddress || null,
        ledgerSequence: result.ledger || txResponse.ledger || null,
        confirmationStatus: confirmation.confirmationStatus,
        confirmationState: confirmation.state,
        confirmedAt: result.date ? new Date(result.date) : now,
        verifiedAt: now,
      });
    } catch (recordErr) {
      if (recordErr.code !== 'DUPLICATE_TX') throw recordErr;
      recorded = await Payment.findOne({ schoolId: req.schoolId, txHash: normalizedHash, status: { $ne: 'REJECTED' } });
    }

    // Mark the linked intent completed and link it to the payment (#1967).
    const linkedIntent = reference.intent || await PaymentIntent.findOne({ schoolId: req.schoolId, memo: result.memo, status: 'pending' });
    if (linkedIntent) {
      await PaymentIntent.findOneAndUpdate(
        { _id: linkedIntent._id, schoolId: req.schoolId },
        { status: 'completed', completedAt: now, ...(recorded?._id ? { paymentId: recorded._id } : {}) },
      );
    }

    // Issue #1034: Update student balance fields using the unified balance updater.
    const { updateStudentBalance } = require('../utils/studentBalanceUpdater');
    try {
      await updateStudentBalance(req.schoolId, studentStrId, {});
    } catch (balanceErr) {
      logger.error('Failed to update student balance after submitTransaction', {
        schoolId: req.schoolId,
        studentId: studentStrId,
        txHash: normalizedHash,
        error: balanceErr.message,
      });
    }

    res.json({
      verified: true,
      hash: normalizedHash,
      ledger: result.ledger || txResponse.ledger,
      status: 'SUCCESS',
      amount: result.amount,
      assetCode: result.assetCode,
      studentId: studentStrId,
      explorerUrl: getExplorerUrl(normalizedHash),
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

    // Idempotency — return cached result if already recorded.
    // REJECTED markers (#1761) are verification-failure placeholders, not
    // payments: they must never short-circuit a re-verification, otherwise a
    // transaction rejected for config-dependent limits could never be credited
    // after the configuration changes.
    const existing = await Payment.findOne({ schoolId, txHash: normalizedHash, status: { $ne: 'REJECTED' } });
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
          // #1761: do NOT write a placeholder into `payments`. Several of these
          // "permanent" outcomes are configuration-dependent (limits, accepted
          // assets, wrong-school destination) and must remain re-verifiable.
          // Record the attempt in the dedicated audit collection instead.
          await recordVerificationAttempt({
            schoolId,
            txHash: normalizedHash,
            code: stellarErr.code,
            message: stellarErr.message,
          });
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

      // #1973 — verifyTransaction returns one entry per creditable operation, each
      // with its own assetCode and amount. Never sum amounts across assets: a tx
      // paying 50 XLM + 100 USDC must produce two Payment rows, not "150 XLM".
      const operations = Array.isArray(result.operations) && result.operations.length
        ? result.operations
        : [result];
      const feeCurrency = studentObj.feeCurrency || req.school.feeCurrency || 'XLM';

      // Intents are a UX convenience; an expired intent must not block crediting (#848).
      // Mark it expired for bookkeeping but continue to record the payment.
      const intent = await PaymentIntent.findOne({ memo: result.memo, schoolId });
      if (intent?.expiresAt && intent.expiresAt < new Date()) {
        await PaymentIntent.findOneAndUpdate({ _id: intent._id, schoolId }, { status: 'expired' });
      }

      // Issue #1026 — the tx-hash lock above only prevents two calls for the SAME
      // transaction from racing; two DIFFERENT transactions for the same student
      // can still verify concurrently. The balance write below is a non-atomic
      // read-aggregate-then-absolute-write, so it also needs a lock scoped to the
      // student, shared with syncPaymentsForSchool's equivalent section so the two
      // code paths serialize against each other too.
      const studentLockKey = lock.studentBalanceLockKey(schoolId, studentStrId);
      const studentLockInfo = await lock.acquire(studentLockKey, STUDENT_BALANCE_LOCK_TTL_MS);
      if (!studentLockInfo) {
        return res.status(409).json({ error: 'Sync already in progress', code: 'SYNC_IN_PROGRESS' });
      }
      const studentLockToken = studentLockInfo.token;

      let feeValidationStatus;
      let computedExcessAmount;
      let remainingBalance;
      let now;
      const recordedPayments = [];
      try {
        // Determine cumulative feeValidationStatus (#846).
        // Partial payments (amount < fee) are accepted — money is already on-chain.
        // The cumulative total drives the status; per-payment underpaid rejection
        // is not applied here because a parent may be paying in installments.
        //
        // #1974 — the cumulative total is now summed from `creditedAmount` (the
        // amount expressed in the fee currency) and only rows where it is set.
        // Summing raw `amount` across assets would treat 100 USDC and 100 XLM as
        // the same "100 paid" against a single fee.
        //
        // Summed via $toDecimal (#1123 money-representation fix) so the addition
        // happens in exact Decimal128 space inside MongoDB — a plain `$sum` over
        // the `amount` doubles would accumulate float error server-side, before
        // the result ever reaches this function, and toFixed(7) cannot repair
        // that afterwards. classifyFeePayment then compares in exact Decimal
        // space, so an installment plan that sums exactly to the fee is never
        // misclassified by a float epsilon.
        const prevAgg = await Payment.aggregate([
          {
            $match: {
              schoolId,
              studentId: studentStrId,
              deletedAt: null,
              status: 'SUCCESS',
              isSuspicious: false,
              creditedAmount: { $ne: null },
            },
          },
          { $group: { _id: null, total: { $sum: { $toDecimal: '$creditedAmount' } } } },
        ]);
        const prevTotal = prevAgg.length ? decimalFromMongo(prevAgg[0].total) : toMoney(0);

        // #1974 — credit each operation in the fee currency. When the operation's
        // asset already matches the fee currency, creditedAmount === amount. When
        // it differs, use the rate snapshot captured at verification time; if no
        // rate is available the operation is not credited (policy: reject).
        const creditedAmounts = operations.map((op) => {
          const opAsset = op.assetCode || 'XLM';
          if (opAsset === feeCurrency) return toMoney(op.amount);
          const rate = op.fiatSnapshot?.rate;
          if (!rate || !Number.isFinite(Number(rate))) return null;
          return toMoney(op.amount).times(toMoney(rate));
        });

        const totalCreditedThisTx = creditedAmounts.reduce(
          (sum, c) => (c === null ? sum : sum.plus(c)),
          toMoney(0),
        );
        const classification = classifyFeePayment(prevTotal.plus(totalCreditedThisTx), studentObj.feeAmount);
        feeValidationStatus = classification.status;
        computedExcessAmount = classification.excessAmount;
        remainingBalance = classification.remainingBalance;

        now = new Date();

        // Issue #1027: Compute confirmationState using the same logic as syncPaymentsForSchool
        // to ensure manual verify produces consistent state machine values
        const confirmation = await determineConfirmationState(
          result.ledger || null,
          undefined,
          false,
        );

        // #1973 — record one Payment row per operation, keyed by { schoolId, txHash, opIndex }.
        for (let i = 0; i < operations.length; i += 1) {
          const op = operations[i];
          const credited = creditedAmounts[i];
          try {
            const recorded = await recordPayment({
              schoolId,
              studentId: studentStrId,
              txHash: result.hash,
              opIndex: op.opIndex !== undefined ? op.opIndex : i,
              amount: op.amount,
              assetCode: op.assetCode || 'XLM',
              assetType: op.assetType,
              creditedAmount: credited === null ? null : toMoneyNumber(credited),
              feeCurrency,
              feeAmount: op.feeAmount || studentObj.feeAmount,
              feeValidationStatus,
              excessAmount: computedExcessAmount,
              networkFee: op.networkFee,
              status: 'SUCCESS',
              memo: result.memo,
              senderAddress: result.senderAddress || null,
              ledgerSequence: result.ledger || null,
              confirmationStatus: confirmation.confirmationStatus,
              confirmationState: confirmation.state,
              confirmedAt: result.date ? new Date(result.date) : now,
              verifiedAt: now,
            });
            recordedPayments.push(recorded);
          } catch (dupErr) {
            if (dupErr.code === 'DUPLICATE_TX') {
              // Concurrent path (poller or another verify call) already recorded this op.
              const cached = await Payment.findOne({
                schoolId,
                txHash: normalizedHash,
                opIndex: op.opIndex !== undefined ? op.opIndex : i,
                status: { $ne: 'REJECTED' },
              });
              if (cached) recordedPayments.push(cached);
              continue;
            }
            throw dupErr;
          }
        }

        // Issue #1034: Update student balance using the unified balance updater.
        // This ensures verifyPayment, submitTransaction, and syncPaymentsForSchool
        // all use the same balance computation logic.
        const { updateStudentBalance } = require('../utils/studentBalanceUpdater');
        await updateStudentBalance(schoolId, studentStrId, {});
      } finally {
        await lock.release(studentLockKey, studentLockToken);
      }

      const primary = recordedPayments[0] || result;

      await audit.success({
        txHash: normalizedHash,
        studentId: studentStrId,
        amount: primary.amount,
        assetCode: primary.assetCode || 'XLM',
        feeValidationStatus,
        duration: `${Date.now() - startTime}ms`,
      });

      // Auto-generate receipt (fire-and-forget), one per recorded operation.
      const { createReceipt } = require('../services/receiptService');
      for (const recorded of recordedPayments) {
        createReceipt({
          txHash: recorded.txHash || result.hash,
          opIndex: recorded.opIndex,
          studentId: studentStrId,
          schoolId,
          amount: recorded.amount,
          assetCode: recorded.assetCode || 'XLM',
          feeAmount: recorded.feeAmount || studentObj.feeAmount,
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
      }

      const targetCurrency = req.school.localCurrency || 'USD';
      const conversion = await convertToLocalCurrency(primary.amount, primary.assetCode || 'XLM', targetCurrency);
      const stellarExplorerUrl = getExplorerUrl(result.hash);

      res.json({
        verified: true,
        cached: false,
        hash: result.hash,
        stellarExplorerUrl,
        explorerUrl: stellarExplorerUrl,
        memo: result.memo,
        studentId: studentStrId,
        // Primary (first) operation's amount/asset for backward compatibility.
        amount: primary.amount,
        assetCode: primary.assetCode,
        assetType: primary.assetType,
        // #1973 — full per-operation breakdown so callers never see a summed
        // amount across different assets.
        payments: recordedPayments.map((p) => ({
          opIndex: p.opIndex,
          amount: p.amount,
          assetCode: p.assetCode,
          assetType: p.assetType,
          creditedAmount: p.creditedAmount ?? null,
          feeCurrency: p.feeCurrency || feeCurrency,
        })),
        feeCurrency,
        creditedAmount: primary.creditedAmount ?? null,
        feeAmount: primary.feeAmount || studentObj.feeAmount,
        feeValidation: { status: feeValidationStatus, excessAmount: computedExcessAmount },
        remainingBalance,
        networkFee: primary.networkFee,
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
  computeRemainingBalance,
  recordVerificationAttempt,
  resolvePaymentReference,
  findSchoolPaymentOps,
  // Re-export from split controllers so tests importing paymentController still work
  ...require('./paymentQueryController'),
  ...require('./paymentAdminController'),
};
