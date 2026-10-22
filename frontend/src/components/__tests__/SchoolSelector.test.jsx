/**
 * @jest-environment jsdom
 */

/**
 * Regression test for issue #1791: GET /api/schools returns a bare array, but
 * SchoolSelector read `res.data.schools`, so the super-admin dropdown was always
 * empty and no school was selected. This asserts the selector accepts the bare
 * array and selects the first school.
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import SchoolSelector from '../SchoolSelector';
import { listSchools } from '../../services/api';

jest.mock('../../services/api', () => ({
  listSchools: jest.fn(),
}));

const superAdmin = { roles: ['super_admin'] };

describe('SchoolSelector (#1791)', () => {
  beforeEach(() => {
    localStorage.clear();
    listSchools.mockReset();
  });

  it('lists schools from a bare array response and selects the first one', async () => {
    listSchools.mockResolvedValue({
      data: [
        { schoolId: 'SCH-001', name: 'Alpha School' },
        { schoolId: 'SCH-002', name: 'Beta School' },
      ],
    });

    render(<SchoolSelector user={superAdmin} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Alpha School' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Beta School' })).toBeInTheDocument();
    expect(localStorage.getItem('selectedSchoolId')).toBe('SCH-001');
  });

  it('still accepts the wrapped { schools } shape', async () => {
    listSchools.mockResolvedValue({
      data: { schools: [{ schoolId: 'SCH-009', name: 'Gamma School' }] },
    });

    render(<SchoolSelector user={superAdmin} />);

    await waitFor(() => expect(screen.getByRole('option', { name: 'Gamma School' })).toBeInTheDocument());
    expect(localStorage.getItem('selectedSchoolId')).toBe('SCH-009');
  });
});
