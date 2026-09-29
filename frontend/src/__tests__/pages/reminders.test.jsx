/**
 * @jest-environment jsdom
 */

/**
 * #1581 — Reminders screen: preview, confirmed send, opt-out, role gating.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));

let mockRoles = ['staff'];
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => ({ roles: mockRoles, isAdmin: true, checked: true }),
}));

jest.mock('../../services/api', () => ({
  previewReminders: jest.fn(),
  triggerReminders: jest.fn(() => Promise.resolve({ data: { summary: { sent: 1, failed: 0, skipped: 0 } } })),
  setReminderOptOut: jest.fn(() => Promise.resolve({ data: {} })),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RemindersPage from '../../pages/reminders';

const api = require('../../services/api');

beforeEach(() => {
  jest.clearAllMocks();
  mockRoles = ['staff'];
  api.previewReminders.mockResolvedValue({
    data: { count: 1, cooldownHours: 24, maxReminders: 3, students: [{ studentId: 'STU9', name: 'Grace Hopper', class: 'SS1', remainingBalance: 40 }] },
  });
});

describe('RemindersPage (#1581)', () => {
  it('previews eligible students', async () => {
    render(<RemindersPage />);
    expect(await screen.findByText(/Grace Hopper/)).toBeInTheDocument();
  });

  it('sends reminders only after confirmation', async () => {
    render(<RemindersPage />);
    await screen.findByText(/Grace Hopper/);

    fireEvent.click(screen.getByText('reminders.sendBtn'));
    expect(api.triggerReminders).not.toHaveBeenCalled();

    const buttons = screen.getAllByText('reminders.sendBtn');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.triggerReminders).toHaveBeenCalledTimes(1));
  });

  it('opts a student out', async () => {
    render(<RemindersPage />);
    await screen.findByText(/Grace Hopper/);

    fireEvent.click(screen.getByText('reminders.optOutBtn'));
    await waitFor(() => expect(api.setReminderOptOut).toHaveBeenCalledWith('STU9', true));
  });

  it('blocks read-only users', () => {
    mockRoles = ['read_only'];
    render(<RemindersPage />);
    expect(screen.getByText('adminCommon.noPermission')).toBeInTheDocument();
    expect(api.previewReminders).not.toHaveBeenCalled();
  });
});
