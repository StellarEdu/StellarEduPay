'use strict';

/**
 * Tests for issue #639 — getPendingPayments pagination
 */

// Set required env vars
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-secret';

// Mock payment model
let _mockDocs = [];
let _mockTotal = 0;
let _lastSkip = null;
let _lastLimit = null;
let _lastFilter = null;

const mockPayment = {
  find: jest.fn((filter) => {
    _lastFilter = filter;
    const chain = {
      sort: jest.fn(() => chain),
      skip: jest.fn((n) => {
        _lastSkip = n;
        return chain;
      }),
      limit: jest.fn((n) => {
        _lastLimit = n;
        return Promise.resolve(_mockDocs);
      }),
    };
    return chain;
  }),
  countDocuments: jest.fn((filter) => {
    return Promise.resolve(_mockTotal);
  }),
};

// Mock dependencies required by paymentController.js
jest.mock('../backend/src/models/paymentModel', () => mockPayment);
jest.mock('../backend/src/models/paymentIntentModel', () => ({}));
jest.mock('../backend/src/models/studentModel', () => ({}));
jest.mock('../backend/src/models/pendingVerificationModel', () => ({}));
jest.mock('../backend/src/services/stellarService', () => ({}));
jest.mock('../backend/src/services/retryService', () => ({}));
jest.mock('../backend/src/queue/transactionQueue', () => ({}));
jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ACCEPTED_ASSETS: {},
}));
jest.mock('../backend/src/utils/hashValidator', () => ({}));
jest.mock('../backend/src/utils/paymentLimits', () => ({}));
jest.mock('../backend/src/services/currencyConversionService', () => ({}));
jest.mock('../backend/src/utils/withStellarRetry', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({}));

const { getPendingPayments } = require('../backend/src/controllers/paymentController');

function mockReq(query = {}) {
  return { schoolId: 'SCH-TEST', query };
}

function mockRes() {
  const res = {};
  res.json = jest.fn();
  return res;
}

describe('#639 getPendingPayments pagination', () => {
  beforeEach(() => {
    _mockDocs = [];
    _mockTotal = 0;
    _lastSkip = null;
    _lastLimit = null;
    _lastFilter = null;
    jest.clearAllMocks();
  });

  it('returns pagination object with default page=1 limit=50', async () => {
    _mockDocs = Array(50).fill({ studentId: 'STU001', confirmationStatus: 'pending_confirmation' });
    _mockTotal = 120;

    const res = mockRes();
    await getPendingPayments(mockReq({}), res, jest.fn());

    const [body] = res.json.mock.calls[0];
    expect(body.count).toBe(50);
    expect(body.pending).toHaveLength(50);
    expect(body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 120,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });
    expect(_lastSkip).toBe(0);
    expect(_lastLimit).toBe(50);
    expect(_lastFilter).toEqual({
      schoolId: 'SCH-TEST',
      confirmationStatus: 'pending_confirmation',
    });
  });

  it('respects page and limit query params', async () => {
    _mockDocs = Array(20).fill({ studentId: 'STU001', confirmationStatus: 'pending_confirmation' });
    _mockTotal = 120;

    const res = mockRes();
    await getPendingPayments(mockReq({ page: '2', limit: '20' }), res, jest.fn());

    expect(_lastSkip).toBe(20);
    expect(_lastLimit).toBe(20);
    const [body] = res.json.mock.calls[0];
    expect(body.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 120,
      totalPages: 6,
      hasNext: true,
      hasPrev: true,
    });
  });

  it('caps limit at 100', async () => {
    _mockDocs = [];
    _mockTotal = 0;

    await getPendingPayments(mockReq({ limit: '9999' }), mockRes(), jest.fn());

    expect(_lastLimit).toBe(100);
  });
});
