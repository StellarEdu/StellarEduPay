'use strict';

/**
 * Regression coverage for the payment-verification money-precision bug:
 * paymentController.verifyPayment (and the studentBalanceUpdater it shares
 * with submitTransaction) used to sum payments with MongoDB's float `$sum`,
 * round with `toFixed(7)`, and re-parse with `parseFloat` before comparing
 * against `feeAmount` with `<`/`>`/`===`. A fee settled across several
 * installments that sum, in exact decimal, to precisely the fee amount could
 * land one unit-in-the-last-place away and be misclassified 'partial' or
 * 'overpaid' instead of 'valid'.
 *
 * The fix (backend/src/utils/money.js) sums via `{ $sum: { $toDecimal: ... } }`
 * so MongoDB itself adds in exact Decimal128 space, and classifies with
 * decimal.js instead of float comparison operators.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const Decimal = require('decimal.js');

jest.setTimeout(60000);

const { classifyFeePayment } = require('../backend/src/utils/money');

let mongoServer;
const TEST_DB = 'money_precision_test';
const USE_EXTERNAL_MONGO = !!process.env.MONGO_URI;

// Installment amounts deliberately chosen to expose float addition error —
// 0.1 + 0.2 !== 0.3 is the canonical example; 0.7 and its siblings are picked
// for the same reason (no exact binary representation).
const TRAP_PATTERN = ['0.1', '0.2', '0.7', '0.3', '0.6', '0.4', '0.9', '0.15', '0.35', '0.05'];

function installmentsForN(n) {
  const amounts = [];
  for (let i = 0; i < n; i++) amounts.push(TRAP_PATTERN[i % TRAP_PATTERN.length]);
  return amounts;
}

function exactSum(decimalStrings) {
  return decimalStrings.reduce((acc, s) => acc.plus(new Decimal(s)), new Decimal(0));
}

describe('money precision — classifyFeePayment (pure, no DB)', () => {
  test.each(Array.from({ length: 19 }, (_, i) => i + 2))(
    'a fee settled by %i installments summing exactly to the fee is classified valid',
    (n) => {
      const installments = installmentsForN(n);
      const feeAmount = exactSum(installments).toNumber();

      // Feed installments through the same fold classifyFeePayment's caller
      // uses in paymentController.verifyPayment: running Decimal accumulation.
      let cumulative = new Decimal(0);
      let result;
      for (const amount of installments) {
        cumulative = cumulative.plus(amount);
        result = classifyFeePayment(cumulative, feeAmount);
      }

      expect(result.status).toBe('valid');
      expect(result.feePaid).toBe(true);
      expect(result.remainingBalance).toBe(0);
      expect(result.excessAmount).toBe(0);
    },
  );

  test('the classic float artifact (0.1 + 0.2) is classified valid against a 0.3 fee', () => {
    let cumulative = new Decimal(0).plus('0.1').plus('0.2');
    // Sanity check this would actually trip up naive float arithmetic.
    expect(0.1 + 0.2).not.toBe(0.3);

    const result = classifyFeePayment(cumulative, 0.3);
    expect(result.status).toBe('valid');
    expect(result.remainingBalance).toBe(0);
  });
});

describe('money precision — studentBalanceUpdater against a real MongoDB aggregation', () => {
  let Student;
  let Payment;
  let updateStudentBalance;
  let mongoose;

  beforeAll(async () => {
    // Require the model first and connect via *its* mongoose instance
    // (`Student.base`), not a freshly-required top-level `mongoose`. `tests/`
    // and `backend/src/` install their dependencies separately (root `npm
    // install` vs `backend && npm install`), so a bare `require('mongoose')`
    // from this file can resolve to a different physical copy — and thus a
    // different connection singleton — than the one backend/src/models are
    // bound to, which manifests as every query buffering forever against a
    // connection that was never actually opened.
    Student = require('../backend/src/models/studentModel');
    Payment = require('../backend/src/models/paymentModel');
    ({ updateStudentBalance } = require('../backend/src/utils/studentBalanceUpdater'));
    mongoose = Student.base;

    if (USE_EXTERNAL_MONGO) {
      const baseUri = process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
      await mongoose.connect(baseUri);
    } else {
      mongoServer = await MongoMemoryServer.create();
      await mongoose.connect(mongoServer.getUri());
    }
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    await Student.deleteMany({}).bypassTenantScope();
    await Payment.deleteMany({}).bypassTenantScope();
  });

  test.each(Array.from({ length: 19 }, (_, i) => i + 2))(
    'settling via %i real Payment documents leaves remainingBalance exactly zero',
    async (n) => {
      const schoolId = 'SCH-MONEY-TEST';
      const studentId = `STU-N${n}`;
      const installments = installmentsForN(n);
      const feeAmount = exactSum(installments).toNumber();

      await Student.create({ schoolId, studentId, name: 'Test Student', class: 'Grade 1', feeAmount });

      for (const amount of installments) {
        await Payment.create({
          schoolId,
          studentId,
          txHash: `tx-${studentId}-${amount}-${Math.random().toString(36).slice(2)}`,
          amount: Number(amount),
          status: 'SUCCESS',
          isSuspicious: false,
        });
      }

      const updated = await updateStudentBalance(schoolId, studentId);

      expect(updated.totalPaid).toBe(feeAmount);
      expect(updated.remainingBalance).toBe(0);
      expect(updated.feePaid).toBe(true);
    },
  );

  test('a fully-settled student has remainingBalance exactly 0 (not a float epsilon)', async () => {
    const schoolId = 'SCH-MONEY-TEST';
    const studentId = 'STU-ZERO';
    await Student.create({ schoolId, studentId, name: 'Zero Student', class: 'Grade 1', feeAmount: 0.3 });

    await Payment.create({ schoolId, studentId, txHash: 'tx-zero-1', amount: 0.1, status: 'SUCCESS', isSuspicious: false });
    await Payment.create({ schoolId, studentId, txHash: 'tx-zero-2', amount: 0.2, status: 'SUCCESS', isSuspicious: false });

    const updated = await updateStudentBalance(schoolId, studentId);

    expect(updated.remainingBalance).toBe(0);
    expect(Object.is(updated.remainingBalance, -0)).toBe(false);
    expect(updated.feePaid).toBe(true);
    expect(updated.totalPaid).toBe(0.3);
  });
});
