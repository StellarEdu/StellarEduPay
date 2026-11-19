'use strict';

/**
 * Migration 037: add `feeCurrency` and backfill `creditedAmount` (#1974).
 *
 * Student balances previously summed `amount` across assets with no
 * conversion, so 100 USDC and 100 XLM both counted as "100 paid". This
 * migration introduces an explicit fee currency per school and a
 * `creditedAmount` (amount expressed in the fee currency) on payments.
 *
 * Steps:
 *   1. Add `feeCurrency` to every existing school using an explicit default
 *      per school (confirmed with operators). Schools not listed fall back to
 *      the global default.
 *   2. Backfill `feeCurrency` onto existing FeeStructure, Student fee entries
 *      and PaymentIntent documents from their school's value.
 *   3. Backfill `creditedAmount` on existing Payment rows using the recorded
 *      `fiatSnapshot` rate where available. Rows without a usable rate are
 *      left with `creditedAmount: null` so the balance updater skips them.
 */

const DEFAULT_FEE_CURRENCY = 'XLM';

// Explicit per-school defaults confirmed with operators.
// Keyed by schoolId (string). Add entries here before running in production.
const SCHOOL_FEE_CURRENCY_DEFAULTS = {
  // 'school-id-1': 'USDC',
  // 'school-id-2': 'XLM',
};

function resolveFeeCurrency(schoolId) {
  const key = schoolId != null ? String(schoolId) : null;
  if (key && Object.prototype.hasOwnProperty.call(SCHOOL_FEE_CURRENCY_DEFAULTS, key)) {
    return SCHOOL_FEE_CURRENCY_DEFAULTS[key];
  }
  return DEFAULT_FEE_CURRENCY;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Mongoose Decimal128 / BSON Decimal128
  if (typeof value === 'object') {
    if (typeof value.toString === 'function') {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

/**
 * Extract a conversion rate from a payment's fiatSnapshot.
 *
 * The snapshot shape is not fully standardized, so we look for the common
 * fields that represent "fee-currency units per 1 unit of payment asset".
 * Returns null when no usable rate is present.
 */
function extractRate(fiatSnapshot) {
  if (!fiatSnapshot || typeof fiatSnapshot !== 'object') return null;

  const candidates = [
    fiatSnapshot.rate,
    fiatSnapshot.exchangeRate,
    fiatSnapshot.conversionRate,
    fiatSnapshot.feeCurrencyRate,
  ];

  for (const candidate of candidates) {
    const rate = toNumber(candidate);
    if (rate != null && rate > 0) return rate;
  }

  return null;
}

/**
 * Compute the credited amount (in fee currency) for a payment.
 * Returns null when it cannot be determined.
 */
function computeCreditedAmount(payment, feeCurrency) {
  if (!payment) return null;

  const amount = toNumber(payment.amount);
  if (amount == null) return null;

  const assetCode = payment.assetCode || payment.asset || null;

  // Same asset as the fee currency: credited 1:1.
  if (assetCode && feeCurrency && String(assetCode).toUpperCase() === String(feeCurrency).toUpperCase()) {
    return amount;
  }

  const rate = extractRate(payment.fiatSnapshot);
  if (rate == null) return null;

  return amount * rate;
}

async function getCollection(db, name) {
  return db.collection(name);
}

async function backfillFeeCurrency(db, collectionName, schoolCurrencyMap) {
  const collection = await getCollection(db, collectionName);
  const cursor = collection.find(
    { $or: [{ feeCurrency: { $exists: false } }, { feeCurrency: null }] },
    { projection: { schoolId: 1 } }
  );

  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const feeCurrency = schoolCurrencyMap.get(String(doc.schoolId)) || DEFAULT_FEE_CURRENCY;
    await collection.updateOne(
      { _id: doc._id },
      { $set: { feeCurrency } }
    );
    updated += 1;
  }

  return updated;
}

async function backfillStudentFeeEntries(db, schoolCurrencyMap) {
  const students = await getCollection(db, 'students');
  const cursor = students.find(
    { 'fees.0': { $exists: true } },
    { projection: { schoolId: 1, fees: 1 } }
  );

  let updated = 0;
  while (await cursor.hasNext()) {
    const student = await cursor.next();
    const schoolCurrency = schoolCurrencyMap.get(String(student.schoolId)) || DEFAULT_FEE_CURRENCY;
    const fees = Array.isArray(student.fees) ? student.fees : [];

    let changed = false;
    const newFees = fees.map((fee) => {
      if (!fee || typeof fee !== 'object') return fee;
      if (fee.feeCurrency) return fee;
      changed = true;
      return { ...fee, feeCurrency: schoolCurrency };
    });

    if (changed) {
      await students.updateOne(
        { _id: student._id },
        { $set: { fees: newFees } }
      );
      updated += 1;
    }
  }

  return updated;
}

async function backfillCreditedAmount(db, schoolCurrencyMap) {
  const payments = await getCollection(db, 'payments');
  const cursor = payments.find(
    { $or: [{ creditedAmount: { $exists: false } }, { creditedAmount: null }] },
    { projection: { schoolId: 1, amount: 1, assetCode: 1, asset: 1, fiatSnapshot: 1 } }
  );

  let updated = 0;
  let skipped = 0;
  while (await cursor.hasNext()) {
    const payment = await cursor.next();
    const feeCurrency = schoolCurrencyMap.get(String(payment.schoolId)) || DEFAULT_FEE_CURRENCY;
    const creditedAmount = computeCreditedAmount(payment, feeCurrency);

    if (creditedAmount == null) {
      // Leave null so the balance updater skips this row.
      await payments.updateOne(
        { _id: payment._id },
        { $set: { creditedAmount: null } }
      );
      skipped += 1;
      continue;
    }

    await payments.updateOne(
      { _id: payment._id },
      { $set: { creditedAmount } }
    );
    updated += 1;
  }

  return { updated, skipped };
}

module.exports = {
  async up(db) {
    // 1. Add feeCurrency to every existing school.
    const schools = await getCollection(db, 'schools');
    const schoolCurrencyMap = new Map();
    const schoolCursor = schools.find({}, { projection: { _id: 1 } });

    while (await schoolCursor.hasNext()) {
      const school = await schoolCursor.next();
      const schoolId = String(school._id);
      const feeCurrency = resolveFeeCurrency(schoolId);
      schoolCurrencyMap.set(schoolId, feeCurrency);

      await schools.updateOne(
        { _id: school._id },
        { $set: { feeCurrency } }
      );
    }

    // 2. Backfill feeCurrency onto dependent documents.
    const feeStructuresUpdated = await backfillFeeCurrency(db, 'feestructures', schoolCurrencyMap);
    const studentFeeEntriesUpdated = await backfillStudentFeeEntries(db, schoolCurrencyMap);
    const paymentIntentsUpdated = await backfillFeeCurrency(db, 'paymentintents', schoolCurrencyMap);

    // 3. Backfill creditedAmount on payments.
    const credited = await backfillCreditedAmount(db, schoolCurrencyMap);

    // eslint-disable-next-line no-console
    console.log(
      `[migration 037] schools=${schoolCurrencyMap.size} ` +
        `feeStructures=${feeStructuresUpdated} ` +
        `studentFeeEntries=${studentFeeEntriesUpdated} ` +
        `paymentIntents=${paymentIntentsUpdated} ` +
        `paymentsCredited=${credited.updated} ` +
        `paymentsSkipped=${credited.skipped}`
    );
  },

  async down(db) {
    const schools = await getCollection(db, 'schools');
    await schools.updateMany({}, { $unset: { feeCurrency: '' } });

    const feeStructures = await getCollection(db, 'feestructures');
    await feeStructures.updateMany({}, { $unset: { feeCurrency: '' } });

    const paymentIntents = await getCollection(db, 'paymentintents');
    await paymentIntents.updateMany({}, { $unset: { feeCurrency: '' } });

    const students = await getCollection(db, 'students');
    const cursor = students.find(
      { 'fees.0': { $exists: true } },
      { projection: { fees: 1 } }
    );
    while (await cursor.hasNext()) {
      const student = await cursor.next();
      const fees = Array.isArray(student.fees) ? student.fees : [];
      const newFees = fees.map((fee) => {
        if (!fee || typeof fee !== 'object') return fee;
        const { feeCurrency, ...rest } = fee;
        return rest;
      });
      await students.updateOne({ _id: student._id }, { $set: { fees: newFees } });
    }

    const payments = await getCollection(db, 'payments');
    await payments.updateMany({}, { $unset: { creditedAmount: '' } });
  },
};