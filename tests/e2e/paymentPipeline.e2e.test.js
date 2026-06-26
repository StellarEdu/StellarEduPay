'use strict';

/**
 * E2E payment pipeline — issue #749
 *
 * Exercises the real (unmocked) controller -> service -> Mongoose pipeline
 * against an in-memory MongoDB (mongodb-memory-server) and a deterministic
 * fake Horizon fixture (tests/fixtures/fakeHorizon.js). Only the Stellar
 * network boundary is replaced — paymentController, stellarService,
 * transactionService, and the real Mongoose models all run unmodified, so
 * regressions in the cross-cutting pipeline (allocation, idempotency,
 * receipts) are caught the way they would be in production.
 *
 * Covers: happy path, duplicate tx, underpayment, overpayment, memo
 * collision, and receipt generation (acceptance criteria for #749).
 *
 * Run standalone:
 *   npx jest tests/e2e --forceExit
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/e2e-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-test-secret';

jest.mock('../../backend/src/config/stellarConfig', () => {
  const fakeHorizon = require('../fixtures/fakeHorizon');
  const StellarSdk = require('@stellar/stellar-sdk');
  return {
    server: fakeHorizon.server,
    horizonClient: { server: fakeHorizon.server, call: (fn) => fn(fakeHorizon.server) },
    networkPassphrase: StellarSdk.Networks.TESTNET,
    SCHOOL_WALLET: null,
    StellarSdk,
    ACCEPTED_ASSETS: {
      XLM: { code: 'XLM', type: 'native', issuer: null, displayName: 'Stellar Lumens', decimals: 7 },
    },
    CONFIRMATION_THRESHOLD: 1,
    isAcceptedAsset: (code, type) =>
      code === 'XLM' && type === 'native'
        ? { accepted: true, asset: { code: 'XLM', type: 'native' } }
        : { accepted: false, asset: null },
    resolveAsset: (code) => (code === 'XLM' ? StellarSdk.Asset.native() : null),
  };
});

// Root and backend pin different mongoose majors (v9 vs v8) in separate
// node_modules trees, so a plain `require('mongoose')` here would resolve to a
// different singleton than the one backend/src/models/* are bound to — any
// query made through the models would buffer forever waiting on a connection
// that was never opened on their copy. Require the exact copy the models use.
const mongoose = require('../../backend/node_modules/mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const StellarSdk = require('@stellar/stellar-sdk');
const fakeHorizon = require('../fixtures/fakeHorizon');

const School = require('../../backend/src/models/schoolModel');
const Student = require('../../backend/src/models/studentModel');
const Payment = require('../../backend/src/models/paymentModel');
const PaymentIntent = require('../../backend/src/models/paymentIntentModel');
const Receipt = require('../../backend/src/models/receiptModel');
const AuditLog = require('../../backend/src/models/auditLogModel');

const { createPaymentIntent, verifyPayment, syncAllPayments } = require('../../backend/src/controllers/paymentController');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  fakeHorizon.reset();
  await Promise.all([
    School.deleteMany({}),
    Student.deleteMany({}),
    Payment.deleteMany({}),
    PaymentIntent.deleteMany({}),
    Receipt.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let schoolCounter = 0;

function makeSenderAddress() {
  return StellarSdk.Keypair.random().publicKey();
}

async function createSchool(overrides = {}) {
  schoolCounter += 1;
  return School.create({
    schoolId: overrides.schoolId || `SCH-E2E-${schoolCounter}`,
    name: 'E2E Test School',
    slug: overrides.slug || `e2e-test-school-${schoolCounter}`,
    stellarAddress: overrides.stellarAddress || StellarSdk.Keypair.random().publicKey(),
    localCurrency: 'USD',
  });
}

async function createStudent(school, overrides = {}) {
  return Student.create({
    schoolId: school.schoolId,
    studentId: overrides.studentId || 'STU-E2E-1',
    name: overrides.name || 'E2E Student',
    class: overrides.class || 'Grade 9',
    feeAmount: overrides.feeAmount ?? 250,
  });
}

function makeReq(school, body = {}, overrides = {}) {
  return {
    body,
    schoolId: school.schoolId,
    school,
    user: { email: 'admin@e2e.test' },
    ip: '127.0.0.1',
    connection: {},
    get: jest.fn((h) => (h === 'user-agent' ? 'jest-e2e' : undefined)),
    ...overrides,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Poll for a fire-and-forget side effect (e.g. receiptService.createReceipt) to land. */
async function waitFor(check, { timeout = 2000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Stellar tx hashes are 64 lowercase hex chars — derive one deterministically
// from a human-readable label so each scenario gets a stable, valid hash.
const HASH = (label) => require('crypto').createHash('sha256').update(label).digest('hex');

// ── Scenarios ────────────────────────────────────────────────────────────────

describe('E2E payment pipeline — pay -> sync -> allocate -> receipt (#749)', () => {
  test('Scenario 1 — happy path: an exact payment is verified and recorded as valid', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });
    const hash = HASH('happy1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: student.studentId,
    });

    const res = makeRes();
    const next = jest.fn();
    await verifyPayment(makeReq(school, { txHash: hash }), res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.verified).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.feeValidation.status).toBe('valid');

    const payment = await Payment.findOne({ schoolId: school.schoolId, txHash: hash });
    expect(payment).toBeTruthy();
    expect(payment.status).toBe('SUCCESS');
    expect(payment.feeValidationStatus).toBe('valid');
    expect(payment.amount).toBe(250);
    expect(payment.studentId).toBe(student.studentId);
  });

  test('Scenario 2 — duplicate transaction hash returns the cached result and is not recorded twice', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });
    const hash = HASH('dup1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: student.studentId,
    });

    await verifyPayment(makeReq(school, { txHash: hash }), makeRes(), jest.fn());
    expect(await Payment.countDocuments({ schoolId: school.schoolId, txHash: hash })).toBe(1);

    const res2 = makeRes();
    const next2 = jest.fn();
    await verifyPayment(makeReq(school, { txHash: hash }), res2, next2);

    expect(next2).not.toHaveBeenCalled();
    const body2 = res2.json.mock.calls[0][0];
    expect(body2.verified).toBe(true);
    expect(body2.cached).toBe(true);
    expect(body2.hash).toBe(hash);

    expect(await Payment.countDocuments({ schoolId: school.schoolId, txHash: hash })).toBe(1);
  });

  test('Scenario 3 — underpayment is rejected with UNDERPAID and no payment is recorded', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });
    const hash = HASH('under1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 100,
      memo: student.studentId,
    });

    const res = makeRes();
    const next = jest.fn();
    await verifyPayment(makeReq(school, { txHash: hash }), res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.code).toBe('UNDERPAID');
    expect(err.status).toBe(400);

    expect(await Payment.findOne({ schoolId: school.schoolId, txHash: hash })).toBeNull();
  });

  test('Scenario 4 — overpayment is recorded with the correct excess amount', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });
    const hash = HASH('over1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 300,
      memo: student.studentId,
    });

    const res = makeRes();
    const next = jest.fn();
    await verifyPayment(makeReq(school, { txHash: hash }), res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.feeValidation.status).toBe('overpaid');
    expect(body.feeValidation.excessAmount).toBe(50);

    const payment = await Payment.findOne({ schoolId: school.schoolId, txHash: hash });
    expect(payment.feeValidationStatus).toBe('overpaid');
    expect(payment.excessAmount).toBe(50);
  });

  test('Scenario 5 — memo collision: a memo already paid by a different sender is flagged suspicious during sync', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });
    const senderA = makeSenderAddress();
    const senderB = makeSenderAddress();
    const memo = 'COLLIDE01';

    // A confirmed payment already exists for this memo, from senderA, within the
    // 24h collision window — this is the prior payment detectMemoCollision must find.
    await Payment.create({
      schoolId: school.schoolId,
      studentId: student.studentId,
      txHash: HASH('priorpay'),
      amount: 250,
      feeAmount: 250,
      feeValidationStatus: 'valid',
      memo,
      senderAddress: senderA,
      status: 'SUCCESS',
      confirmationStatus: 'confirmed',
      confirmedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // A still-pending intent reusing the same memo — the second payer's transaction
    // will resolve through this intent during sync.
    await PaymentIntent.create({
      schoolId: school.schoolId,
      studentId: student.studentId,
      amount: 250,
      memo,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    fakeHorizon.addPaymentTransaction({
      hash: HASH('collision1'),
      to: school.stellarAddress,
      from: senderB,
      amount: 250,
      memo,
    });

    await syncAllPayments(
      makeReq(school, {}, { auditContext: { performedBy: 'cron', ipAddress: '10.0.0.1', userAgent: 'cron' } }),
      makeRes(),
      jest.fn(),
    );

    const flagged = await Payment.findOne({ schoolId: school.schoolId, txHash: HASH('collision1') });
    expect(flagged).toBeTruthy();
    expect(flagged.isSuspicious).toBe(true);
    expect(flagged.suspicionReason).toMatch(/different sender/i);

    // Suspicious payments must not be allocated to the student's balance.
    const refreshedStudent = await Student.findOne({ schoolId: school.schoolId, studentId: student.studentId });
    expect(refreshedStudent.feePaid).toBe(false);
    expect(refreshedStudent.totalPaid).toBe(0);
  });

  test('Sync allocates a matched payment to the student balance (the "allocate" step)', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });

    const intentRes = makeRes();
    await createPaymentIntent(makeReq(school, { studentId: student.studentId }), intentRes, jest.fn());
    const intent = intentRes.json.mock.calls[0][0];

    fakeHorizon.addPaymentTransaction({
      hash: HASH('alloc1'),
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: intent.memo,
    });

    const syncRes = makeRes();
    await syncAllPayments(
      makeReq(school, {}, { auditContext: { performedBy: 'cron', ipAddress: '10.0.0.1', userAgent: 'cron' } }),
      syncRes,
      jest.fn(),
    );

    const summary = syncRes.json.mock.calls[0][0].summary;
    expect(summary.matched).toBe(1);
    expect(summary.new).toBe(1);

    const refreshedStudent = await Student.findOne({ schoolId: school.schoolId, studentId: student.studentId });
    expect(refreshedStudent.totalPaid).toBe(250);
    expect(refreshedStudent.feePaid).toBe(true);

    const updatedIntent = await PaymentIntent.findById(intent._id);
    expect(updatedIntent.status).toBe('completed');
  });

  test('Scenario 6 — receipt generation: a successful verification issues a matching receipt', async () => {
    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250, name: 'Receipt Student' });
    const hash = HASH('receipt1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: student.studentId,
    });

    await verifyPayment(makeReq(school, { txHash: hash }), makeRes(), jest.fn());

    // createReceipt is fired-and-forgotten inside verifyPayment — poll briefly.
    const receipt = await waitFor(() => Receipt.findOne({ txHash: hash }));

    expect(receipt.studentId).toBe(student.studentId);
    expect(receipt.studentName).toBe('Receipt Student');
    expect(receipt.schoolId).toBe(school.schoolId);
    expect(receipt.schoolName).toBe(school.name);
    expect(receipt.amount).toBe(250);
    expect(receipt.assetCode).toBe('XLM');
    expect(receipt.feeValidationStatus).toBe('valid');
  });

  // ── #809 — webhook + SSE side-effect assertions ───────────────────────────

  test('Scenario 7 — webhook: a successful payment fires the school webhook with an HMAC signature', async () => {
    const webhookService = require('../../backend/src/services/webhookService');
    const spy = jest.spyOn(webhookService, 'notifyPaymentConfirmed').mockResolvedValue(undefined);

    const school = await createSchool();
    await School.updateOne({ schoolId: school.schoolId }, { webhookUrl: 'https://example.com/webhook', webhookSecret: 'test-secret' });
    const updatedSchool = await School.findOne({ schoolId: school.schoolId });

    const student = await createStudent(updatedSchool, { feeAmount: 250 });
    const hash = HASH('webhook1');

    fakeHorizon.addPaymentTransaction({
      hash,
      to: updatedSchool.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: student.studentId,
    });

    await verifyPayment(makeReq(updatedSchool, { txHash: hash }), makeRes(), jest.fn());

    // Webhook is fired asynchronously after payment.saved event
    await waitFor(() => spy.mock.calls.length > 0);

    expect(spy).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ txHash: hash, status: 'SUCCESS' }),
      null,
      'test-secret',
    );

    spy.mockRestore();
  });

  test('Scenario 8 — SSE: a sync emits a payment event to the school channel', async () => {
    const sseService = require('../../backend/src/services/sseService');
    const spy = jest.spyOn(sseService, 'emit');

    const school = await createSchool();
    const student = await createStudent(school, { feeAmount: 250 });

    const intentRes = makeRes();
    await createPaymentIntent(makeReq(school, { studentId: student.studentId }), intentRes, jest.fn());
    const intent = intentRes.json.mock.calls[0][0];

    fakeHorizon.addPaymentTransaction({
      hash: HASH('sse1'),
      to: school.stellarAddress,
      from: makeSenderAddress(),
      amount: 250,
      memo: intent.memo,
    });

    await syncAllPayments(
      makeReq(school, {}, { auditContext: { performedBy: 'cron', ipAddress: '10.0.0.1', userAgent: 'cron' } }),
      makeRes(),
      jest.fn(),
    );

    expect(spy).toHaveBeenCalledWith(
      school.schoolId,
      'payment',
      expect.objectContaining({ txHash: HASH('sse1') }),
    );

    spy.mockRestore();
  });
});
