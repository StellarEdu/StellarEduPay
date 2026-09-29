/**
 * @jest-environment jsdom
 */

/**
 * #1581 — Security screen: lists and revokes sessions for super-admins, and
 * links to MFA enrolment for everyone.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));
jest.mock('next/link', () => ({ children, href, ...rest }) => <a href={href} {...rest}>{children}</a>);

let mockRoles = ['super_admin'];
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => ({ roles: mockRoles, isAdmin: true, checked: true }),
}));

jest.mock('../../services/api', () => ({
  listSessions: jest.fn(),
  revokeSession: jest.fn(() => Promise.resolve({ data: {} })),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SecurityPage from '../../pages/security';

const api = require('../../services/api');

beforeEach(() => {
  jest.clearAllMocks();
  mockRoles = ['super_admin'];
  api.listSessions.mockResolvedValue({
    data: { sessions: [{ sessionId: 's1', deviceInfo: { userAgent: 'Firefox', ip: '10.0.0.1' }, createdAt: '2026-01-01T00:00:00Z' }] },
  });
});

describe('SecurityPage (#1581)', () => {
  it('links to MFA setup', () => {
    render(<SecurityPage />);
    expect(screen.getByText('security.mfaBtn').closest('a')).toHaveAttribute('href', '/mfa-setup');
  });

  it('lists and revokes sessions for super-admins', async () => {
    render(<SecurityPage />);
    expect(await screen.findByText('Firefox')).toBeInTheDocument();

    fireEvent.click(screen.getByText('security.revokeBtn'));
    const buttons = screen.getAllByText('security.revokeBtn');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith('s1'));
  });

  it('does not request sessions for school users', () => {
    mockRoles = ['owner'];
    render(<SecurityPage />);
    expect(screen.getByText('security.sessionsSuperAdminOnly')).toBeInTheDocument();
    expect(api.listSessions).not.toHaveBeenCalled();
  });
});
