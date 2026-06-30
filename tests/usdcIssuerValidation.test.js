'use strict';

/**
 * #841 — USDC asset issuer / trustline validation.
 *
 * The asset code "USDC" is just a label any account can mint. Crediting it
 * without pinning the issuer would let an attacker "pay" fees with a worthless
 * look-alike token. These tests load the REAL stellarConfig (with USDC as the
 * accepted asset) and assert isAcceptedAsset only accepts USDC from the pinned
 * canonical issuer for the active network, rejects every other issuer, and that
 * the pinned issuer differs correctly between testnet and mainnet.
 */

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ATTACKER_ISSUER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

function loadConfig({ network, acceptedAsset = 'USDC', usdcIssuer } = {}) {
  jest.resetModules();
  process.env.MONGO_URI = 'mongodb://localhost:27017/test';
  process.env.JWT_SECRET = 'test-jwt-secret-for-usdc-issuer-suite-1234567890';
  process.env.STELLAR_NETWORK = network || 'testnet';
  process.env.ACCEPTED_ASSET = acceptedAsset;
  if (usdcIssuer === undefined) delete process.env.USDC_ISSUER;
  else process.env.USDC_ISSUER = usdcIssuer;
  return require('../backend/src/config/stellarConfig');
}

afterEach(() => {
  jest.resetModules();
  delete process.env.STELLAR_NETWORK;
  delete process.env.ACCEPTED_ASSET;
  delete process.env.USDC_ISSUER;
});

describe('isAcceptedAsset — USDC issuer pinning (#841)', () => {
  test('accepts USDC ONLY from the pinned testnet issuer', () => {
    const { isAcceptedAsset } = loadConfig({ network: 'testnet' });

    const ok = isAcceptedAsset('USDC', 'credit_alphanum4', TESTNET_USDC);
    expect(ok.accepted).toBe(true);
  });

  test('rejects a USDC-coded asset from a non-canonical issuer (fraud vector)', () => {
    const { isAcceptedAsset } = loadConfig({ network: 'testnet' });

    const attacker = isAcceptedAsset('USDC', 'credit_alphanum4', ATTACKER_ISSUER);
    expect(attacker.accepted).toBe(false);
    expect(attacker.reason).toBe('issuer_mismatch');

    // Even the mainnet issuer is wrong on testnet.
    expect(isAcceptedAsset('USDC', 'credit_alphanum4', MAINNET_USDC).accepted).toBe(false);
  });

  test('rejects USDC with a missing/empty issuer', () => {
    const { isAcceptedAsset } = loadConfig({ network: 'testnet' });
    expect(isAcceptedAsset('USDC', 'credit_alphanum4', null).accepted).toBe(false);
    expect(isAcceptedAsset('USDC', 'credit_alphanum4').accepted).toBe(false);
    expect(isAcceptedAsset('USDC', 'credit_alphanum4', '').accepted).toBe(false);
  });

  test('config differs correctly for testnet vs mainnet', () => {
    const testnet = loadConfig({ network: 'testnet' });
    expect(testnet.isAcceptedAsset('USDC', 'credit_alphanum4', TESTNET_USDC).accepted).toBe(true);
    expect(testnet.isAcceptedAsset('USDC', 'credit_alphanum4', MAINNET_USDC).accepted).toBe(false);

    const mainnet = loadConfig({ network: 'mainnet' });
    expect(mainnet.isAcceptedAsset('USDC', 'credit_alphanum4', MAINNET_USDC).accepted).toBe(true);
    expect(mainnet.isAcceptedAsset('USDC', 'credit_alphanum4', TESTNET_USDC).accepted).toBe(false);
  });

  test('honors an explicit USDC_ISSUER override', () => {
    const { isAcceptedAsset } = loadConfig({ network: 'mainnet', usdcIssuer: ATTACKER_ISSUER });
    // With the override pinned, only that issuer is accepted.
    expect(isAcceptedAsset('USDC', 'credit_alphanum4', ATTACKER_ISSUER).accepted).toBe(true);
    expect(isAcceptedAsset('USDC', 'credit_alphanum4', MAINNET_USDC).accepted).toBe(false);
  });
});

describe('isAcceptedAsset — native XLM has no issuer', () => {
  test('accepts native XLM with no issuer, rejects a spurious one', () => {
    const { isAcceptedAsset } = loadConfig({ network: 'testnet', acceptedAsset: 'XLM' });
    expect(isAcceptedAsset('XLM', 'native', null).accepted).toBe(true);
    expect(isAcceptedAsset('XLM', 'native').accepted).toBe(true);
    expect(isAcceptedAsset('XLM', 'native', ATTACKER_ISSUER).accepted).toBe(false);
  });
});
