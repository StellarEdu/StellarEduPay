/**
 * @jest-environment jsdom
 */
'use strict';

import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Dashboard from '../frontend/src/pages/dashboard';
import * as api from '../frontend/src/services/api';

jest.mock('../frontend/src/services/api');
jest.mock('../frontend/src/components/SyncButton', () => {
  return function MockSyncButton() {
    return <div data-testid="sync-button">Sync Button</div>;
  };
});
jest.mock('../frontend/src/components/ErrorBoundary', () => {
  return function MockErrorBoundary({ children }) {
    return <div data-testid="error-boundary">{children}</div>;
  };
});
jest.mock('../frontend/src/components/StudentForm', () => {
  return function MockStudentForm() {
    return <div data-testid="student-form">Student Form</div>;
  };
});

describe('Dashboard Error Handling (#672)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The Dashboard reports failures per data source rather than with one generic
  // "Could not load dashboard" banner: summary → "Could not load payment
  // summary.", students → "Could not load student list.", sync → "Could not load
  // sync status.". Each visible role="alert" banner is mirrored in an sr-only
  // aria-live region, so the same copy appears twice — assertions use
  // getAllByText / getAllByRole accordingly.
  describe('Network error handling', () => {
    it('should display error banner when API call fails', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      });
    });

    it('should show user-friendly error message on network failure', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Could not load payment summary\./i).length
        ).toBeGreaterThan(0);
      });
    });

    it('should display error banner on 503 Service Unavailable', async () => {
      const error = new Error('Service Unavailable');
      error.response = { status: 503 };
      api.getSyncStatus.mockRejectedValue(error);
      api.getPaymentSummary.mockRejectedValue(error);
      api.getStudents.mockRejectedValue(error);

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      });
    });

    it('should display error banner on timeout', async () => {
      const error = new Error('Request timeout');
      error.code = 'ECONNABORTED';
      api.getSyncStatus.mockRejectedValue(error);
      api.getPaymentSummary.mockRejectedValue(error);
      api.getStudents.mockRejectedValue(error);

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Error banner UI', () => {
    it('should include a Retry button in error banner', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByRole('button', { name: /retry/i }).length
        ).toBeGreaterThan(0);
      });
    });

    it('should re-fetch data when Retry button is clicked', async () => {
      api.getSyncStatus.mockRejectedValueOnce(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValueOnce(new Error('Network error'));
      api.getStudents.mockRejectedValueOnce(new Error('Network error'));

      api.getSyncStatus.mockResolvedValueOnce({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValueOnce({ data: { totalStudents: 0 } });
      api.getStudents.mockResolvedValueOnce({
        data: { students: [], pages: 1, total: 0 },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByRole('button', { name: /retry/i }).length
        ).toBeGreaterThan(0);
      });

      // The first Retry button belongs to the payment-summary banner and calls
      // fetchSummary → getPaymentSummary again.
      const retryButtons = screen.getAllByRole('button', { name: /retry/i });
      fireEvent.click(retryButtons[0]);

      await waitFor(() => {
        expect(api.getPaymentSummary).toHaveBeenCalledTimes(2);
      });
    });

    it('should render the error inside an accessible alert banner', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        const alerts = screen.getAllByRole('alert');
        expect(
          alerts.some((a) => /Could not load payment summary/i.test(a.textContent))
        ).toBe(true);
      });
    });

    it('should announce error to screen readers via aria-live', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      const { container } = render(<Dashboard />);

      await waitFor(() => {
        const liveRegion = container.querySelector('[aria-live="assertive"]');
        expect(liveRegion).toBeTruthy();
        expect(liveRegion).toHaveTextContent(/Could not load/i);
      });
    });
  });

  describe('Partial data handling', () => {
    it('should show partial content when students load but payments fail', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockResolvedValue({
        data: {
          students: [
            { studentId: 'STU001', name: 'Alice', class: '5A', feePaid: false },
          ],
          pages: 1,
          total: 1,
        },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });

      // Student list rendered, but the payment-summary error is still surfaced.
      expect(
        screen.getAllByText(/Could not load payment summary/i).length
      ).toBeGreaterThan(0);
    });

    it('should show partial content when payments load but students fail', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValue({
        data: { totalStudents: 10, paidCount: 5, totalXlmCollected: 500 },
      });
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Could not load student list/i).length
        ).toBeGreaterThan(0);
      });

      // Summary stats still render alongside the student-list error.
      expect(screen.getByText('Total Students')).toBeInTheDocument();
    });

    it('should display warning banner for partial data', async () => {
      api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockResolvedValue({
        data: {
          students: [
            { studentId: 'STU001', name: 'Alice', class: '5A', feePaid: false },
          ],
          pages: 1,
          total: 1,
        },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Could not load payment summary/i).length
        ).toBeGreaterThan(0);
      });
    });
  });

  describe('Error recovery', () => {
    it('should clear error state after successful retry', async () => {
      api.getSyncStatus.mockRejectedValueOnce(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValueOnce(new Error('Network error'));
      api.getStudents.mockRejectedValueOnce(new Error('Network error'));

      api.getSyncStatus.mockResolvedValueOnce({ data: { lastSyncAt: null } });
      api.getPaymentSummary.mockResolvedValueOnce({ data: { totalStudents: 0 } });
      api.getStudents.mockResolvedValueOnce({
        data: { students: [], pages: 1, total: 0 },
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Could not load payment summary/i).length
        ).toBeGreaterThan(0);
      });

      // Retry the payment-summary fetch; on success its error banner clears.
      const retryButtons = screen.getAllByRole('button', { name: /retry/i });
      fireEvent.click(retryButtons[0]);

      await waitFor(() => {
        expect(
          screen.queryByText(/Could not load payment summary/i)
        ).not.toBeInTheDocument();
      });
    });

    it('should not show blank page on error', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      const { container } = render(<Dashboard />);

      await waitFor(() => {
        // An alert banner is rendered rather than a blank page.
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      });
      expect(container.innerHTML).not.toBe('');
    });
  });

  describe('Unit test for error banner component', () => {
    it('should render an error banner with the failure message', async () => {
      api.getSyncStatus.mockRejectedValue(new Error('Network error'));
      api.getPaymentSummary.mockRejectedValue(new Error('Network error'));
      api.getStudents.mockRejectedValue(new Error('Network error'));

      render(<Dashboard />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/Could not load payment summary/i).length
        ).toBeGreaterThan(0);
      });
    });
  });
});
