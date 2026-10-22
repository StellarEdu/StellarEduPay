'use strict';

/**
 * Tests for issue #1810 — the staff dispute route must load, and a dispute must
 * only attach to the student that owns the payment.
 */

jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});
jest.mock('../src/models/paymentModel', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/disputeModel', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/studentModel', () => ({}));
jest.mock('../src/models/schoolModel', () => ({}));
jest.mock('../src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../src/services/sseService', () => ({ emit: jest.fn() }));
jest.mock('../src/services/webhookService', () => ({
  fireWebhook: jest.fn(),
  fireWebhookToEndpoints: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock('../src/utils/studentBalanceUpdater', () => ({ updateStudentBalance: jest.fn() }));
jest.mock('../src/metrics/disputeMetrics', () => ({
  recordDisputeRaised: jest.fn(),
  recordDisputeResolved: jest.fn(),
  refreshOpenDisputeGauge: jest.fn(),
}));

const Payment = require('../src/models/paymentModel');
const Dispute = require('../src/models/disputeModel');
const { flagDispute } = require('../src/controllers/dispute.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function disputeRequest(studentId) {
  return {
    schoolId: 'school-1',
    body: { txHash: 'abc', studentId, raisedBy: 'Parent', reason: 'Double charged' },
  };
}

describe('issue #1810 — dispute route and student matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Dispute.findOne.mockResolvedValue(null);
    Dispute.create.mockResolvedValue({ _id: 'd1', status: 'open', toObject: () => ({}) });
  });

  test('disputeRoutes module loads without a ReferenceError', () => {
    expect(() => require('../src/routes/disputeRoutes')).not.toThrow();
  });

  test('rejects a dispute whose studentId does not own the payment', async () => {
    Payment.findOne.mockResolvedValue({ txHash: 'abc', studentId: 'STU-AAAAAA', schoolId: 'school-1' });
    const res = mockRes();
    const next = jest.fn();

    await flagDispute(disputeRequest('STU-BBBBBB'), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(Dispute.create).not.toHaveBeenCalled();
  });

  test('does not reject when the studentId matches the payment owner', async () => {
    Payment.findOne.mockResolvedValue({ txHash: 'abc', studentId: 'STU-AAAAAA', schoolId: 'school-1' });
    const res = mockRes();
    const next = jest.fn();

    await flagDispute(disputeRequest('STU-AAAAAA'), res, next);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(Dispute.create).toHaveBeenCalledTimes(1);
  });
});
