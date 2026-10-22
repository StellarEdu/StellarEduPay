'use strict';

/**
 * Tests for Issue #1813 — Self-serve school onboarding wizard.
 *
 * Contract under test (schoolOnboardingService):
 *  - Step 1: school details are validated (slug unique, timezone, currency, locale)
 *  - Step 2: wallet ownership is proven by a signed challenge before it is attached;
 *            the wallet readiness check reports trustline and memo requirements
 *  - Step 3: the first owner is invited through the existing invitation flow
 *  - Step 4-5: fee structures and academic period can be configured
 *  - Step 6: a test payment confirms end-to-end detection and receipt
 *  - Checklist reports completion per step and is complete only when every step passes
 *  - The server never receives or stores a secret key
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSchoolFindOne = jest.fn();
const mockSchoolCreate = jest.fn();
const mockVerifySignature = jest.fn();
const mockAccountInfo = jest.fn();
const mockSendInvite = jest.fn().mockResolvedValue({ sent: true });
const mockFeeStructureCount = jest.fn();
const mockPaymentDetected = jest.fn();

jest.mock('../src/models/schoolModel', () => ({
  findOne: (...args) => mockSchoolFindOne(...args),
  create: (...args) => mockSchoolCreate(...args),
}));
jest.mock('../src/services/stellarAccountVerificationService', () => ({
  getAccountInfo: (...args) => mockAccountInfo(...args),
}));
jest.mock('../src/services/stellarService', () => ({
  verifySignedChallenge: (...args) => mockVerifySignature(...args),
}), { virtual: true });
jest.mock('../src/services/invitationService', () => ({
  sendOwnerInvite: (...args) => mockSendInvite(...args),
}), { virtual: true });
jest.mock('../src/models/feeStructureModel', () => ({
  countDocuments: (...args) => mockFeeStructureCount(...args),
}));
jest.mock('../src/services/paymentService', () => ({
  hasDetectedPaymentForSchool: (...args) => mockPaymentDetected(...args),
}), { virtual: true });

const onboarding = require('../src/services/schoolOnboardingService');

const VALID_DETAILS = {
  name: 'Greenfield Academy',
  slug: 'greenfield-academy',
  timezone: 'Africa/Lagos',
  localCurrency: 'NGN',
  locale: 'en',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSchoolFindOne.mockResolvedValue(null);
  mockSchoolCreate.mockImplementation(async (doc) => ({ _id: 'school-new', ...doc }));
  mockAccountInfo.mockResolvedValue({
    exists: true,
    balances: [{ asset_code: 'USDC', asset_issuer: 'GISSUER' }],
    flags: { auth_required: false },
  });
});

// ── Step 1: school details ────────────────────────────────────────────────────

describe('step 1 — school details', () => {
  it('creates the school when details are valid', async () => {
    const result = await onboarding.submitSchoolDetails(VALID_DETAILS);

    expect(mockSchoolCreate).toHaveBeenCalledWith(expect.objectContaining({ slug: 'greenfield-academy' }));
    expect(result.schoolId).toBe('school-new');
  });

  it('rejects a slug that is already taken', async () => {
    mockSchoolFindOne.mockResolvedValue({ _id: 'existing' });

    await expect(onboarding.submitSchoolDetails(VALID_DETAILS))
      .rejects.toMatchObject({ code: 'SLUG_TAKEN' });
    expect(mockSchoolCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown IANA timezone', async () => {
    await expect(onboarding.submitSchoolDetails({ ...VALID_DETAILS, timezone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ code: 'INVALID_TIMEZONE' });
  });
});

// ── Step 2: wallet ────────────────────────────────────────────────────────────

describe('step 2 — wallet ownership and readiness', () => {
  const ADDRESS = 'GCJRI5CIWK5IM6KXDU5XLNS2OIF4X5R5ZD5PKGM5VQ3UVCFKHUDHVEJZ';

  it('attaches the wallet only when the signed challenge verifies', async () => {
    mockVerifySignature.mockResolvedValue(true);

    await onboarding.connectWallet({
      schoolId: 'school-new',
      address: ADDRESS,
      challengeId: 'chal-1',
      signature: 'sig-base64',
    });

    expect(mockVerifySignature).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, challengeId: 'chal-1', signature: 'sig-base64' }),
    );
    expect(mockSchoolCreate).not.toHaveBeenCalled();
  });

  it('refuses to attach an address whose signature does not verify', async () => {
    mockVerifySignature.mockResolvedValue(false);

    await expect(onboarding.connectWallet({
      schoolId: 'school-new',
      address: ADDRESS,
      challengeId: 'chal-1',
      signature: 'forged',
    })).rejects.toMatchObject({ code: 'WALLET_OWNERSHIP_FAILED' });
  });

  it('reports whether the wallet has a USDC trustline', async () => {
    mockVerifySignature.mockResolvedValue(true);
    mockAccountInfo.mockResolvedValue({ exists: true, balances: [{ asset_code: 'XLM' }], flags: {} });

    const readiness = await onboarding.checkWalletReadiness(ADDRESS);

    expect(readiness.usdcTrustline).toBe(false);
    expect(readiness.ready).toBe(false);
  });

  it('reports memo_required when the account enforces memos', async () => {
    mockAccountInfo.mockResolvedValue({
      exists: true,
      balances: [{ asset_code: 'USDC' }],
      data: { config_memo_required: 'MQ==' },
    });

    const readiness = await onboarding.checkWalletReadiness(ADDRESS);

    expect(readiness.memoRequired).toBe(true);
  });
});

// ── Step 3: owner invite ──────────────────────────────────────────────────────

describe('step 3 — first owner invite', () => {
  it('sends an invite through the existing invitation flow', async () => {
    await onboarding.inviteOwner({ schoolId: 'school-new', email: 'owner@greenfield.test' });

    expect(mockSendInvite).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'school-new', email: 'owner@greenfield.test', role: 'owner' }),
    );
  });
});

// ── Steps 4–6: fees, students and test payment ────────────────────────────────

describe('steps 4–6 — configuration and verification', () => {
  it('step 4 is complete only when at least one fee structure exists', async () => {
    mockFeeStructureCount.mockResolvedValue(0);
    expect((await onboarding.getChecklist('school-new')).steps.fees.complete).toBe(false);

    mockFeeStructureCount.mockResolvedValue(2);
    expect((await onboarding.getChecklist('school-new')).steps.fees.complete).toBe(true);
  });

  it('step 6 is complete only after a test payment is detected for the school', async () => {
    mockPaymentDetected.mockResolvedValue(false);
    expect((await onboarding.getChecklist('school-new')).steps.testPayment.complete).toBe(false);

    mockPaymentDetected.mockResolvedValue(true);
    expect((await onboarding.getChecklist('school-new')).steps.testPayment.complete).toBe(true);
  });

  it('checklist is complete only when every step is complete', async () => {
    mockFeeStructureCount.mockResolvedValue(1);
    mockPaymentDetected.mockResolvedValue(true);

    const checklist = await onboarding.getChecklist('school-new');

    expect(checklist.complete).toBe(
      Object.values(checklist.steps).every((s) => s.complete),
    );
  });
});

// ── Secret handling ───────────────────────────────────────────────────────────

describe('server never receives a secret key', () => {
  it('rejects a request body that contains an S-address secret', async () => {
    await expect(onboarding.connectWallet({
      schoolId: 'school-new',
      address: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      challengeId: 'chal-1',
      signature: 'sig',
    })).rejects.toMatchObject({ code: 'SECRET_KEY_REJECTED' });
  });
});
