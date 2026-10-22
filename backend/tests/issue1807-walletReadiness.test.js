'use strict';

/**
 * Tests for issue #1807 — school wallet readiness: USDC trustline, reserve
 * headroom, signer/threshold review and the SEP-29 memo-required flag.
 */

const { evaluateWalletReadiness, WARNING_CODES } = require('../src/services/walletReadinessService');

const ISSUER = 'GISSUERUSDCADDRESS';
const SCHOOL = 'GSCHOOLACCOUNT';
const b64 = (text) => Buffer.from(text).toString('base64');

function healthyAccount(overrides = {}) {
  return {
    account_id: SCHOOL,
    balances: [
      { asset_type: 'native', balance: '50.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '0.0000000', limit: '1000000.0000000', is_authorized: true },
    ],
    subentry_count: 1,
    signers: [{ key: SCHOOL, weight: 1, type: 'ed25519_public_key' }],
    thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
    data_attr: { 'config.memo_required': b64('1') },
    home_domain: 'school.example',
    ...overrides,
  };
}

function codes(report) {
  return report.warnings.map((w) => w.code);
}

describe('issue #1807 — school wallet readiness', () => {
  test('a healthy account produces no warnings', () => {
    const report = evaluateWalletReadiness(healthyAccount(), { acceptedAssets: ['XLM', 'USDC'], usdcIssuer: ISSUER });
    expect(report.warnings).toEqual([]);
    expect(report.exists).toBe(true);
    expect(report.memoRequired).toBe(true);
    expect(report.homeDomain).toBe('school.example');
    expect(report.trustlines.USDC).toEqual({ present: true, limit: '1000000.0000000', authorized: true });
  });

  test('reports a missing account as ACCOUNT_NOT_FOUND', () => {
    const report = evaluateWalletReadiness(null, { acceptedAssets: ['XLM'] });
    expect(report.exists).toBe(false);
    expect(codes(report)).toEqual([WARNING_CODES.ACCOUNT_NOT_FOUND]);
  });

  test('warns when USDC is accepted but no trustline to the pinned issuer exists', () => {
    const account = healthyAccount({
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
    });
    const report = evaluateWalletReadiness(account, { acceptedAssets: ['USDC'], usdcIssuer: ISSUER });
    expect(report.trustlines.USDC.present).toBe(false);
    expect(codes(report)).toContain(WARNING_CODES.USDC_TRUSTLINE_MISSING);
  });

  test('does not check USDC when the school does not accept it', () => {
    const account = healthyAccount({ balances: [{ asset_type: 'native', balance: '50.0000000' }] });
    const report = evaluateWalletReadiness(account, { acceptedAssets: ['XLM'], usdcIssuer: ISSUER });
    expect(codes(report)).not.toContain(WARNING_CODES.USDC_TRUSTLINE_MISSING);
    expect(report.trustlines).toEqual({});
  });

  test('a trustline from a different issuer does not count as USDC', () => {
    const account = healthyAccount({
      balances: [
        { asset_type: 'native', balance: '50.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GFAKEISSUER', balance: '0', limit: '100', is_authorized: true },
      ],
    });
    const report = evaluateWalletReadiness(account, { acceptedAssets: ['USDC'], usdcIssuer: ISSUER });
    expect(codes(report)).toContain(WARNING_CODES.USDC_TRUSTLINE_MISSING);
  });

  test('warns when the USDC trustline is not authorized', () => {
    const account = healthyAccount({
      balances: [
        { asset_type: 'native', balance: '50.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '0', limit: '100', is_authorized: false },
      ],
    });
    const report = evaluateWalletReadiness(account, { acceptedAssets: ['USDC'], usdcIssuer: ISSUER });
    expect(codes(report)).toContain(WARNING_CODES.USDC_NOT_AUTHORIZED);
  });

  test('warns when the USDC limit is below the required minimum', () => {
    const report = evaluateWalletReadiness(healthyAccount(), {
      acceptedAssets: ['USDC'],
      usdcIssuer: ISSUER,
      minUsdcLimit: '5000000',
    });
    expect(codes(report)).toContain(WARNING_CODES.USDC_LIMIT_TOO_LOW);
  });

  test('warns when reserve headroom cannot fund a new trustline', () => {
    // Base reserve for 2 + 1 subentries is 1.5 XLM; 1.8 XLM leaves 0.3 headroom.
    const account = healthyAccount({ balances: [{ asset_type: 'native', balance: '1.8000000' }] });
    const report = evaluateWalletReadiness(account, { acceptedAssets: [] });
    expect(report.reserveHeadroomXLM).toBe('0.3000000');
    expect(codes(report)).toContain(WARNING_CODES.LOW_RESERVE_HEADROOM);
  });

  test('warns when med_threshold allows a single key to move funds', () => {
    const account = healthyAccount({ thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 } });
    const report = evaluateWalletReadiness(account, { acceptedAssets: [] });
    expect(codes(report)).toContain(WARNING_CODES.THRESHOLD_TOO_LOW);
  });

  test('warns about signers that are not approved by the school', () => {
    const account = healthyAccount({
      signers: [
        { key: SCHOOL, weight: 1, type: 'ed25519_public_key' },
        { key: 'GNEWSIGNER', weight: 1, type: 'ed25519_public_key' },
      ],
    });
    const report = evaluateWalletReadiness(account, { acceptedAssets: [] });
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: WARNING_CODES.UNKNOWN_SIGNER, message: expect.stringContaining('GNEWSIGNER') }),
    ]);
  });

  test('does not warn about a signer the school has approved', () => {
    const account = healthyAccount({
      signers: [
        { key: SCHOOL, weight: 1, type: 'ed25519_public_key' },
        { key: 'GBURSAR', weight: 1, type: 'ed25519_public_key' },
      ],
    });
    const report = evaluateWalletReadiness(account, { acceptedAssets: [], knownSigners: ['GBURSAR'] });
    expect(codes(report)).not.toContain(WARNING_CODES.UNKNOWN_SIGNER);
  });

  test('warns when config.memo_required is not set', () => {
    const account = healthyAccount({ data_attr: {} });
    const report = evaluateWalletReadiness(account, { acceptedAssets: [] });
    expect(report.memoRequired).toBe(false);
    expect(codes(report)).toContain(WARNING_CODES.MEMO_NOT_REQUIRED);
  });

  test('treats a memo_required value other than "1" as not set', () => {
    const account = healthyAccount({ data_attr: { 'config.memo_required': b64('0') } });
    expect(evaluateWalletReadiness(account, { acceptedAssets: [] }).memoRequired).toBe(false);
  });
});
