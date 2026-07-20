'use strict';

/**
 * Tests for paymentLimitsService (#1117) — DB-backed, admin-configurable,
 * per-asset payment limits.
 *
 * School and SystemConfig are mocked so these stay unit tests; the resolution
 * order and the fallback-to-env behaviour are the parts worth pinning, since a
 * regression there either loosens a fraud control silently or breaks payments
 * for every deployment that never touches the admin API.
 */

jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/systemConfigModel', () => ({ get: jest.fn(), set: jest.fn() }));
jest.mock('../src/config', () => ({ MIN_PAYMENT_AMOUNT: 0.01, MAX_PAYMENT_AMOUNT: 100000 }));

const School = require('../src/models/schoolModel');
const SystemConfig = require('../src/models/systemConfigModel');
const svc = require('../src/services/paymentLimitsService');

const lean = (value) => ({ lean: () => Promise.resolve(value) });

beforeEach(() => {
  jest.clearAllMocks();
  svc.invalidateCache();
  School.findOne.mockReturnValue(lean(null));
  SystemConfig.get.mockResolvedValue(null);
});

describe('resolveLimits — resolution order', () => {
  test('falls back to env limits when nothing is stored', async () => {
    const limits = await svc.resolveLimits({ schoolId: 'SCH001' });
    expect(limits).toEqual({ min: 0.01, max: 100000, source: 'env' });
  });

  test('global default overrides env', async () => {
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    const limits = await svc.resolveLimits({ schoolId: 'SCH001' });
    expect(limits).toMatchObject({ min: 1, max: 500, source: 'system:default' });
  });

  test('global per-asset overrides global default', async () => {
    SystemConfig.get.mockResolvedValue({
      default: { min: 1, max: 500 },
      assets: { USDC: { min: 5, max: 20000 } },
    });
    expect(await svc.resolveLimits({ asset: 'USDC' })).toMatchObject({
      min: 5, max: 20000, source: 'system:asset:USDC',
    });
    // An asset with no specific entry still gets the default.
    svc.invalidateCache();
    expect(await svc.resolveLimits({ asset: 'XLM' })).toMatchObject({
      min: 1, max: 500, source: 'system:default',
    });
  });

  test('school default overrides global', async () => {
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    School.findOne.mockReturnValue(lean({ settings: { paymentLimits: { default: { min: 2, max: 50 } } } }));
    expect(await svc.resolveLimits({ schoolId: 'SCH001' })).toMatchObject({
      min: 2, max: 50, source: 'school:default',
    });
  });

  test('school per-asset is the most specific layer', async () => {
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    School.findOne.mockReturnValue(lean({
      settings: { paymentLimits: { default: { min: 2, max: 50 }, assets: { XLM: { min: 3, max: 30 } } } },
    }));
    expect(await svc.resolveLimits({ schoolId: 'SCH001', asset: 'XLM' })).toMatchObject({
      min: 3, max: 30, source: 'school:asset:XLM',
    });
  });

  test('asset codes resolve case-insensitively', async () => {
    SystemConfig.get.mockResolvedValue({ assets: { USDC: { min: 5, max: 100 } } });
    expect(await svc.resolveLimits({ asset: 'usdc' })).toMatchObject({ min: 5, max: 100 });
  });

  test('ignores a stored pair that fails validation rather than trusting it', async () => {
    // max <= min would invert the control; the env values are the safe answer.
    SystemConfig.get.mockResolvedValue({ default: { min: 100, max: 1 } });
    expect(await svc.resolveLimits({})).toEqual({ min: 0.01, max: 100000, source: 'env' });
  });

  test('falls back to env when the database read hangs', async () => {
    // Mongoose buffers commands while disconnected rather than rejecting, so a
    // read can hang indefinitely. Resolution sits in the payment verification
    // path — without a bound, a database blip stalls verification instead of
    // degrading to the env limits.
    process.env.PAYMENT_LIMITS_READ_TIMEOUT_MS = '50';
    jest.resetModules();
    const scoped = require('../src/services/paymentLimitsService');
    SystemConfig.get.mockImplementation(() => new Promise(() => {})); // never settles

    const started = Date.now();
    const limits = await scoped.resolveLimits({});
    expect(limits).toEqual({ min: 0.01, max: 100000, source: 'env' });
    expect(Date.now() - started).toBeLessThan(2000);

    delete process.env.PAYMENT_LIMITS_READ_TIMEOUT_MS;
    jest.resetModules();
  });

  test('falls back to env when the database read throws', async () => {
    // Losing the ability to read a tightened limit must not mean accepting an
    // unbounded payment.
    SystemConfig.get.mockRejectedValue(new Error('mongo down'));
    expect(await svc.resolveLimits({ schoolId: 'SCH001' })).toEqual({
      min: 0.01, max: 100000, source: 'env',
    });
  });
});

describe('resolveLimits — caching', () => {
  test('does not re-read the database within the TTL', async () => {
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    await svc.resolveLimits({ schoolId: 'SCH001' });
    await svc.resolveLimits({ schoolId: 'SCH001' });
    expect(SystemConfig.get).toHaveBeenCalledTimes(1);
  });

  test('a write invalidates the cache so the writer never serves a stale value', async () => {
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    await svc.resolveLimits({ schoolId: 'SCH001' });

    SystemConfig.set.mockResolvedValue({});
    SystemConfig.get.mockResolvedValue({ default: { min: 9, max: 90 } });
    await svc.setSystemLimits({ default: { min: 9, max: 90 } });

    expect(await svc.resolveLimits({ schoolId: 'SCH001' })).toMatchObject({ min: 9, max: 90 });
  });

  test('a school write does not invalidate another school', async () => {
    School.findOne.mockReturnValue(lean(null));
    SystemConfig.get.mockResolvedValue({ default: { min: 1, max: 500 } });
    await svc.resolveLimits({ schoolId: 'SCH001' });
    await svc.resolveLimits({ schoolId: 'SCH002' });
    expect(SystemConfig.get).toHaveBeenCalledTimes(2);

    School.findOneAndUpdate.mockReturnValue(lean({ schoolId: 'SCH002' }));
    await svc.setSchoolLimits('SCH002', { default: { min: 2, max: 20 } });

    await svc.resolveLimits({ schoolId: 'SCH001' }); // still cached
    expect(SystemConfig.get).toHaveBeenCalledTimes(2);
  });
});

describe('validateLimitsDocument', () => {
  test.each([
    ['max below min', { default: { min: 10, max: 1 } }],
    ['negative min', { default: { min: -1, max: 10 } }],
    ['non-numeric', { default: { min: 'a', max: 10 } }],
    ['infinite', { default: { min: 0, max: Infinity } }],
    ['empty document', {}],
    ['assets as array', { assets: [] }],
    ['bad asset pair', { assets: { XLM: { min: 5, max: 5 } } }],
  ])('rejects %s', (_label, doc) => {
    expect(svc.validateLimitsDocument(doc).valid).toBe(false);
  });

  test.each([
    ['default only', { default: { min: 0.01, max: 100 } }],
    ['assets only', { assets: { XLM: { min: 1, max: 10 } } }],
    ['both', { default: { min: 1, max: 100 }, assets: { USDC: { min: 5, max: 50 } } }],
  ])('accepts %s', (_label, doc) => {
    expect(svc.validateLimitsDocument(doc).valid).toBe(true);
  });
});

describe('write paths', () => {
  test('setSystemLimits rejects an invalid document before storing', async () => {
    await expect(svc.setSystemLimits({ default: { min: 10, max: 1 } })).rejects.toThrow();
    expect(SystemConfig.set).not.toHaveBeenCalled();
  });

  test('setSchoolLimits raises NOT_FOUND for an unknown school', async () => {
    School.findOneAndUpdate.mockReturnValue(lean(null));
    await expect(svc.setSchoolLimits('NOPE', { default: { min: 1, max: 2 } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('clearSchoolLimits unsets the override', async () => {
    School.findOneAndUpdate.mockReturnValue(lean({ schoolId: 'SCH001' }));
    await svc.clearSchoolLimits('SCH001');
    expect(School.findOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: 'SCH001' },
      { $unset: { 'settings.paymentLimits': '' } },
      { new: true },
    );
  });
});

describe('compareAgainstLimits', () => {
  const limits = { min: 1, max: 100 };

  test('accepts an in-range amount and the exact boundaries', () => {
    expect(svc.compareAgainstLimits(50, limits).valid).toBe(true);
    expect(svc.compareAgainstLimits(1, limits).valid).toBe(true);
    expect(svc.compareAgainstLimits(100, limits).valid).toBe(true);
  });

  test('reports the specific reason for out-of-range amounts', () => {
    expect(svc.compareAgainstLimits(0.5, limits)).toMatchObject({ code: 'AMOUNT_TOO_LOW' });
    expect(svc.compareAgainstLimits(101, limits)).toMatchObject({ code: 'AMOUNT_TOO_HIGH' });
  });

  test('rejects non-numeric and non-positive amounts', () => {
    expect(svc.compareAgainstLimits(NaN, limits)).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(svc.compareAgainstLimits(0, limits)).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(svc.compareAgainstLimits(-5, limits)).toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  test('compares in Decimal space, not float space', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754; a float comparison against
    // a max of 0.3 would wrongly reject it.
    expect(svc.compareAgainstLimits(0.1 + 0.2, { min: 0.01, max: 0.3 }))
      .toMatchObject({ code: 'AMOUNT_TOO_HIGH' });
    expect(svc.compareAgainstLimits(0.3, { min: 0.01, max: 0.3 }).valid).toBe(true);
  });
});
