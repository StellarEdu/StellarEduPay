/**
 * @jest-environment jsdom
 */

/**
 * #1581 — Settings & users screen: loads the school profile, runtime settings
 * and users, and gates edits on role (settings: super-admin; users: owner).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));

let mockAuth = { roles: ['owner'], schoolId: 'SCH1' };
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => ({ ...mockAuth, isAdmin: true, checked: true }),
}));

jest.mock('../../services/api', () => ({
  getSchoolById: jest.fn(() => Promise.resolve({ data: { name: 'Hill School', adminEmail: 'a@b.c', stellarAddress: 'GABC' } })),
  updateSchoolById: jest.fn(() => Promise.resolve({ data: {} })),
  getSchoolSettings: jest.fn(() => Promise.resolve({ data: { settings: { reminderEnabled: true, reminderIntervalMs: 86400000, maxSyncBatchSize: 20, maintenanceMode: false } } })),
  updateSchoolSettings: jest.fn(() => Promise.resolve({ data: {} })),
  getPaymentLimits: jest.fn(() => Promise.resolve({ data: { min: 1, max: 1000 } })),
  getAcceptedAssets: jest.fn(() => Promise.resolve({ data: { assets: [{ code: 'XLM', displayName: 'Stellar Lumens' }] } })),
  listSchoolUsers: jest.fn(() => Promise.resolve({ data: { users: [{ _id: 'u1', email: 'staff@school.test', roles: ['staff'], isActive: true }] } })),
  createSchoolUser: jest.fn(() => Promise.resolve({ data: {} })),
  updateSchoolUser: jest.fn(() => Promise.resolve({ data: {} })),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SettingsPage from '../../pages/settings';

const api = require('../../services/api');

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { roles: ['owner'], schoolId: 'SCH1' };
});

describe('SettingsPage (#1581)', () => {
  it('loads the school profile and users for the active school', async () => {
    render(<SettingsPage />);
    expect(await screen.findByDisplayValue('Hill School')).toBeInTheDocument();
    expect(await screen.findByText('staff@school.test')).toBeInTheDocument();
    expect(api.getSchoolById).toHaveBeenCalledWith('SCH1');
    expect(api.listSchoolUsers).toHaveBeenCalledWith('SCH1');
  });

  it('lets owners invite users but not edit super-admin settings', async () => {
    render(<SettingsPage />);
    await screen.findByDisplayValue('Hill School');

    expect(screen.getByDisplayValue('Hill School')).toBeDisabled();
    expect(screen.getAllByText('settings.readOnlyNotice').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('settings.inviteEmail'), { target: { value: 'new@school.test' } });
    fireEvent.click(screen.getByText('settings.inviteBtn'));
    await waitFor(() =>
      expect(api.createSchoolUser).toHaveBeenCalledWith('SCH1', { email: 'new@school.test', roles: ['staff'] })
    );
  });

  it('lets super-admins save the school profile', async () => {
    mockAuth = { roles: ['super_admin'], schoolId: 'SCH1' };
    render(<SettingsPage />);
    const name = await screen.findByDisplayValue('Hill School');

    fireEvent.change(name, { target: { value: 'Hill Academy' } });
    fireEvent.click(screen.getAllByText('actions.save')[0]);
    await waitFor(() => expect(api.updateSchoolById).toHaveBeenCalledWith('SCH1', { name: 'Hill Academy' }));
  });

  it('hides user management actions from staff', async () => {
    mockAuth = { roles: ['staff'], schoolId: 'SCH1' };
    render(<SettingsPage />);
    await screen.findByText('staff@school.test');

    expect(screen.queryByText('settings.inviteBtn')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.deactivateBtn')).not.toBeInTheDocument();
  });
});
