'use strict';

const mockSchoolAuth = jest.fn();
const mockResolveSchool = jest.fn();
const mockRouter = {
  use: jest.fn(),
  get: jest.fn(),
};

jest.mock('express', () => ({ Router: () => mockRouter }));
jest.mock('../src/controllers/analyticsController', () => ({
  getPaymentVolumeTrend: jest.fn(),
  getClassPaymentCompletion: jest.fn(),
  getTopUnpaidCohorts: jest.fn(),
  getPaymentAnalyticsSummary: jest.fn(),
}));
jest.mock('../src/middleware/schoolContext', () => ({
  resolveSchool: mockResolveSchool,
}));
jest.mock('../src/middleware/auth', () => ({
  requireSchoolAuth: jest.fn(() => mockSchoolAuth),
}));

describe('analytics route authorization (#2028)', () => {
  beforeAll(() => {
    jest.isolateModules(() => require('../src/routes/analyticsRoutes'));
  });

  it('allows all school analytics roles', () => {
    const { requireSchoolAuth } = require('../src/middleware/auth');
    expect(requireSchoolAuth).toHaveBeenCalledWith(['owner', 'staff', 'read_only']);
  });

  it('authenticates before resolving school state', () => {
    expect(mockRouter.use.mock.calls.map(([middleware]) => middleware)).toEqual([
      mockSchoolAuth,
      mockResolveSchool,
    ]);
  });

  it.each([
    '/summary',
    '/volume-trend',
    '/class-completion',
    '/unpaid-cohorts',
  ])('protects %s behind the shared middleware chain', (path) => {
    expect(mockRouter.get).toHaveBeenCalledWith(path, expect.any(Function));
  });
});
