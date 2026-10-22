/**
 * @jest-environment jsdom
 */

/**
 * Regression test for issue #1790: the authenticated branch of PaymentForm
 * called getPaymentPlan without importing it, so every admin student lookup
 * threw a ReferenceError before any request was made. This asserts the
 * lookup completes and the plan endpoint is requested with the abort signal.
 */

import { render, waitFor } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

jest.mock('../../i18n', () => ({ t: (key) => key }));

jest.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

jest.mock('../DisputeForm', () => () => null);

jest.mock('../../services/api', () => ({
  getStudent: jest.fn(() => Promise.resolve({ data: { studentId: 'STU-1', name: 'Ada' } })),
  getPublicStudent: jest.fn(),
  getPaymentInstructions: jest.fn(() => Promise.resolve({ data: null })),
  getStudentPayments: jest.fn(() => Promise.resolve({ data: { payments: [] } })),
  getStudentBalance: jest.fn(() => Promise.resolve({ data: {} })),
  getPaymentRefunds: jest.fn(() => Promise.resolve({ data: [] })),
  getPaymentPlan: jest.fn(() => Promise.resolve({ data: null })),
}));

const api = require('../../services/api');
const PaymentForm = require('../PaymentForm').default;

describe('PaymentForm authenticated lookup (#1790)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads the plan alongside the student without a ReferenceError', async () => {
    render(<PaymentForm initialStudentId="STU-1" />);

    await waitFor(() => expect(api.getStudent).toHaveBeenCalledWith('STU-1', expect.objectContaining({ signal: expect.anything() })));
    await waitFor(() => expect(api.getPaymentPlan).toHaveBeenCalledWith('STU-1', expect.objectContaining({ signal: expect.anything() })));
  });
});
