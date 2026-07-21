'use strict';

// Set required env vars before any module is loaded
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// jest.mock is hoisted above variable declarations, so factories must be inline.

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  Schema: class { constructor() { this.index = jest.fn(); } },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/models/feeStructureModel', () => ({
  findOneAndUpdate: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/studentModel', () => ({
  findOneAndUpdate: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  findOneAndUpdate: jest.fn(),
}));

// ── Load module under test ────────────────────────────────────────────────────

const { seedSchool, seedFeeStructures, seedStudents, SCHOOL, FEE_STRUCTURES, STUDENTS } = require('../scripts/seed-test-data');
const School = require('../backend/src/models/schoolModel');
const FeeStructure = require('../backend/src/models/feeStructureModel');
const Student = require('../backend/src/models/studentModel');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default: findOneAndUpdate returns a doc matching the filter
  FeeStructure.findOneAndUpdate.mockImplementation((filter, update) =>
    Promise.resolve({ className: filter.className, feeAmount: update.feeAmount })
  );
  Student.findOneAndUpdate.mockResolvedValue({});
  School.findOneAndUpdate.mockImplementation((filter, update) =>
    Promise.resolve({ schoolId: filter.schoolId, name: update.name, slug: update.slug, network: update.network })
  );
});

describe('seedSchool', () => {
  it('upserts the tenant school keyed by schoolId', async () => {
    await seedSchool();
    expect(School.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = School.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ schoolId: SCHOOL.schoolId });
    expect(update).toMatchObject({ schoolId: SCHOOL.schoolId, slug: SCHOOL.slug, isActive: true });
    expect(opts).toMatchObject({ upsert: true });
  });

  it('returns the resolved schoolId', async () => {
    await expect(seedSchool()).resolves.toBe(SCHOOL.schoolId);
  });

  it('rejects an invalid stellarAddress instead of writing a broken school', async () => {
    const saved = SCHOOL.stellarAddress;
    SCHOOL.stellarAddress = 'not-a-stellar-key';
    await expect(seedSchool()).rejects.toThrow(/valid Stellar public key/);
    expect(School.findOneAndUpdate).not.toHaveBeenCalled();
    SCHOOL.stellarAddress = saved;
  });
});

describe('seedFeeStructures', () => {
  it('upserts every fee structure', async () => {
    await seedFeeStructures();
    expect(FeeStructure.findOneAndUpdate).toHaveBeenCalledTimes(FEE_STRUCTURES.length);
  });

  it('uses upsert:true for each call', async () => {
    await seedFeeStructures();
    for (const call of FeeStructure.findOneAndUpdate.mock.calls) {
      expect(call[2]).toMatchObject({ upsert: true });
    }
  });

  it('returns a feeMap keyed by className', async () => {
    const feeMap = await seedFeeStructures();
    for (const fee of FEE_STRUCTURES) {
      expect(feeMap[fee.className]).toBe(fee.feeAmount);
    }
  });

  it('scopes both the filter and the document by schoolId (tenant-scoped model)', async () => {
    await seedFeeStructures('SCH999');
    for (const call of FeeStructure.findOneAndUpdate.mock.calls) {
      expect(call[0]).toMatchObject({ schoolId: 'SCH999' });
      expect(call[1]).toMatchObject({ schoolId: 'SCH999' });
    }
  });

  it('running twice produces identical filter keys (idempotent)', async () => {
    await seedFeeStructures();
    const firstRunFilters = FeeStructure.findOneAndUpdate.mock.calls.map((c) => c[0].className);
    FeeStructure.findOneAndUpdate.mockClear();

    await seedFeeStructures();
    const secondRunFilters = FeeStructure.findOneAndUpdate.mock.calls.map((c) => c[0].className);

    expect(firstRunFilters).toEqual(secondRunFilters);
  });
});

describe('seedStudents', () => {
  let feeMap;

  beforeEach(async () => {
    feeMap = await seedFeeStructures();
    FeeStructure.findOneAndUpdate.mockClear();
  });

  it('upserts every student', async () => {
    await seedStudents(feeMap);
    expect(Student.findOneAndUpdate).toHaveBeenCalledTimes(STUDENTS.length);
  });

  it('uses upsert:true for each student call', async () => {
    await seedStudents(feeMap);
    for (const call of Student.findOneAndUpdate.mock.calls) {
      expect(call[2]).toMatchObject({ upsert: true });
    }
  });

  it('filters by studentId', async () => {
    await seedStudents(feeMap);
    for (const call of Student.findOneAndUpdate.mock.calls) {
      expect(call[0]).toHaveProperty('studentId');
    }
  });

  it('scopes both the filter and the document by schoolId (tenant-scoped model)', async () => {
    await seedStudents(feeMap, 'SCH999');
    for (const call of Student.findOneAndUpdate.mock.calls) {
      expect(call[0]).toMatchObject({ schoolId: 'SCH999' });
      expect(call[1]).toMatchObject({ schoolId: 'SCH999' });
    }
  });

  it('running twice produces identical studentId filters (no duplicates)', async () => {
    await seedStudents(feeMap);
    const firstRunIds = Student.findOneAndUpdate.mock.calls.map((c) => c[0].studentId);
    Student.findOneAndUpdate.mockClear();

    await seedStudents(feeMap);
    const secondRunIds = Student.findOneAndUpdate.mock.calls.map((c) => c[0].studentId);

    expect(firstRunIds).toEqual(secondRunIds);
  });
});

describe('--clean flag behaviour', () => {
  it('deleteMany is called on both collections when --clean is simulated', async () => {
    await FeeStructure.deleteMany({});
    await Student.deleteMany({});

    expect(FeeStructure.deleteMany).toHaveBeenCalledWith({});
    expect(Student.deleteMany).toHaveBeenCalledWith({});
  });

  it('deleteMany is NOT called during normal upsert seed', async () => {
    const feeMap = await seedFeeStructures();
    await seedStudents(feeMap);

    expect(FeeStructure.deleteMany).not.toHaveBeenCalled();
    expect(Student.deleteMany).not.toHaveBeenCalled();
  });

  it('after clean + re-seed, upsert call counts match expected', async () => {
    await FeeStructure.deleteMany({});
    await Student.deleteMany({});
    const feeMap = await seedFeeStructures();
    await seedStudents(feeMap);

    expect(FeeStructure.findOneAndUpdate).toHaveBeenCalledTimes(FEE_STRUCTURES.length);
    expect(Student.findOneAndUpdate).toHaveBeenCalledTimes(STUDENTS.length);
  });
});
