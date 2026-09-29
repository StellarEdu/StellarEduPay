/**
 * @jest-environment jsdom
 */

/**
 * #1581 — Payments admin screen: tabbed lists, suspicious-payment review and
 * role-gated write actions.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));
jest.mock('../../components/SyncButton', () => () => <div data-testid="sync-button" />);

let mockRoles = ['owner'];
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => ({ roles: mockRoles, isAdmin: true, checked: true }),
}));

jest.mock('../../services/api', () => ({
  getPayments: jest.fn(),
  getSuspiciousPayments: jest.fn(),
  getPendingPayments: jest.fn(() => Promise.resolve({ data: { pending: [], pagination: { total: 0 } } })),
  getStuckPayments: jest.fn(() => Promise.resolve({ data: { payments: [], count: 0 } })),
  getOverpayments: jest.fn(() => Promise.resolve({ data: { overpayments: [], pagination: { total: 0 } } })),
  getSyncStatus: jest.fn(() => Promise.resolve({ data: { lastSyncAt: null } })),
  reviewSuspiciousPayment: jest.fn(() => Promise.resolve({ data: {} })),
  updatePaymentStatus: jest.fn(() => Promise.resolve({ data: {} })),
  initiateRefund: jest.fn(() => Promise.resolve({ data: {} })),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import PaymentsPage from '../../pages/payments';

const api = require('../../services/api');

const PAYMENT = { txHash: 'a'.repeat(64), studentId: 'STU001', amount: 50, status: 'SUCCESS' };
const FLAGGED = { txHash: 'b'.repeat(64), studentId: 'STU002', amount: 9000, status: 'SUCCESS', isSuspicious: true, suspicionReason: 'amount_spike' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRoles = ['owner'];
  api.getPayments.mockResolvedValue({ data: { payments: [PAYMENT], pagination: { total: 1, totalPages: 1 } } });
  api.getSuspiciousPayments.mockResolvedValue({ data: { suspicious: [FLAGGED], pagination: { total: 1, totalPages: 1 } } });
});

describe('PaymentsPage (#1581)', () => {
  it('lists payments on the default tab', async () => {
    render(<PaymentsPage />);
    expect(await screen.findByText('STU001')).toBeInTheDocument();
    expect(api.getPayments).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });

  it('reviews a suspicious payment', async () => {
    render(<PaymentsPage />);
    await screen.findByText('STU001');

    fireEvent.click(screen.getByText('payments.tab_suspicious'));
    expect(await screen.findByText('STU002')).toBeInTheDocument();

    fireEvent.click(screen.getByText('payments.reviewBtn'));
    fireEvent.click(await screen.findByText('payments.clearBtn'));

    await waitFor(() =>
      expect(api.reviewSuspiciousPayment).toHaveBeenCalledWith(FLAGGED.txHash, { action: 'clear', note: undefined })
    );
  });

  it('requires a reason before overriding a status', async () => {
    render(<PaymentsPage />);
    await screen.findByText('STU001');

    fireEvent.click(screen.getByText('payments.overrideBtn'));
    fireEvent.click(await screen.findByText('payments.applyStatusBtn'));
    expect(await screen.findByText('payments.reasonRequired')).toBeInTheDocument();
    expect(api.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('hides write actions from read-only users', async () => {
    mockRoles = ['read_only'];
    render(<PaymentsPage />);
    await screen.findByText('STU001');

    expect(screen.queryByText('payments.overrideBtn')).not.toBeInTheDocument();
    expect(screen.queryByText('payments.refundBtn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sync-button')).not.toBeInTheDocument();
  });

  it('only offers refunds to owners', async () => {
    mockRoles = ['staff'];
    render(<PaymentsPage />);
    await screen.findByText('STU001');

    expect(screen.getByText('payments.overrideBtn')).toBeInTheDocument();
    expect(screen.queryByText('payments.refundBtn')).not.toBeInTheDocument();
  });
});
