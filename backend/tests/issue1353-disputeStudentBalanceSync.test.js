'use strict';

/**
 * Tests for Issue #1353 — DISPUTED payment status must be reflected in the
 * student's totalPaid/feePaid, and reversed when the dispute is rejected.
 */

let mockPaymentSave = jest.fn();
let mockPaymentDoc = null;
let mockPaymentFindOne = jest.fn();
let mockDisputeFindOne = jest.fn();
let mockDisputeFindOneAndUpdate = jest.fn();
let mockStudentFindOneAndUpdate = jest.fn();
let mockUpdateStudentBalance = jest.fn();

jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockPaymentFindOne(...args),
}));
jest.mock('../src/models/disputeModel', () => ({
  create: jest.fn(),
  findOne: (...args) => mockDisputeFindOne(...args),
  findOneAndUpdate: (...args) => mockDisputeFindOneAndUpdate(...args),
}));
jest.mock('../src/models/studentModel', () => ({
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
}));
jest.mock('../src/models/schoolModel', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/utils/studentBalanceUpdater', () => ({
  updateStudentBalance: (...args) => mockUpdateStudentBalance(...args),
}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/services/sseService', () => ({ emit: jest.fn() }));
jest.mock('../src/services/webhookService', () => ({
  fireWebhook: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { resolveDispute } = require('../src/controllers/dispute.controller');

function buildPayment(overrides = {}) {
  mockPaymentSave = jest.fn(function save() { return Promise.resolve(this); });
  mockPaymentDoc = {
    schoolId: 'school-1',
    txHash: 'tx-1',
    studentId: 'student-1',
    status: 'DISPUTED',
    $locals: {},
    save: mockPaymentSave,
    ...overrides,
  };
  return mockPaymentDoc;
}

function buildRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Issue #1353 — dispute resolution syncs student balance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('restores totalPaid by recalculating from payments when a dispute is rejected', async () => {
    const payment = buildPayment({ status: 'DISPUTED' });
    mockPaymentFindOne.mockResolvedValue(payment);
    mockDisputeFindOne.mockResolvedValue({ _id: 'd1', status: 'open', studentId: 'student-1', txHash: 'tx-1' });
    mockDisputeFindOneAndUpdate.mockResolvedValue({
      _id: 'd1', status: 'rejected', studentId: 'student-1', txHash: 'tx-1',
    });

    const req = {
      schoolId: 'school-1',
      user: { email: 'admin@school.test' },
      params: { id: 'd1' },
      body: { resolutionNote: 'Payment confirmed legitimate', status: 'rejected' },
    };
    const res = buildRes();
    const next = jest.fn();

    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.status).toBe('SUCCESS');
    expect(payment.$locals.adminOverride).toBe(true);
    expect(mockUpdateStudentBalance).toHaveBeenCalledWith('school-1', 'student-1');
  });

  it('excludes the payment from totalPaid when a dispute reopens to DISPUTED', async () => {
    const payment = buildPayment({ status: 'SUCCESS' });
    mockPaymentFindOne.mockResolvedValue(payment);
    mockDisputeFindOne.mockResolvedValue({ _id: 'd1', status: 'resolved', studentId: 'student-1', txHash: 'tx-1' });
    mockDisputeFindOneAndUpdate.mockResolvedValue({
      _id: 'd1', status: 'open', studentId: 'student-1', txHash: 'tx-1',
    });

    const req = {
      schoolId: 'school-1',
      user: { email: 'admin@school.test' },
      params: { id: 'd1' },
      body: { resolutionNote: 'Reopening for further review', status: 'open' },
    };
    const res = buildRes();
    const next = jest.fn();

    await resolveDispute(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(payment.status).toBe('DISPUTED');
    expect(mockUpdateStudentBalance).toHaveBeenCalledWith('school-1', 'student-1');
  });
});
