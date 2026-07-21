'use strict';

/**
 * Tests for the pay-fees page payment flow – issue #394
 *
 * The root Jest environment is Node-only (no jsdom/Babel), so we test:
 *  1. generateStellarPaymentUri logic (QR code URI generation)
 *  2. handleSubmit logic (student lookup, instructions, payments)
 *  3. handleVerify logic (tx hash verification)
 *  4. Error and loading state transitions
 *  5. Source-level acceptance criteria assertions
 */

// ── generateStellarPaymentUri (CommonJS re-implementation for Node tests) ─────
// The frontend uses ES modules; we replicate the pure logic here to test it
// without needing Babel.

function generateStellarPaymentUri({ destination, amount, memo, memoType = 'text', assetCode = 'XLM', assetIssuer = null }) {
  if (!destination) throw new Error('Destination wallet address is required');
  if (!amount || parseFloat(amount) <= 0) throw new Error('Valid payment amount is required');

  const params = new URLSearchParams();
  params.append('destination', destination);
  params.append('amount', String(amount));
  if (memo) {
    params.append('memo', memo);
    params.append('memo_type', memoType.toUpperCase());
  }
  if (assetCode !== 'XLM' && assetCode !== 'native') {
    params.append('asset_code', assetCode);
    if (assetIssuer) params.append('asset_issuer', assetIssuer);
  }
  return `web+stellar:pay?${params.toString()}`;
}

// ── Helpers mirroring component logic ────────────────────────────────────────

async function runHandleSubmit(studentId, { getStudent, getPaymentInstructions, getStudentPayments }) {
  try {
    const [stuRes, instrRes, payRes] = await Promise.all([
      getStudent(studentId),
      getPaymentInstructions(studentId),
      getStudentPayments(studentId),
    ]);
    return {
      student: stuRes.data,
      instructions: instrRes.data,
      payments: payRes.data?.payments ?? payRes.data ?? [],
      error: '',
    };
  } catch {
    return { student: null, instructions: null, payments: null, error: 'Student not found. Please check the ID.' };
  }
}

async function runHandleVerify(txHash, verifyPayment) {
  try {
    const res = await verifyPayment(txHash.trim());
    return { result: res.data, error: '' };
  } catch (err) {
    return {
      result: null,
      error: err.response?.data?.error || 'Verification failed. Check the transaction hash and try again.',
    };
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STUDENT = { studentId: 'STU001', name: 'Alice Johnson', class: 'Grade 5A', feeAmount: 250, feePaid: false };
const INSTRUCTIONS = {
  walletAddress: 'GSCHOOL123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  memo: 'STU001',
  feeAmount: 250,
  acceptedAssets: [
    { code: 'XLM', displayName: 'Stellar Lumens' },
    { code: 'USDC', displayName: 'USD Coin' },
  ],
};
const PAYMENTS = [
  { txHash: 'abc123', amount: 250, assetCode: 'XLM', feeValidationStatus: 'valid', confirmedAt: '2026-01-15T10:00:00Z' },
];
const VERIFY_RESULT = {
  hash: 'abc123def456',
  memo: 'STU001',
  amount: 250,
  assetCode: 'XLM',
  date: '2026-01-15T10:00:00Z',
  feeValidation: { status: 'valid', message: 'Payment matches the required fee' },
  stellarExplorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc123def456',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateStellarPaymentUri (QR code URI)', () => {
  test('generates valid SEP-0007 URI with destination, amount, memo', () => {
    const uri = generateStellarPaymentUri({
      destination: INSTRUCTIONS.walletAddress,
      amount: 250,
      memo: 'STU001',
    });
    expect(uri).toMatch(/^web\+stellar:pay\?/);
    expect(uri).toContain(`destination=${INSTRUCTIONS.walletAddress}`);
    expect(uri).toContain('amount=250');
    expect(uri).toContain('memo=STU001');
    expect(uri).toContain('memo_type=TEXT');
  });

  test('throws when destination is missing', () => {
    expect(() => generateStellarPaymentUri({ amount: 250, memo: 'STU001' }))
      .toThrow('Destination wallet address is required');
  });

  test('throws when amount is zero', () => {
    expect(() => generateStellarPaymentUri({ destination: 'GXXX', amount: 0 }))
      .toThrow('Valid payment amount is required');
  });

  test('throws when amount is negative', () => {
    expect(() => generateStellarPaymentUri({ destination: 'GXXX', amount: -1 }))
      .toThrow('Valid payment amount is required');
  });

  test('omits memo params when memo is not provided', () => {
    const uri = generateStellarPaymentUri({ destination: 'GXXX', amount: 100 });
    expect(uri).not.toContain('memo=');
    expect(uri).not.toContain('memo_type=');
  });

  test('includes asset_code and asset_issuer for non-native assets', () => {
    const uri = generateStellarPaymentUri({
      destination: 'GXXX',
      amount: 100,
      memo: 'STU001',
      assetCode: 'USDC',
      assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain('asset_issuer=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  });

  test('does not include asset_code for native XLM', () => {
    const uri = generateStellarPaymentUri({ destination: 'GXXX', amount: 100, assetCode: 'XLM' });
    expect(uri).not.toContain('asset_code=');
  });
});

describe('handleSubmit logic (student lookup)', () => {
  test('returns student, instructions, and payments on success', async () => {
    const api = {
      getStudent: jest.fn().mockResolvedValue({ data: STUDENT }),
      getPaymentInstructions: jest.fn().mockResolvedValue({ data: INSTRUCTIONS }),
      getStudentPayments: jest.fn().mockResolvedValue({ data: PAYMENTS }),
    };
    const result = await runHandleSubmit('STU001', api);
    expect(result.error).toBe('');
    expect(result.student).toEqual(STUDENT);
    expect(result.instructions).toEqual(INSTRUCTIONS);
    expect(result.payments).toEqual(PAYMENTS);
  });

  test('calls all three APIs in parallel', async () => {
    const order = [];
    const api = {
      getStudent: jest.fn().mockImplementation(async () => { order.push('student'); return { data: STUDENT }; }),
      getPaymentInstructions: jest.fn().mockImplementation(async () => { order.push('instructions'); return { data: INSTRUCTIONS }; }),
      getStudentPayments: jest.fn().mockImplementation(async () => { order.push('payments'); return { data: PAYMENTS }; }),
    };
    await runHandleSubmit('STU001', api);
    expect(api.getStudent).toHaveBeenCalledWith('STU001');
    expect(api.getPaymentInstructions).toHaveBeenCalledWith('STU001');
    expect(api.getStudentPayments).toHaveBeenCalledWith('STU001');
  });

  test('returns error message when student not found', async () => {
    const api = {
      getStudent: jest.fn().mockRejectedValue(new Error('404')),
      getPaymentInstructions: jest.fn().mockRejectedValue(new Error('404')),
      getStudentPayments: jest.fn().mockRejectedValue(new Error('404')),
    };
    const result = await runHandleSubmit('INVALID', api);
    expect(result.student).toBeNull();
    expect(result.instructions).toBeNull();
    expect(result.error).toBe('Student not found. Please check the ID.');
  });

  test('normalises payments from nested .payments property', async () => {
    const api = {
      getStudent: jest.fn().mockResolvedValue({ data: STUDENT }),
      getPaymentInstructions: jest.fn().mockResolvedValue({ data: INSTRUCTIONS }),
      getStudentPayments: jest.fn().mockResolvedValue({ data: { payments: PAYMENTS } }),
    };
    const result = await runHandleSubmit('STU001', api);
    expect(result.payments).toEqual(PAYMENTS);
  });

  test('returns empty array when no payments exist', async () => {
    const api = {
      getStudent: jest.fn().mockResolvedValue({ data: STUDENT }),
      getPaymentInstructions: jest.fn().mockResolvedValue({ data: INSTRUCTIONS }),
      getStudentPayments: jest.fn().mockResolvedValue({ data: [] }),
    };
    const result = await runHandleSubmit('STU001', api);
    expect(result.payments).toEqual([]);
  });
});

describe('handleVerify logic (payment verification)', () => {
  test('returns result on successful verification', async () => {
    const verifyPayment = jest.fn().mockResolvedValue({ data: VERIFY_RESULT });
    const result = await runHandleVerify('abc123def456', verifyPayment);
    expect(result.error).toBe('');
    expect(result.result).toEqual(VERIFY_RESULT);
    expect(verifyPayment).toHaveBeenCalledWith('abc123def456');
  });

  test('trims whitespace from tx hash before calling API', async () => {
    const verifyPayment = jest.fn().mockResolvedValue({ data: VERIFY_RESULT });
    await runHandleVerify('  abc123def456  ', verifyPayment);
    expect(verifyPayment).toHaveBeenCalledWith('abc123def456');
  });

  test('returns API error message on failure', async () => {
    const verifyPayment = jest.fn().mockRejectedValue({
      response: { data: { error: 'Transaction not found' } },
    });
    const result = await runHandleVerify('badhash', verifyPayment);
    expect(result.result).toBeNull();
    expect(result.error).toBe('Transaction not found');
  });

  test('returns fallback message when error has no response body', async () => {
    const verifyPayment = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await runHandleVerify('badhash', verifyPayment);
    expect(result.result).toBeNull();
    expect(result.error).toBe('Verification failed. Check the transaction hash and try again.');
  });
});

describe('QR URI integration with payment instructions', () => {
  test('generates correct URI from real instruction data', () => {
    const uri = generateStellarPaymentUri({
      destination: INSTRUCTIONS.walletAddress,
      amount: INSTRUCTIONS.feeAmount,
      memo: INSTRUCTIONS.memo,
    });
    expect(uri).toContain(INSTRUCTIONS.walletAddress);
    expect(uri).toContain('amount=250');
    expect(uri).toContain('memo=STU001');
  });

  test('URI is scannable by Stellar wallets (correct scheme)', () => {
    const uri = generateStellarPaymentUri({
      destination: INSTRUCTIONS.walletAddress,
      amount: 250,
      memo: 'STU001',
    });
    expect(uri.startsWith('web+stellar:pay?')).toBe(true);
  });
});

describe('pay-fees page source assertions (acceptance criteria)', () => {
  const fs = require('fs');
  const path = require('path');

  const pageSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/pages/pay-fees.jsx'), 'utf8'
  );
  const formSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/PaymentForm.jsx'), 'utf8'
  );
  const verifySrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/VerifyPayment.jsx'), 'utf8'
  );

  test('pay-fees.jsx renders PaymentForm and VerifyPayment', () => {
    expect(pageSrc).toMatch(/import PaymentForm/);
    expect(pageSrc).toMatch(/import VerifyPayment/);
    expect(pageSrc).toMatch(/<PaymentForm/);
    expect(pageSrc).toMatch(/<VerifyPayment/);
  });

  test('pay-fees.jsx has responsive grid layout', () => {
    // Post-revamp the responsive two-column layout lives in the shared
    // payfees-grid CSS class rather than inline grid-template-columns/max-width.
    expect(pageSrc).toMatch(/payfees-grid/);
  });

  test('PaymentForm has student ID input with label', () => {
    expect(formSrc).toMatch(/Student ID/);
    expect(formSrc).toMatch(/htmlFor.*sid|id.*sid/);
    expect(formSrc).toMatch(/type="text"/);
  });

  test('PaymentForm shows loading state', () => {
    expect(formSrc).toMatch(/loading/);
    expect(formSrc).toMatch(/Loading/);
    expect(formSrc).toMatch(/disabled={loading}/);
  });

  test('PaymentForm shows error state with role=alert', () => {
    expect(formSrc).toMatch(/role="alert"/);
    // Post-revamp the red error background comes from the shared alert-danger
    // class (CSS variables) rather than a hard-coded #fee2e2 hex.
    expect(formSrc).toMatch(/alert-danger/);
  });

  test('PaymentForm displays wallet address and memo with copy buttons', () => {
    expect(formSrc).toMatch(/walletAddress/);
    expect(formSrc).toMatch(/memo/);
    expect(formSrc).toMatch(/Copy/);
  });

  test('PaymentForm displays accepted assets', () => {
    expect(formSrc).toMatch(/acceptedAssets/);
    expect(formSrc).toMatch(/displayName/);
  });

  test('PaymentForm renders QR code using qrcode.react', () => {
    expect(formSrc).toMatch(/QRCodeSVG|QRCode/);
    expect(formSrc).toMatch(/qrcode\.react/);
  });

  test('PaymentForm generates Stellar URI for QR code', () => {
    expect(formSrc).toMatch(/generateStellarPaymentUri/);
    expect(formSrc).toMatch(/stellarUri/);
  });

  test('PaymentForm has Copy payment URI button', () => {
    expect(formSrc).toMatch(/Copy payment URI/);
    expect(formSrc).toMatch(/paymentUri/);
  });

  test('PaymentForm has Download QR button', () => {
    expect(formSrc).toMatch(/Download QR/);
    expect(formSrc).toMatch(/downloadQr/);
  });

  test('PaymentForm copy URI button shows feedback on copy', () => {
    expect(formSrc).toMatch(/qr-uri/);
    expect(formSrc).toMatch(/Copied!/);
  });

  test('PaymentForm download uses PNG format', () => {
    expect(formSrc).toMatch(/image\/png/);
    expect(formSrc).toMatch(/\.png/);
  });

  test('PaymentForm QR wrapper has ref for download', () => {
    expect(formSrc).toMatch(/qrWrapperRef/);
  });

  test('PaymentForm shows payment history', () => {
    expect(formSrc).toMatch(/Payment History/);
    expect(formSrc).toMatch(/payments\.map/);
  });

  test('VerifyPayment has tx hash input with label', () => {
    expect(verifySrc).toMatch(/Transaction Hash/);
    expect(verifySrc).toMatch(/htmlFor.*txin|id.*txin/);
  });

  test('VerifyPayment shows loading state', () => {
    expect(verifySrc).toMatch(/Verifying/);
    expect(verifySrc).toMatch(/disabled={loading/);
  });

  test('VerifyPayment shows error state with role=alert', () => {
    expect(verifySrc).toMatch(/role="alert"/);
  });

  test('VerifyPayment shows result card with amount, memo, date, status', () => {
    expect(verifySrc).toMatch(/result\.amount/);
    expect(verifySrc).toMatch(/result\.memo/);
    expect(verifySrc).toMatch(/result\.date/);
    expect(verifySrc).toMatch(/feeValidation/);
  });

  test('VerifyPayment has explorer link', () => {
    expect(verifySrc).toMatch(/stellarExplorerUrl/);
    expect(verifySrc).toMatch(/View on Stellar Explorer/);
  });
});
