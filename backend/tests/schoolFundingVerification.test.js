'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password';

/**
 * Integration tests for school creation and update with Stellar account funding verification.
 * Tests POST /api/schools and PATCH /api/schools/:slug with funded, unfunded, and network error scenarios.
 */

// Mock Stellar SDK before importing controllers
jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
  },
}));

// Mock config before importing controllers
jest.mock('../src/config/index', () => ({
  MONGO_URI: 'mongodb://localhost/test',
  PORT: 5000,
  STELLAR_NETWORK: 'testnet',
  IS_TESTNET: true,
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_TIMEOUT_MS: 3000,
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {},
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  ALL_ASSETS: {},
  configuredAsset: {},
}));

const { createSchool, updateSchool } = require('../src/controllers/schoolController');

// Mock dependencies
jest.mock('../src/models/schoolModel');
jest.mock('../src/services/auditService');
jest.mock('../src/services/stellarAccountVerificationService');
// Address changes now read the new wallet's cursor from Horizon (#1799); this
// suite is about funding warnings, so the cursor lookup is stubbed out.
jest.mock('../src/services/walletRotationService', () => ({
  buildWalletRotation: jest.fn(async (school) => ({
    retired: { address: school.stellarAddress },
    syncCursor: null,
    walletActiveFrom: new Date(),
  })),
}));

const School = require('../src/models/schoolModel');
const { logAudit } = require('../src/services/auditService');
const { verifyStellarAccountFunding } = require('../src/services/stellarAccountVerificationService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(body = {}, params = {}) {
  return {
    body: { confirmPassword: process.env.ADMIN_PASSWORD, ...body },
    params,
    headers: {},
    auditContext: {
      performedBy: 'admin@test.com',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    },
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('School Funding Verification', () => {
  const validAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJVP2FPYY3D3BTYWP2XMWRIN';
  const unfundedAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  beforeEach(() => {
    jest.clearAllMocks();
    logAudit.mockResolvedValue(undefined);
  });

  describe('POST /api/schools', () => {
    it('should return 201 for a funded Stellar address', async () => {
      const req = mockReq({
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
      });
      const res = mockRes();
      const next = jest.fn();

      const mockSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: validAddress,
          network: 'testnet',
        }),
      };

      School.create.mockResolvedValue(mockSchool);
      verifyStellarAccountFunding.mockResolvedValue({ isFunded: true, warning: null });

      await createSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(mockSchool);
      expect(verifyStellarAccountFunding).toHaveBeenCalledWith(validAddress);
    });

    it('should return 202 with warning for an unfunded Stellar address', async () => {
      const req = mockReq({
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: unfundedAddress,
        network: 'testnet',
      });
      const res = mockRes();
      const next = jest.fn();

      const mockSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: unfundedAddress,
        network: 'testnet',
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: unfundedAddress,
          network: 'testnet',
        }),
      };

      School.create.mockResolvedValue(mockSchool);
      verifyStellarAccountFunding.mockResolvedValue({
        isFunded: false,
        warning: 'STELLAR_ACCOUNT_UNFUNDED',
      });

      await createSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: unfundedAddress,
        network: 'testnet',
        warning: 'STELLAR_ACCOUNT_UNFUNDED',
      });
    });

    it('should return 201 when Horizon check fails (timeout/network error)', async () => {
      const req = mockReq({
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
      });
      const res = mockRes();
      const next = jest.fn();

      const mockSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: validAddress,
          network: 'testnet',
        }),
      };

      School.create.mockResolvedValue(mockSchool);
      verifyStellarAccountFunding.mockResolvedValue({ isFunded: null, warning: null });

      await createSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(mockSchool);
    });

    it('should create school even if Horizon check fails', async () => {
      const req = mockReq({
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
      });
      const res = mockRes();
      const next = jest.fn();

      const mockSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        network: 'testnet',
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: validAddress,
          network: 'testnet',
        }),
      };

      School.create.mockResolvedValue(mockSchool);
      verifyStellarAccountFunding.mockResolvedValue({ isFunded: null, warning: null });

      await createSchool(req, res, next);

      expect(School.create).toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/schools/:slug', () => {
    it('should return 200 when updating to a funded address', async () => {
      const req = mockReq(
        { stellarAddress: validAddress },
        { schoolSlug: 'test-school' }
      );
      const res = mockRes();
      const next = jest.fn();

      const originalSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJVP2FPYY3D3BTYWP2XMWRIN',
      };

      const updatedSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: validAddress,
        }),
      };

      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(originalSchool),
      });
      School.findOneAndUpdate.mockResolvedValue(updatedSchool);
      verifyStellarAccountFunding.mockResolvedValue({ isFunded: true, warning: null });

      await updateSchool(req, res, next);

      expect(res.status).not.toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(updatedSchool);
      expect(verifyStellarAccountFunding).toHaveBeenCalledWith(validAddress);
    });

    it('should return 202 with warning when updating to an unfunded address', async () => {
      const req = mockReq(
        { stellarAddress: unfundedAddress },
        { schoolSlug: 'test-school' }
      );
      const res = mockRes();
      const next = jest.fn();

      const originalSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
      };

      const updatedSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: unfundedAddress,
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: unfundedAddress,
        }),
      };

      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(originalSchool),
      });
      School.findOneAndUpdate.mockResolvedValue(updatedSchool);
      verifyStellarAccountFunding.mockResolvedValue({
        isFunded: false,
        warning: 'STELLAR_ACCOUNT_UNFUNDED',
      });

      await updateSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: unfundedAddress,
        warning: 'STELLAR_ACCOUNT_UNFUNDED',
      });
    });

    it('should return 200 when Horizon check fails on update', async () => {
      const req = mockReq(
        { stellarAddress: validAddress },
        { schoolSlug: 'test-school' }
      );
      const res = mockRes();
      const next = jest.fn();

      const originalSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJVP2FPYY3D3BTYWP2XMWRIN',
      };

      const updatedSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Test School',
          slug: 'test-school',
          stellarAddress: validAddress,
        }),
      };

      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(originalSchool),
      });
      School.findOneAndUpdate.mockResolvedValue(updatedSchool);
      verifyStellarAccountFunding.mockResolvedValue({ isFunded: null, warning: null });

      await updateSchool(req, res, next);

      expect(res.status).not.toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(updatedSchool);
    });

    it('should not verify funding when updating non-address fields', async () => {
      const req = mockReq(
        { name: 'Updated School Name' },
        { schoolSlug: 'test-school' }
      );
      const res = mockRes();
      const next = jest.fn();

      const originalSchool = {
        schoolId: 'SCH-1234',
        name: 'Test School',
        slug: 'test-school',
        stellarAddress: validAddress,
      };

      const updatedSchool = {
        schoolId: 'SCH-1234',
        name: 'Updated School Name',
        slug: 'test-school',
        stellarAddress: validAddress,
        toObject: jest.fn().mockReturnValue({
          schoolId: 'SCH-1234',
          name: 'Updated School Name',
          slug: 'test-school',
          stellarAddress: validAddress,
        }),
      };

      School.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(originalSchool),
      });
      School.findOneAndUpdate.mockResolvedValue(updatedSchool);

      await updateSchool(req, res, next);

      expect(verifyStellarAccountFunding).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(updatedSchool);
    });
  });
});
