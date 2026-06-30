'use strict';

/**
 * Tests for Issue #70 — pagination enforcement and CSV streaming.
 *
 * Acceptance criteria:
 *   1. getAllPayments, getSuspiciousPayments, getRetryQueue, getOverpayments,
 *      and getPendingPayments are all paginated with a max page size of 100.
 *   2. Requesting limit > 100 is silently capped at 100 by the controller.
 *   3. The schema middleware rejects limit > 100 with a 400.
 *   4. Default sort on getAllPayments uses the { schoolId, confirmedAt } index.
 *   5. generateAccountingCsvStream writes rows progressively to the response
 *      object rather than buffering all rows in memory.
 */

// ── Payment model mock ────────────────────────────────────────────────────────
const mockPaymentFind = jest.fn();
const mockPaymentCount = jest.fn();

jest.mock('../src/models/paymentModel', () => ({
  find: (...args) => {
    const chain = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      lean: () => Promise.resolve(mockPaymentFind(...args)),
    };
    return chain;
  },
  countDocuments: (...args) => mockPaymentCount(...args),
  aggregate: jest.fn(() => ({ cursor: () => ({ [Symbol.asyncIterator]: async function*() {} }) })),
}));

jest.mock('../src/models/pendingVerificationModel', () => ({
  find: jest.fn(() => {
    const chain = {
      sort: () => chain,
      skip: () => chain,
      limit: () => Promise.resolve([]),
    };
    return chain;
  }),
  countDocuments: jest.fn(() => Promise.resolve(0)),
}));

jest.mock('../src/models/studentModel', () => ({ findOne: jest.fn(), aggregate: jest.fn(() => []) }));
jest.mock('../src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn(async () => ({ available: false, currency: 'USD' })),
  enrichPaymentWithConversion: jest.fn(async (p) => p),
}));
jest.mock('../src/config/stellarConfig', () => ({
  ACCEPTED_ASSETS: {},
  server: {},
}));
jest.mock('../src/utils/paymentLimits', () => ({
  getPaymentLimits: () => ({ min: 0.01, max: 100000 }),
}));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

process.env.MONGO_URI = 'mongodb://localhost/test';
process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long';

const {
  getAllPayments,
  getSuspiciousPayments,
  getOverpayments,
  getPendingPayments,
} = require('../src/controllers/paymentQueryController');

const { validate } = require('../src/middleware/validate');
const {
  getAllPaymentsSchema,
  getSuspiciousPaymentsSchema,
  paginationOnlySchema,
} = require('../src/middleware/schemas/paymentQuerySchemas');

function buildReq(query = {}, school = { localCurrency: 'USD' }) {
  return { schoolId: 'school-1', school, query, params: {} };
}

function buildRes() {
  const res = {
    statusCode: 200,
    body: null,
    _headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this._headers[k] = v; return this; },
  };
  return res;
}

describe('Issue #70 — pagination enforcement', () => {
  beforeEach(() => {
    mockPaymentFind.mockReturnValue([]);
    mockPaymentCount.mockResolvedValue(0);
    jest.clearAllMocks();
    mockPaymentFind.mockReturnValue([]);
    mockPaymentCount.mockResolvedValue(0);
  });

  describe('getAllPayments — max page size cap', () => {
    it('caps limit at 100 when caller requests 500', async () => {
      const sortSpy = jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
        }),
      });
      // Patch Payment.find to capture the limit call
      const Payment = require('../src/models/paymentModel');
      let capturedLimit;
      Payment.find = () => ({
        sort: () => ({
          skip: () => ({
            limit: (n) => { capturedLimit = n; return { lean: () => Promise.resolve([]) }; },
          }),
        }),
      });

      const req = buildReq({ limit: '500' });
      const res = buildRes();
      await getAllPayments(req, res, jest.fn());

      expect(res.statusCode).toBe(200);
      expect(capturedLimit).toBeLessThanOrEqual(100);
    });

    it('returns pagination metadata in the response', async () => {
      const Payment = require('../src/models/paymentModel');
      Payment.find = () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });
      Payment.countDocuments = () => Promise.resolve(250);

      const req = buildReq({ page: '2', limit: '50' });
      const res = buildRes();
      await getAllPayments(req, res, jest.fn());

      expect(res.body).toMatchObject({
        pagination: {
          page: 2,
          limit: 50,
          total: 250,
          totalPages: 5,
          hasNext: true,
          hasPrev: true,
        },
      });
    });
  });

  describe('getSuspiciousPayments — now paginated', () => {
    it('returns a pagination object', async () => {
      const Payment = require('../src/models/paymentModel');
      Payment.find = () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) });
      Payment.countDocuments = () => Promise.resolve(30);

      const res = buildRes();
      await getSuspiciousPayments(buildReq({ page: '1', limit: '10' }), res, jest.fn());

      expect(res.body).toHaveProperty('pagination');
      expect(res.body.pagination.total).toBe(30);
    });
  });

  describe('getOverpayments — max page size cap', () => {
    it('caps limit at 100', async () => {
      const Payment = require('../src/models/paymentModel');
      let capturedLimit;
      Payment.find = () => ({
        sort: () => ({
          skip: () => ({
            limit: (n) => { capturedLimit = n; return Promise.resolve([]); },
          }),
        }),
      });
      Payment.countDocuments = () => Promise.resolve(0);

      await getOverpayments(buildReq({ limit: '9999' }), buildRes(), jest.fn());
      expect(capturedLimit).toBeLessThanOrEqual(100);
    });
  });

  describe('getPendingPayments — max page size cap', () => {
    it('caps limit at 100', async () => {
      const Payment = require('../src/models/paymentModel');
      let capturedLimit;
      Payment.find = () => ({
        sort: () => ({
          skip: () => ({
            limit: (n) => { capturedLimit = n; return Promise.resolve([]); },
          }),
        }),
      });
      Payment.countDocuments = () => Promise.resolve(0);

      await getPendingPayments(buildReq({ limit: '9999' }), buildRes(), jest.fn());
      expect(capturedLimit).toBeLessThanOrEqual(100);
    });
  });
});

describe('Issue #70 — query schema rejects limit > 100', () => {
  function runMiddleware(schema, query) {
    const req = { query: { ...query } };
    const res = buildRes();
    const next = jest.fn();
    validate(schema, 'query')(req, res, next);
    return { req, res, next };
  }

  it('getAllPaymentsSchema: rejects limit=200', () => {
    const { res, next } = runMiddleware(getAllPaymentsSchema, { limit: '200' });
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('getAllPaymentsSchema: allows limit=100', () => {
    const { res, next } = runMiddleware(getAllPaymentsSchema, { limit: '100' });
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
  });

  it('getSuspiciousPaymentsSchema: rejects limit=500', () => {
    const { res, next } = runMiddleware(getSuspiciousPaymentsSchema, { limit: '500' });
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('paginationOnlySchema: rejects limit=101', () => {
    const { res, next } = runMiddleware(paginationOnlySchema, { limit: '101' });
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Issue #70 — generateAccountingCsvStream writes rows progressively', () => {
  it('streams rows without buffering the entire result set', async () => {
    // Inject a fake cursor that yields 3 payment rows
    const fakeRows = [
      { schoolId: 's1', txHash: 'tx1', studentId: 'stu1', amount: 10, status: 'SUCCESS',
        confirmedAt: new Date(), assetCode: 'XLM', assetType: 'crypto', _student: [] },
      { schoolId: 's1', txHash: 'tx2', studentId: 'stu2', amount: 20, status: 'SUCCESS',
        confirmedAt: new Date(), assetCode: 'USDC', assetType: 'credit_alphanum4', _student: [] },
      { schoolId: 's1', txHash: 'tx3', studentId: 'stu3', amount: 30, status: 'SUCCESS',
        confirmedAt: new Date(), assetCode: 'XLM', assetType: 'crypto', _student: [] },
    ];

    const Payment = require('../src/models/paymentModel');
    Payment.aggregate = jest.fn(() => ({
      cursor: () => ({
        async *[Symbol.asyncIterator]() {
          for (const r of fakeRows) yield r;
        },
      }),
    }));

    // Minimal response mock that tracks writes
    const writes = [];
    const fakeRes = {
      write: (chunk) => writes.push(chunk),
      end: jest.fn(),
    };

    const { generateAccountingCsvStream } = require('../src/services/reportService');
    await generateAccountingCsvStream({ schoolId: 's1', res: fakeRes });

    // Header row + 3 data rows must all be written.
    expect(writes.length).toBe(4); // 1 header + 3 rows
    expect(fakeRes.end).toHaveBeenCalledTimes(1);

    // Header must be the first write.
    expect(writes[0]).toContain('schema_version');
    expect(writes[0]).toContain('tx_hash');
  });
});
