'use strict';

/**
 * Tests that rejected payments increment payment_limit_triggered_total (#1117).
 *
 * The metric is the only signal telling operators the configured limits are
 * being hit; if it silently stops incrementing, the alerting built on it goes
 * quiet without anything failing.
 */

jest.mock('../src/services/paymentLimitsService', () => ({
  resolveLimits: jest.fn(),
  compareAgainstLimits: jest.requireActual('../src/services/paymentLimitsService').compareAgainstLimits,
}));
jest.mock('../src/config', () => ({ MIN_PAYMENT_AMOUNT: 0.01, MAX_PAYMENT_AMOUNT: 100000 }));

const { resolveLimits } = require('../src/services/paymentLimitsService');
const { validatePaymentAmount } = require('../src/utils/paymentLimits');
const { paymentLimitTriggeredTotal, registry } = require('../src/metrics');

async function counterValue(labels) {
  const metric = await registry.getSingleMetricAsString('payment_limit_triggered_total');
  const pattern = new RegExp(
    `payment_limit_triggered_total\\{school_id="${labels.school_id}",asset="${labels.asset}",code="${labels.code}"\\} (\\d+)`,
  );
  const match = metric.match(pattern);
  return match ? Number(match[1]) : 0;
}

beforeEach(() => {
  paymentLimitTriggeredTotal.reset();
  resolveLimits.mockResolvedValue({ min: 1, max: 100, source: 'system:default' });
});

describe('validatePaymentAmount metric', () => {
  test('does not increment for an accepted amount', async () => {
    const result = await validatePaymentAmount(50, { schoolId: 'SCH001', asset: 'XLM' });
    expect(result.valid).toBe(true);
    expect(await counterValue({ school_id: 'SCH001', asset: 'XLM', code: 'AMOUNT_TOO_HIGH' })).toBe(0);
  });

  test('increments with the rejection code for an over-limit amount', async () => {
    const result = await validatePaymentAmount(500, { schoolId: 'SCH001', asset: 'XLM' });
    expect(result.code).toBe('AMOUNT_TOO_HIGH');
    expect(await counterValue({ school_id: 'SCH001', asset: 'XLM', code: 'AMOUNT_TOO_HIGH' })).toBe(1);
  });

  test('distinguishes AMOUNT_TOO_LOW from AMOUNT_TOO_HIGH', async () => {
    await validatePaymentAmount(0.5, { schoolId: 'SCH001', asset: 'XLM' });
    expect(await counterValue({ school_id: 'SCH001', asset: 'XLM', code: 'AMOUNT_TOO_LOW' })).toBe(1);
    expect(await counterValue({ school_id: 'SCH001', asset: 'XLM', code: 'AMOUNT_TOO_HIGH' })).toBe(0);
  });

  test('labels rejections by school and asset so alerts can scope to one school', async () => {
    await validatePaymentAmount(500, { schoolId: 'SCH001', asset: 'XLM' });
    await validatePaymentAmount(500, { schoolId: 'SCH002', asset: 'USDC' });
    expect(await counterValue({ school_id: 'SCH001', asset: 'XLM', code: 'AMOUNT_TOO_HIGH' })).toBe(1);
    expect(await counterValue({ school_id: 'SCH002', asset: 'USDC', code: 'AMOUNT_TOO_HIGH' })).toBe(1);
  });

  test('falls back to placeholder labels when context is absent', async () => {
    await validatePaymentAmount(500);
    expect(await counterValue({ school_id: 'unknown', asset: 'XLM', code: 'AMOUNT_TOO_HIGH' })).toBe(1);
  });

  test('passes the school and asset through to limit resolution', async () => {
    await validatePaymentAmount(50, { schoolId: 'SCH001', asset: 'USDC' });
    expect(resolveLimits).toHaveBeenCalledWith({ schoolId: 'SCH001', asset: 'USDC' });
  });
});
