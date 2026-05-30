'use strict';

/**
 * Tests for POST /api/schools duplicate slug — issue #609
 * Verifies that creating a school with a duplicate slug returns 409 DUPLICATE_SCHOOL.
 */

const { createSchool } = require('../backend/src/controllers/schoolController');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/schoolModel', () => ({
  create: jest.fn(),
}));

jest.mock('../backend/src/services/auditService', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../backend/src/services/stellarAccountVerificationService', () => ({
  verifyStellarAccountFunding: jest.fn().mockResolvedValue({ isFunded: true, warning: null }),
}));

const School = require('../backend/src/models/schoolModel');

// Valid Stellar public key for tests
const VALID_ADDRESS = 'GCICZOP346CKADPWOZ6JAQ7OCGH44UELNS3GSDXFOTSZRW6OYZZ6KSY7B';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(body = {}) {
  return {
    body: {
      name: 'Lincoln High School',
      slug: 'lincoln-high',
      stellarAddress: VALID_ADDRESS,
      network: 'testnet',
      ...body,
    },
    auditContext: null,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/schools — duplicate slug — issue #609', () => {
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  it('returns 201 when slug is unique', async () => {
    const schoolDoc = { schoolId: 'SCH-AAAA', name: 'Lincoln High School', slug: 'lincoln-high', toObject: () => ({}) };
    School.create.mockResolvedValue(schoolDoc);

    const req = mockReq();
    const res = mockRes();
    await createSchool(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next with 409 DUPLICATE_SCHOOL when slug already exists', async () => {
    const dupError = new Error('E11000 duplicate key error collection: test.schools index: slug_1 dup key: { slug: "lincoln-high" }');
    dupError.code = 11000;
    School.create.mockRejectedValue(dupError);

    const req = mockReq();
    const res = mockRes();
    await createSchool(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.code).toBe('DUPLICATE_SCHOOL');
    expect(err.status).toBe(409);
  });

  it('calls next with 409 DUPLICATE_SCHOOL when schoolId collides (non-slug 11000)', async () => {
    const dupError = new Error('E11000 duplicate key error collection: test.schools index: schoolId_1 dup key: { schoolId: "SCH-AAAA" }');
    dupError.code = 11000;
    School.create.mockRejectedValue(dupError);

    const req = mockReq({ slug: 'unique-slug-xyz' });
    const res = mockRes();
    await createSchool(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.code).toBe('DUPLICATE_SCHOOL');
    expect(err.status).toBe(409);
  });

  it('returns 400 VALIDATION_ERROR when slug contains special characters', async () => {
    const req = mockReq({ slug: 'Lincoln High!' });
    const res = mockRes();
    await createSchool(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when slug has spaces', async () => {
    const req = mockReq({ slug: 'lincoln high school' });
    const res = mockRes();
    await createSchool(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when slug has accented characters', async () => {
    const req = mockReq({ slug: 'école-primaire' });
    const res = mockRes();
    await createSchool(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('VALIDATION_ERROR');
  });
});
