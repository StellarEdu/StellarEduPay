/**
 * @jest-environment jsdom
 */

/**
 * #1581 — Students admin screen: lists students and gates write actions
 * (add / import / edit / delete) on the user's role.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && opts.studentId ? `${key}:${opts.studentId}` : key) }),
}));
jest.mock('../../i18n', () => ({ t: (key) => key }));
jest.mock('../../components/StudentForm', () => () => null);

let mockRoles = ['owner'];
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => ({ roles: mockRoles, isAdmin: true, checked: true }),
}));

jest.mock('../../services/api', () => ({
  getStudents: jest.fn(),
  registerStudent: jest.fn(),
  deleteStudent: jest.fn(() => Promise.resolve({ data: {} })),
  restoreStudent: jest.fn(),
  bulkImportStudents: jest.fn(),
  exportStudents: jest.fn(),
  getStudentFeeHistory: jest.fn(() => Promise.resolve({ data: { history: [], pagination: { total: 0, totalPages: 1 } } })),
  resetStudentPayment: jest.fn(),
  reconcileStudent: jest.fn(() => Promise.resolve({ data: { reconciled: false } })),
  setReminderOptOut: jest.fn(),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import StudentsPage from '../../pages/students';

const api = require('../../services/api');

const STUDENTS = [
  { studentId: 'STU001', name: 'Ada Lovelace', class: 'JSS1', feeAmount: 100, totalPaid: 100, feePaid: true },
  { studentId: 'STU002', name: 'Alan Turing', class: 'JSS2', feeAmount: 100, totalPaid: 0, feePaid: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRoles = ['owner'];
  api.getStudents.mockResolvedValue({ data: { students: STUDENTS, total: 2, page: 1, pages: 1 } });
});

describe('StudentsPage (#1581)', () => {
  it('renders the student list', async () => {
    render(<StudentsPage />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
    expect(api.getStudents).toHaveBeenCalledWith(1, 20, expect.any(Object), expect.any(Object));
  });

  it('shows write actions to owners and deletes after confirmation', async () => {
    render(<StudentsPage />);
    await screen.findByText('Ada Lovelace');

    expect(screen.getByText('students.addBtn')).toBeInTheDocument();
    expect(screen.getByText('students.importBtn')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('actions.delete')[0]);
    // ConfirmationModal renders a second "actions.delete" button — the confirm one.
    const buttons = screen.getAllByText('actions.delete');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(api.deleteStudent).toHaveBeenCalledWith('STU001'));
  });

  it('hides write actions from read-only users', async () => {
    mockRoles = ['read_only'];
    render(<StudentsPage />);
    await screen.findByText('Ada Lovelace');

    expect(screen.queryByText('students.addBtn')).not.toBeInTheDocument();
    expect(screen.queryByText('students.importBtn')).not.toBeInTheDocument();
    expect(screen.queryByText('actions.delete')).not.toBeInTheDocument();
    expect(screen.queryByText('actions.edit')).not.toBeInTheDocument();
    // Export is a read operation and stays available.
    expect(screen.getByText('students.exportBtn')).toBeInTheDocument();
  });

  it('expands a student to show fee history and reconcile', async () => {
    render(<StudentsPage />);
    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getAllByText('actions.viewDetails')[0]);
    expect(await screen.findByTestId('student-detail-STU001')).toBeInTheDocument();
    await waitFor(() => expect(api.getStudentFeeHistory).toHaveBeenCalledWith('STU001', { page: 1, limit: 10 }));

    fireEvent.click(screen.getByText('students.reconcileBtn'));
    await waitFor(() => expect(api.reconcileStudent).toHaveBeenCalledWith('STU001'));
  });
});
