'use strict';

/**
 * Tests for stellarUri.js — generateStellarPaymentUri
 *
 * This file previously inlined a copy of the function because the root Jest
 * config was assumed not to transform ES modules. It does (babel-jest with
 * preset-env), and the inlined copy had already drifted from the real
 * implementation — it never picked up the stroop-space amount validation from
 * #1123, so the suite was green against logic that no longer shipped.
 * Importing the real module removes that whole failure mode.
 */

import { generateStellarPaymentUri, availableMemoTypes } from '../stellarUri';
import { encodeMemo } from '../stellarMemo';

const DEST = 'GAXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const INTENT_MEMO = 'A3F91B2C';

describe('generateStellarPaymentUri', () => {
  // ── XLM (native) ────────────────────────────────────────────────────────────

  test('generates basic XLM payment URI', () => {
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 10.5, memo: 'STU1023' });
    expect(uri).toContain('web+stellar:pay?');
    expect(uri).toContain(`destination=${DEST}`);
    expect(uri).toContain('amount=10.5000000');
    expect(uri).toContain('memo=STU1023');
    expect(uri).toContain('memo_type=MEMO_TEXT');
  });

  test('XLM URI omits asset_code and asset_issuer (native is default)', () => {
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 10 });
    expect(uri).not.toContain('asset_code');
    expect(uri).not.toContain('asset_issuer');
  });

  test('explicit assetCode=XLM also omits asset params', () => {
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 10, assetCode: 'XLM' });
    expect(uri).not.toContain('asset_code');
    expect(uri).not.toContain('asset_issuer');
  });

  test('generates URI without memo', () => {
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 5 });
    expect(uri).toContain('web+stellar:pay?');
    expect(uri).not.toContain('memo=');
  });

  // ── Memo types (#1118) ──────────────────────────────────────────────────────

  test('emits the SEP-0007 memo_type spelling, not the bare short form', () => {
    // Pre-#1118 this emitted `memo_type=TEXT`, which is not a value SEP-0007
    // defines; strict wallets reject it.
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 1, memo: INTENT_MEMO });
    expect(uri).toContain('memo_type=MEMO_TEXT');
    expect(uri).not.toContain('memo_type=TEXT');
  });

  test('MEMO_ID encodes the intent memo as its numeric equivalent', () => {
    const uri = generateStellarPaymentUri({
      destination: DEST, amount: 1, memo: INTENT_MEMO, memoType: 'MEMO_ID',
    });
    expect(uri).toContain('memo_type=MEMO_ID');
    expect(uri).toContain(`memo=${encodeMemo(INTENT_MEMO, 'MEMO_ID')}`);
  });

  test('MEMO_HASH encodes the intent memo as URL-escaped base64', () => {
    const uri = generateStellarPaymentUri({
      destination: DEST, amount: 1, memo: INTENT_MEMO, memoType: 'MEMO_HASH',
    });
    expect(uri).toContain('memo_type=MEMO_HASH');
    // URLSearchParams percent-encodes the base64 padding and '+'.
    const parsed = new URLSearchParams(uri.split('?')[1]);
    expect(parsed.get('memo')).toBe(encodeMemo(INTENT_MEMO, 'MEMO_HASH'));
  });

  test('accepts the legacy short memo type spellings', () => {
    const uri = generateStellarPaymentUri({
      destination: DEST, amount: 1, memo: INTENT_MEMO, memoType: 'id',
    });
    expect(uri).toContain('memo_type=MEMO_ID');
  });

  test('throws rather than emitting a URI the backend could not match', () => {
    expect(() => generateStellarPaymentUri({
      destination: DEST, amount: 1, memo: 'STU1023', memoType: 'MEMO_ID',
    })).toThrow('cannot be encoded');
  });

  test('throws for MEMO_RETURN, which carries no payment reference', () => {
    expect(() => generateStellarPaymentUri({
      destination: DEST, amount: 1, memo: INTENT_MEMO, memoType: 'MEMO_RETURN',
    })).toThrow('Unsupported memo type');
  });

  test('availableMemoTypes reflects what the memo can represent', () => {
    expect(availableMemoTypes(INTENT_MEMO)).toEqual(['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH']);
    expect(availableMemoTypes('STU1023')).toEqual(['MEMO_TEXT']);
  });

  // ── USDC (non-native) ────────────────────────────────────────────────────────

  test('USDC URI includes asset_code=USDC', () => {
    const uri = generateStellarPaymentUri({
      destination: DEST, amount: 100, memo: 'STU001',
      assetCode: 'USDC', assetIssuer: USDC_ISSUER,
    });
    expect(uri).toContain('asset_code=USDC');
  });

  test('USDC URI includes correct asset_issuer', () => {
    const uri = generateStellarPaymentUri({
      destination: DEST, amount: 100, memo: 'STU001',
      assetCode: 'USDC', assetIssuer: USDC_ISSUER,
    });
    expect(uri).toContain(`asset_issuer=${USDC_ISSUER}`);
  });

  test('non-native asset without issuer includes asset_code but omits asset_issuer', () => {
    const uri = generateStellarPaymentUri({ destination: DEST, amount: 50, assetCode: 'USDC' });
    expect(uri).toContain('asset_code=USDC');
    expect(uri).not.toContain('asset_issuer');
  });

  // ── Validation ───────────────────────────────────────────────────────────────

  test('throws when destination is missing', () => {
    expect(() => generateStellarPaymentUri({ amount: 10 })).toThrow('Destination wallet address is required');
  });

  test('throws when amount is zero', () => {
    expect(() => generateStellarPaymentUri({ destination: DEST, amount: 0 })).toThrow('Valid payment amount is required');
  });

  test('throws when amount is negative', () => {
    expect(() => generateStellarPaymentUri({ destination: DEST, amount: -5 })).toThrow('Valid payment amount is required');
  });

  test('throws for sub-stroop amounts (#1123)', () => {
    expect(() => generateStellarPaymentUri({ destination: DEST, amount: 0.00000001 })).toThrow('Valid payment amount is required');
  });
});
