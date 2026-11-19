/**
 * @jest-environment jsdom
 */

/**
 * #1832 — accessibility of the payment and verify flow.
 *
 * Covers: QR code accessible name, copy announcements via a live region,
 * the REQUIRED memo block, grouped hashes, error/field association in
 * StudentForm, and WCAG 2.2 AA contrast for --text-subtle in every theme.
 */

import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { groupChars } from '../GroupedValue';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));
jest.mock('../DisputeForm', () => () => null);

const mockWallet = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUGEAALXQDNUNRCV';
const mockTxHash = 'a'.repeat(64);

jest.mock('../../services/api', () => ({
  getStudent: jest.fn(() => Promise.resolve({ data: { studentId: 'STU-AB12CD', name: 'Ada', class: '5A', feeAmount: 150, feePaid: false } })),
  getPublicStudent: jest.fn(),
  getPaymentInstructions: jest.fn(() => Promise.resolve({
    data: { walletAddress: mockWallet, memo: 'STU-AB12CD', feeAmount: 150, acceptedAssets: [] },
  })),
  getStudentPayments: jest.fn(() => Promise.resolve({
    data: { payments: [{ txHash: mockTxHash, amount: 150, feeValidationStatus: 'valid', confirmedAt: null }] },
  })),
  getStudentBalance: jest.fn(() => Promise.resolve({ data: {} })),
  getPaymentRefunds: jest.fn(() => Promise.resolve({ data: [] })),
  getPaymentPlan: jest.fn(() => Promise.resolve({ data: null })),
}));

// jsdom lacks TextEncoder, which stellarMemo uses when encoding memos.
global.TextEncoder = require('util').TextEncoder;

const PaymentForm = require('../PaymentForm').default;
const StudentForm = require('../StudentForm').default;

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: jest.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe('groupChars', () => {
  it('groups a long value into 4-character chunks', () => {
    expect(groupChars('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });

  it('returns an empty string for missing input', () => {
    expect(groupChars(undefined)).toBe('');
  });
});

describe('PaymentForm accessibility (#1832)', () => {
  async function renderLoaded() {
    render(<PaymentForm initialStudentId="STU-AB12CD" />);
    await screen.findByText('paymentForm.walletAddress');
  }

  it('gives the payment QR an accessible name describing amount and memo', async () => {
    await renderLoaded();
    const qr = screen.getByRole('img', { name: /paymentForm\.qrPayAria/ });
    expect(qr.getAttribute('aria-label')).toContain('"amount":150');
    expect(qr.getAttribute('aria-label')).toContain('STU-AB12CD');
  });

  it('gives the share-link QR an accessible name', async () => {
    await renderLoaded();
    expect(screen.getByRole('img', { name: /paymentForm\.shareQrAria/ })).toBeInTheDocument();
  });

  it('marks the memo as required in a labelled group with consequence and exchange warning', async () => {
    await renderLoaded();
    const group = screen.getByRole('group', { name: 'paymentForm.memoRequiredTitle' });
    expect(group).toHaveAttribute('aria-describedby', 'memo-help memo-exchange');
    expect(document.getElementById('memo-help')).toHaveTextContent('paymentForm.memoRequiredExplain');
    expect(document.getElementById('memo-exchange')).toHaveTextContent('paymentForm.memoExchangeWarning');
  });

  it('announces a successful copy through a polite live region', async () => {
    await renderLoaded();
    const copyButtons = screen.getAllByRole('button', { name: 'actions.copyToClipboard' });
    fireEvent.click(copyButtons[0]);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    await waitFor(() => expect(live).toHaveTextContent('paymentForm.announceWalletCopied'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockWallet);
  });

  it('renders the wallet address in groups but exposes the full value to assistive tech', async () => {
    await renderLoaded();
    const hidden = document.querySelector('[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    const sr = within(hidden.parentElement).getByText(groupChars(mockWallet), { selector: '.sr-only' });
    expect(sr).toBeInTheDocument();
  });

  it('links the lookup error to the student ID input', async () => {
    // Public mode is the path that surfaces a lookup failure as an alert.
    const api = require('../../services/api');
    api.getPublicStudent.mockImplementationOnce(() => Promise.reject({ response: { data: {} } }));
    render(<PaymentForm initialStudentId="" publicMode />);
    const input = screen.getByLabelText('paymentForm.studentIdLabel');
    fireEvent.change(input, { target: { value: 'NOPE' } });
    fireEvent.submit(input.closest('form'));
    const alert = await screen.findByRole('alert');
    expect(alert.id).toBe('sid-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'sid-error');
  });
});

describe('StudentForm field association (#1832)', () => {
  const student = { studentId: 'STU-1', name: 'Ada', class: '5A', parentEmail: '', parentPhone: '' };

  it('labels every editable field through htmlFor/id', () => {
    render(<StudentForm student={student} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('studentForm.name')).toHaveAttribute('id', 'sf-name');
    expect(screen.getByLabelText('studentForm.className')).toHaveAttribute('id', 'sf-class');
    expect(screen.getByLabelText('studentForm.parentEmail')).toHaveAttribute('id', 'sf-parent-email');
    expect(screen.getByLabelText('studentForm.parentPhone')).toHaveAttribute('id', 'sf-parent-phone');
    expect(screen.getByLabelText('studentForm.studentId')).toBeDisabled();
  });

  it('associates a validation error with its field and moves focus to the first invalid field', async () => {
    render(<StudentForm student={{ ...student, name: '' }} onSave={() => {}} onClose={() => {}} />);
    fireEvent.submit(screen.getByLabelText('studentForm.name').closest('form'));
    const name = screen.getByLabelText('studentForm.name');
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', 'sf-name-error');
    expect(document.getElementById('sf-name-error')).toHaveAttribute('role', 'alert');
  });
});

describe('--text-subtle contrast (#1832)', () => {
  // Parse the stylesheet's top-level rules into { selector, decls } records.
  // Nested @media blocks are flattened: the inner rule's selector is kept.
  const css = fs.readFileSync(path.join(__dirname, '../../styles/globals.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].split('\n').pop().trim();
    const decls = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
    if (Object.keys(decls).length) rules.push({ selector, decls });
  }
  // Effective value of a token for a selector: last declaration in source order.
  const effective = (selector, token) => {
    let value;
    for (const r of rules) if (r.selector === selector && r.decls[token]) value = r.decls[token];
    return value;
  };

  function luminance(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([
    [':root', 'light (system default)'],
    ['html.light', 'light (explicit)'],
    ['html.dark', 'dark (explicit)'],
    [':root:not(.light)', 'dark (system preference)'],
  ])('meets 4.5:1 against every surface in %s (%s)', (selector) => {
    const subtle = effective(selector, '--text-subtle');
    expect(subtle).toMatch(/^#[0-9a-f]{6}$/i);
    // Backgrounds may be gradients; the solid colour is the last hex in the value.
    const surfaces = ['--bg', '--bg-subtle', '--card-bg']
      .map((t) => effective(selector, t))
      .filter(Boolean)
      .map((v) => v.match(/#[0-9a-f]{6}\b/gi).pop());
    expect(surfaces.length).toBeGreaterThan(0);
    for (const bg of surfaces) {
      expect(contrast(subtle, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
