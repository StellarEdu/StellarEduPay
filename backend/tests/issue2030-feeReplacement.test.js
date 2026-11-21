'use strict';

const records = [];
const FeeStructure = {
  findOne: jest.fn(async ({ schoolId, className, isActive }) =>
    records.find((record) =>
      record.schoolId === schoolId &&
      record.className === className &&
      record.isActive === isActive
    ) || null
  ),
  create: jest.fn(async (record) => {
    if (records.some((item) =>
      item.schoolId === record.schoolId &&
      item.className === record.className &&
      item.isActive
    )) {
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    const created = { ...record, _id: String(records.length + 1) };
    records.push(created);
    return created;
  }),
  findOneAndUpdate: jest.fn(async ({ schoolId, className }, update) => {
    const record = records.find((item) =>
      item.schoolId === schoolId && item.className === className && item.isActive
    );
    if (!record) return null;
    Object.assign(record, update);
    return record;
  }),
};

jest.mock('../src/models/feeStructureModel', () => FeeStructure);
jest.mock('../src/models/studentModel', () => ({
  countDocuments: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/models/schoolModel', () => ({
  findOne: jest.fn(() => ({
    select: () => ({ lean: async () => ({ feeCurrency: 'XLM' }) }),
  })),
}));
jest.mock('../src/cache', () => ({
  del: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  KEYS: { feesAll: jest.fn(), feeByClass: jest.fn() },
  TTL: { FEES: 60 },
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const { createFeeStructure, deleteFeeStructure } = require('../src/controllers/feeController');

function response() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function createRequest(amount) {
  return {
    schoolId: 'school-1',
    body: { className: 'Grade 1', feeAmount: amount },
    headers: {},
  };
}

beforeEach(() => {
  records.length = 0;
  jest.clearAllMocks();
});

test('a deactivated fee structure can be replaced for the same class (#2030)', async () => {
  const next = jest.fn();
  const firstResponse = response();
  await createFeeStructure(createRequest(100), firstResponse, next);
  expect(firstResponse.status).toHaveBeenCalledWith(201);

  await deleteFeeStructure(
    { schoolId: 'school-1', params: { className: 'Grade 1' }, query: {}, headers: {} },
    response(),
    next
  );

  const replacementResponse = response();
  await createFeeStructure(createRequest(125), replacementResponse, next);
  expect(replacementResponse.status).toHaveBeenCalledWith(201);
  expect(records).toHaveLength(2);
  expect(records.map(({ isActive }) => isActive)).toEqual([false, true]);
  expect(next).not.toHaveBeenCalled();
});

test('a duplicate-key race maps to DUPLICATE_FEE_STRUCTURE with 409', async () => {
  FeeStructure.findOne.mockResolvedValueOnce(null);
  FeeStructure.create.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 11000 }));
  const next = jest.fn();
  await createFeeStructure(createRequest(100), response(), next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({
    code: 'DUPLICATE_FEE_STRUCTURE',
    status: 409,
  }));
});

test('schema uses an active-only partial unique index', () => {
  jest.isolateModules(() => {
    const mongoose = require('mongoose');
    const model = jest.requireActual('../src/models/feeStructureModel');
    const index = model.schema.indexes().find(([, options]) =>
      options.name === 'uniq_active_fee_structure_per_class'
    );
    expect(index).toEqual([
      { schoolId: 1, className: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { isActive: true },
      }),
    ]);
    expect(mongoose).toBeDefined();
  });
});
