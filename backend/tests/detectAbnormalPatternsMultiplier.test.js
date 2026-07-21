'use strict';

/**
 * Unit tests for detectAbnormalPatterns with configurable multiplier.
 * Tests that the function correctly uses the school's suspiciousPaymentMultiplier.
 */

// Mock config before importing services
jest.mock('../src/config/index', () => ({
  MONGO_URI: 'mongodb://localhost/test',
  PORT: 5000,
  STELLAR_NETWORK: 'testnet',
  IS_TESTNET: true,
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_TIMEOUT_MS: 3000,
  MIN_PAYMENT_AMOUNT: 0.01,
  MAX_PAYMENT_AMOUNT: 100000,
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {},
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  ALL_ASSETS: {},
  configuredAsset: {},
}));

const { detectAbnormalPatterns } = require('../src/services/stellarService');

jest.mock('../src/models/paymentModel');
const Payment = require('../src/models/paymentModel');

describe('detectAbnormalPatterns with configurable multiplier', () => {
  const senderAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJVP2FPYY3D3BTYWP2XMWRIN';
  const schoolId = 'SCH-1234';
  const txDate = new Date();

  beforeEach(() => {
    jest.clearAllMocks();
    Payment.countDocuments.mockResolvedValue(0);
  });

  describe('Unusual amount detection with default multiplier (3.0)', () => {
    it('should flag payment 3× expected fee as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 300;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
      expect(result.reason).toContain('3.00');
    });

    it('should flag payment 1/3 expected fee as suspicious', async () => {
      const expectedFee = 300;
      const paymentAmount = 100;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
      expect(result.reason).toContain('0.33');
    });

    it('should not flag payment just under 3× as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 299;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('should not flag payment just over 1/3 as suspicious', async () => {
      const expectedFee = 300;
      const paymentAmount = 101;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe('Unusual amount detection with strict multiplier (1.5)', () => {
    it('should flag payment 1.5× expected fee as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 150;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        1.5
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
      expect(result.reason).toContain('1.50');
    });

    it('should flag payment 1/1.5 expected fee as suspicious', async () => {
      const expectedFee = 150;
      const paymentAmount = 100;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        1.5
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
      expect(result.reason).toContain('0.67');
    });

    it('should not flag payment 1.49× as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 149;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        1.5
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe('Unusual amount detection with lenient multiplier (5.0)', () => {
    it('should not flag payment 3× expected fee as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 300;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        5.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('should flag payment 5× expected fee as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 500;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        5.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
      expect(result.reason).toContain('5.00');
    });

    it('should not flag payment 1/5 expected fee as suspicious', async () => {
      const expectedFee = 500;
      const paymentAmount = 100;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        5.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe('Boundary multiplier (1.1)', () => {
    it('should flag payment 1.1× expected fee as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 110;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        1.1
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
    });

    it('should not flag payment 1.09× as suspicious', async () => {
      const expectedFee = 100;
      const paymentAmount = 109;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        1.1
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe('Multiplier in reason message', () => {
    it('should include multiplier threshold in reason', async () => {
      const expectedFee = 100;
      const paymentAmount = 400;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.5
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('threshold 3.5×');
    });
  });

  describe('Rapid transaction detection (independent of multiplier)', () => {
    it('should flag rapid transactions regardless of multiplier', async () => {
      const expectedFee = 100;
      const paymentAmount = 100; // Normal amount

      Payment.countDocuments.mockResolvedValue(3); // 3 recent transactions

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('transactions within 10 minutes');
    });

    it('should combine rapid transaction and unusual amount reasons', async () => {
      const expectedFee = 100;
      const paymentAmount = 400; // 4× fee

      Payment.countDocuments.mockResolvedValue(3); // 3 recent transactions

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('transactions within 10 minutes');
      expect(result.reason).toContain('Unusual payment amount');
    });
  });

  describe('Edge cases', () => {
    it('should handle zero expected fee gracefully', async () => {
      const expectedFee = 0;
      const paymentAmount = 100;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('should handle null expected fee gracefully', async () => {
      const expectedFee = null;
      const paymentAmount = 100;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('should handle null sender address gracefully', async () => {
      const expectedFee = 100;
      const paymentAmount = 300;

      const result = await detectAbnormalPatterns(
        null,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId,
        3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
    });

    it('should use default multiplier when not provided', async () => {
      const expectedFee = 100;
      const paymentAmount = 300;

      const result = await detectAbnormalPatterns(
        senderAddress,
        paymentAmount,
        expectedFee,
        txDate,
        schoolId
        // No multiplier provided, should default to 3.0
      );

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Unusual payment amount');
    });
  });
});
