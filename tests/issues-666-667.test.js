'use strict';

/**
 * Tests for:
 *   #666 — redactConfig() masks secret keys before logging
 *   #667 — GET /api/fees filters inactive fee structures for unauthenticated callers
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = () => log;
  log.logger = log;
  log.setLevel = jest.fn();
  log.getLevel = jest.fn(() => 'info');
  return log;
});

jest.mock('../backend/src/models/feeStructureModel');
jest.mock('../backend/src/cache', () => ({
  get: jest.fn().mockReturnValue(undefined),
  set: jest.fn(),
  del: jest.fn(),
  KEYS: { feesAll: () => 'fees:all', feeByClass: (c) => `fees:class:${c}` },
  TTL: { FEES: 60 },
}));
jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));

// redactConfig lives in a standalone file with no external deps — require directly
const { redactConfig, SENSITIVE_KEYS } = require('../backend/src/utils/redactConfig');
const FeeStructure = require('../backend/src/models/feeStructureModel');
const { getAllFeeStructures } = require('../backend/src/controllers/feeController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeSortableQuery(results) {
  return { sort: jest.fn().mockResolvedValue(results) };
}

beforeEach(() => jest.clearAllMocks());

// ── #666 — redactConfig ───────────────────────────────────────────────────────

describe('#666 — redactConfig()', () => {
  test('redacts JWT_SECRET', () => {
    const result = redactConfig({ JWT_SECRET: 'super-secret', PORT: 5000 });
    expect(result.JWT_SECRET).toBe('[REDACTED]');
    expect(result.PORT).toBe(5000);
  });

  test('redacts MONGO_URI', () => {
    expect(redactConfig({ MONGO_URI: 'mongodb://user:pass@host/db' }).MONGO_URI).toBe('[REDACTED]');
  });

  test('redacts MEMO_ENCRYPTION_KEY', () => {
    expect(redactConfig({ MEMO_ENCRYPTION_KEY: 'abc123' }).MEMO_ENCRYPTION_KEY).toBe('[REDACTED]');
  });

  test('redacts WEBHOOK_SECRET', () => {
    expect(redactConfig({ WEBHOOK_SECRET: 'wh-secret' }).WEBHOOK_SECRET).toBe('[REDACTED]');
  });

  test('redacts SMTP_PASS', () => {
    expect(redactConfig({ SMTP_PASS: 'mailpass' }).SMTP_PASS).toBe('[REDACTED]');
  });

  test('redacts REDIS_PASSWORD', () => {
    expect(redactConfig({ REDIS_PASSWORD: 'redispass' }).REDIS_PASSWORD).toBe('[REDACTED]');
  });

  test('preserves non-sensitive fields unchanged', () => {
    const input = { PORT: 5000, STELLAR_NETWORK: 'testnet', IS_TESTNET: true };
    expect(redactConfig(input)).toEqual(input);
  });

  test('handles null value for sensitive key', () => {
    expect(redactConfig({ JWT_SECRET: null }).JWT_SECRET).toBe('[REDACTED]');
  });

  test('handles undefined value for sensitive key', () => {
    expect(redactConfig({ MONGO_URI: undefined }).MONGO_URI).toBeUndefined();
  });

  test('returns non-object input unchanged', () => {
    expect(redactConfig(null)).toBeNull();
    expect(redactConfig('string')).toBe('string');
  });

  test('SENSITIVE_KEYS contains all required keys', () => {
    for (const key of ['JWT_SECRET', 'MEMO_ENCRYPTION_KEY', 'WEBHOOK_SECRET', 'MONGO_URI', 'SMTP_PASS']) {
      expect(SENSITIVE_KEYS.has(key)).toBe(true);
    }
  });

  test('does not mutate the original object', () => {
    const original = { JWT_SECRET: 'secret', PORT: 5000 };
    redactConfig(original);
    expect(original.JWT_SECRET).toBe('secret');
  });
});

// ── #667 — getAllFeeStructures filtering ──────────────────────────────────────

describe('#667 — getAllFeeStructures inactive filtering', () => {
  const activeFee   = { className: 'Grade 5A', feeAmount: 250, isActive: true };
  const inactiveFee = { className: 'Grade 4B', feeAmount: 200, isActive: false };

  test('unauthenticated caller only receives active fee structures', async () => {
    FeeStructure.find.mockReturnValue(makeSortableQuery([activeFee]));
    const req = { schoolId: 'SCH-001', query: {}, admin: undefined };
    const res = makeRes();
    await getAllFeeStructures(req, res, jest.fn());

    expect(FeeStructure.find.mock.calls[0][0].isActive).toBe(true);
    expect(res.json).toHaveBeenCalledWith([activeFee]);
  });

  test('authenticated admin receives all fee structures including inactive', async () => {
    FeeStructure.find.mockReturnValue(makeSortableQuery([activeFee, inactiveFee]));
    const req = { schoolId: 'SCH-001', query: {}, admin: { role: 'admin' } };
    const res = makeRes();
    await getAllFeeStructures(req, res, jest.fn());

    expect(FeeStructure.find.mock.calls[0][0].isActive).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith([activeFee, inactiveFee]);
  });

  test('unauthenticated caller with includeDeleted=true still only sees active fees', async () => {
    const queryObj = { sort: jest.fn().mockResolvedValue([activeFee]), includeDeleted: jest.fn() };
    FeeStructure.find.mockReturnValue(queryObj);
    const req = { schoolId: 'SCH-001', query: { includeDeleted: 'true' }, admin: undefined };
    await getAllFeeStructures(req, makeRes(), jest.fn());

    expect(FeeStructure.find.mock.calls[0][0].isActive).toBe(true);
  });

  test('admin with includeDeleted=true sees all fees without isActive filter', async () => {
    const queryObj = { sort: jest.fn().mockResolvedValue([activeFee, inactiveFee]), includeDeleted: jest.fn() };
    FeeStructure.find.mockReturnValue(queryObj);
    const req = { schoolId: 'SCH-001', query: { includeDeleted: 'true' }, admin: { role: 'admin' } };
    await getAllFeeStructures(req, makeRes(), jest.fn());

    expect(FeeStructure.find.mock.calls[0][0].isActive).toBeUndefined();
  });

  test('unauthenticated caller result is cached', async () => {
    const { set } = require('../backend/src/cache');
    FeeStructure.find.mockReturnValue(makeSortableQuery([activeFee]));
    const req = { schoolId: 'SCH-001', query: {}, admin: undefined };
    await getAllFeeStructures(req, makeRes(), jest.fn());

    expect(set).toHaveBeenCalledWith('fees:all', [activeFee], 60);
  });

  test('admin result is NOT cached (prevents inactive fees leaking into unauthenticated cache)', async () => {
    const { set } = require('../backend/src/cache');
    FeeStructure.find.mockReturnValue(makeSortableQuery([activeFee, inactiveFee]));
    const req = { schoolId: 'SCH-001', query: {}, admin: { role: 'admin' } };
    await getAllFeeStructures(req, makeRes(), jest.fn());

    expect(set).not.toHaveBeenCalled();
  });
});
