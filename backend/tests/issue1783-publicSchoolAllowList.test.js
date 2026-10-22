'use strict';

/**
 * Tests for Issue #1783 — GET /api/schools/:schoolId must use an allow-list
 * projection so anonymous callers never see admin emails, webhook config,
 * fraud-detection thresholds, MFA state, sync cursor or settings.
 */

let mockFindOne;

jest.mock('../src/models/schoolModel', () => ({
  findOne: (...args) => mockFindOne(...args),
}));

jest.mock('@stellar/stellar-sdk', () => ({}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/services/stellarAccountVerificationService', () => ({
  verifyStellarAccountFunding: jest.fn(),
}));
jest.mock('../src/utils/validateWebhookUrl', () => ({ validateWebhookUrl: jest.fn() }));
jest.mock('../src/services/schoolCacheInvalidator', () => ({}));
jest.mock('../src/services/currencyConversionService', () => ({
  isSupportedCurrency: jest.fn(),
}));

const { getSchool } = require('../src/controllers/schoolController');

const SENSITIVE_FIELDS = [
  'adminEmail',
  'contactEmail',
  'webhookUrl',
  'webhookSecret',
  'webhookPayloadConfig',
  'suspiciousPaymentMultiplier',
  'suspiciousAmountConfig',
  'maxPaymentMultiplier',
  'maxStudents',
  'syncCursor',
  'previousStellarAddress',
  'requireMfa',
  'mfaEnabled',
  'mfaSecret',
  'mfaBackupCodes',
  'jwtSecret',
  'internalNotes',
  'settings',
];

function makeRes() {
  return { json: jest.fn() };
}

async function callGetSchool(doc) {
  const lean = jest.fn().mockResolvedValue(doc);
  mockFindOne = jest.fn(() => ({ lean }));
  const res = makeRes();
  const next = jest.fn();
  await getSchool({ params: { schoolId: 'SCH-1' } }, res, next);
  const projection = mockFindOne.mock.calls[0][1];
  return { projection, res, next };
}

describe('Issue #1783 — getSchool public projection', () => {
  test('projection is an allow-list (every included field is set to 1)', async () => {
    const { projection } = await callGetSchool({ schoolId: 'SCH-1' });

    const values = Object.values(projection);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === 1)).toBe(true);
  });

  test('projection does not expose any sensitive field', async () => {
    const { projection } = await callGetSchool({ schoolId: 'SCH-1' });

    for (const field of SENSITIVE_FIELDS) {
      expect(projection).not.toHaveProperty(field);
    }
  });

  test('projection includes the fields the public pay page needs', async () => {
    const { projection } = await callGetSchool({ schoolId: 'SCH-1' });

    for (const field of ['schoolId', 'name', 'stellarAddress', 'localCurrency', 'logoUrl', 'primaryColor']) {
      expect(projection).toHaveProperty(field, 1);
    }
  });

  test('unknown school forwards a NOT_FOUND error', async () => {
    const { next, res } = await callGetSchool(null);

    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
