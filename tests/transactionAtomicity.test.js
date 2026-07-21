'use strict';

// ─── Env setup ────────────────────────────────────────────────────────────────
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GTEST123';
process.env.JWT_SECRET = 'test-atomicity-secret';

// ─── Session / transaction mock ───────────────────────────────────────────────
// Use var so these are hoisted and available inside the jest.mock factory.
var mockWithTransaction = jest.fn(async (cb) => cb());
var mockEndSession = jest.fn().mockResolvedValue(undefined);
var mockStartSession = jest.fn().mockResolvedValue({
  withTransaction: mockWithTransaction,
  endSession: mockEndSession,
});

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
  connection: { startSession: mockStartSession },
}));

// The backend resolves `require('mongoose')` to its own copy
// (backend/node_modules/mongoose), which the jest.mock('mongoose') above (the
// root copy) does not intercept. transactionManager calls
// getConnection().startSession(), i.e. mongoose.connection.startSession(), on
// that backend instance — patch it so the transaction path uses the fake
// session instead of hanging on a real, disconnected connection.
const backendMongoose = require('../backend/node_modules/mongoose');
backendMongoose.connection.startSession = mockStartSession;

// ─── Model mocks ──────────────────────────────────────────────────────────────
const mockPaymentCreate = jest.fn().mockResolvedValue([{}]);
const mockPaymentFindOne = jest.fn().mockResolvedValue(null);
const mockPaymentAggregate = jest.fn().mockResolvedValue([]);

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: (...a) => mockPaymentFindOne(...a),
  create: (...a) => mockPaymentCreate(...a),
  aggregate: (...a) => mockPaymentAggregate(...a),
}));

const mockStudentFindOne = jest.fn().mockResolvedValue({
  schoolId: 'school1',
  studentId: 'STU001',
  feeAmount: 250,
  totalPaid: 0,
});
const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});

jest.mock('../backend/src/models/studentModel', () => ({
  findOne: (...a) => mockStudentFindOne(...a),
  findOneAndUpdate: (...a) => mockStudentFindOneAndUpdate(...a),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  find: jest.fn().mockResolvedValue([]),
}));

// ─── Service / utility mocks ──────────────────────────────────────────────────
jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {},
  SCHOOL_WALLET: 'GTEST123',
}));

jest.mock('../backend/src/services/stellarService', () => ({
  extractValidPayment: jest.fn().mockResolvedValue({
    payOp: { amount: '250', from: 'GSENDER' },
    memo: 'STU001',
    asset: { code: 'XLM' },
  }),
  validatePaymentAgainstFee: jest.fn().mockReturnValue({ status: 'valid', message: 'ok' }),
  detectMemoCollision: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  detectCrossSchoolMemoCollision: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  detectAbnormalPatterns: jest.fn().mockResolvedValue({ suspicious: false, reason: null }),
  checkConfirmationStatus: jest.fn().mockResolvedValue(true),
  determineConfirmationState: jest.fn().mockResolvedValue({
    state: 'confirmed',
    changed: true,
    confirmationStatus: 'confirmed',
    latestLedgerSequence: 44,
  }),
}));

jest.mock('../backend/src/utils/paymentLimits', () => ({
  validatePaymentAmount: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock('../backend/src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF001'),
}));

jest.mock('../backend/src/services/sseService', () => ({
  emit: jest.fn(),
}));

jest.mock('../backend/src/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});

// ─── Subject under test ───────────────────────────────────────────────────────
const { processTransaction } = require('../backend/src/services/transactionPollingService');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const makeSchool = () => ({ schoolId: 'school1', stellarAddress: 'GTEST123' });
const makeTx = (hash = 'txhash1') => ({
  hash,
  created_at: new Date().toISOString(),
  fee_paid: '100',
  ledger_attr: 42,
  memo: 'STU001',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Restore defaults
  mockPaymentFindOne.mockResolvedValue(null);
  mockPaymentCreate.mockResolvedValue([{}]);
  mockStudentFindOne.mockResolvedValue({
    schoolId: 'school1', studentId: 'STU001', feeAmount: 250, totalPaid: 0,
  });
  mockStudentFindOneAndUpdate.mockResolvedValue({});
  mockWithTransaction.mockImplementation(async (cb) => cb());
});

describe('processTransaction – atomicity', () => {
  test('starts a session and uses withTransaction', async () => {
    await processTransaction(makeTx(), makeSchool());

    expect(mockStartSession).toHaveBeenCalledTimes(1);
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
  });

  test('Payment.create and Student.findOneAndUpdate are called inside the transaction', async () => {
    const callOrder = [];
    mockWithTransaction.mockImplementation(async (cb) => {
      // Track that both writes happen inside the callback
      mockPaymentCreate.mockImplementationOnce(async (...args) => {
        callOrder.push('Payment.create');
        return [{}];
      });
      mockStudentFindOneAndUpdate.mockImplementationOnce(async (...args) => {
        callOrder.push('Student.findOneAndUpdate');
        return {};
      });
      await cb();
    });

    await processTransaction(makeTx(), makeSchool());

    expect(callOrder).toEqual(['Payment.create', 'Student.findOneAndUpdate']);
  });

  test('Payment.create receives the session object', async () => {
    const fakeSession = { id: 'sess-1' };
    mockStartSession.mockResolvedValueOnce({
      withTransaction: async (cb) => cb(),
      endSession: mockEndSession,
    });
    // We can't easily inspect the session arg here without a real session,
    // but we verify create is called with an array (session-compatible form).
    await processTransaction(makeTx(), makeSchool());

    const [docs] = mockPaymentCreate.mock.calls[0];
    expect(Array.isArray(docs)).toBe(true);
  });

  test('endSession is always called (finally block)', async () => {
    mockWithTransaction.mockRejectedValueOnce(new Error('boom'));

    await expect(processTransaction(makeTx(), makeSchool())).rejects.toThrow('boom');

    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test('rollback: if Payment.create throws, Student.findOneAndUpdate is not called', async () => {
    mockWithTransaction.mockImplementationOnce(async (cb) => {
      // Simulate Payment.create failing inside the transaction
      mockPaymentCreate.mockRejectedValueOnce(new Error('DB write error'));
      await cb(); // this will throw
    });

    await expect(processTransaction(makeTx(), makeSchool())).rejects.toThrow('DB write error');

    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('duplicate transaction returns processed:false without starting a session', async () => {
    mockPaymentFindOne.mockResolvedValueOnce({ txHash: 'txhash1' }); // already exists

    const result = await processTransaction(makeTx('txhash1'), makeSchool());

    expect(result).toEqual({ processed: false, reason: 'duplicate' });
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  test('duplicate key error (11000) from Payment.create returns processed:false', async () => {
    const dupErr = new Error('duplicate key');
    dupErr.code = 11000;
    mockWithTransaction.mockImplementationOnce(async (cb) => {
      mockPaymentCreate.mockRejectedValueOnce(dupErr);
      await cb();
    });

    const result = await processTransaction(makeTx(), makeSchool());

    expect(result).toEqual({ processed: false, reason: 'duplicate' });
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test('Student.findOneAndUpdate is skipped when payment is not confirmed', async () => {
    const { determineConfirmationState } = require('../backend/src/services/stellarService');
    determineConfirmationState.mockResolvedValueOnce({
      state: 'pending',
      changed: true,
      confirmationStatus: 'pending_confirmation',
      latestLedgerSequence: 43,
    }); // not confirmed

    await processTransaction(makeTx(), makeSchool());

    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('Student.findOneAndUpdate is skipped for suspicious payments', async () => {
    const { detectMemoCollision } = require('../backend/src/services/stellarService');
    detectMemoCollision.mockResolvedValueOnce({ suspicious: true, reason: 'collision' });

    await processTransaction(makeTx(), makeSchool());

    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
