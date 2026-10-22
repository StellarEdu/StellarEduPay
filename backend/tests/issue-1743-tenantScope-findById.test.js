'use strict';

/**
 * Tests for issue #1743:
 *
 * The tenantScope plugin throws TenantScopeError on every findById /
 * findByIdAndUpdate call because Mongoose implements them as
 * findOne({ _id }) / findOneAndUpdate({ _id }, ...) — neither filter has a
 * schoolId key, so the plugin's pre-hook fires and throws.
 *
 * This test loads every tenant-scoped model against a real in-memory MongoDB
 * instance (mongodb-memory-server) and asserts the documented behaviour:
 *
 *   1. findById throws TenantScopeError (code: TENANT_SCOPE_MISSING)
 *   2. findByIdAndUpdate throws TenantScopeError
 *   3. findOne({ _id, schoolId }) succeeds and returns the document
 *   4. findOneAndUpdate({ _id, schoolId }, ...) succeeds and returns the
 *      updated document
 *
 * The test does NOT mock Mongoose — it uses a real (in-memory) MongoDB
 * replica set so the plugin's pre-hooks actually run.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// ── Models under test (all tenant-scoped) ────────────────────────────────────
// Each model file calls schema.plugin(tenantScope, { modelName: '...' }).
// We require them to get the compiled Mongoose models.
const Payment = require('../src/models/paymentModel');
const Student = require('../src/models/studentModel');
const Refund = require('../src/models/refundModel');
const Dispute = require('../src/models/disputeModel');
const PaymentIntent = require('../src/models/paymentIntentModel');
const Receipt = require('../src/models/receiptModel');
const EmailDelivery = require('../src/models/emailDeliveryModel');
const PendingVerification = require('../src/models/pendingVerificationModel');
const PaymentPlan = require('../src/models/paymentPlanModel');
const FeeAdjustmentRule = require('../src/models/feeAdjustmentRuleModel');
const AuditLog = require('../src/models/auditLogModel');
const ReminderLog = require('../src/models/reminderLogModel');
const FeeStructure = require('../src/models/feeStructureModel');
const ReconciliationReport = require('../src/models/reconciliationReportModel');
const StudentFeeHistory = require('../src/models/studentFeeHistoryModel');

// ── Minimal document factories ───────────────────────────────────────────────
// Each factory creates a document with just enough required fields to pass
// Mongoose validation. Additional fields are added as needed by each model's
// schema.

const SCHOOL_ID = 'SCH-TEST-1743';

const baseDoc = { schoolId: SCHOOL_ID };

const docFactories = {
  Payment: () => ({
    ...baseDoc,
    studentId: 'STU001',
    txHash: 'txhash-payment-1743',
    amount: 100,
  }),
  Student: () => ({
    ...baseDoc,
    studentId: 'STU001',
    name: 'Test Student',
    class: 'Grade 1',
    feeAmount: 250,
  }),
  Refund: () => ({
    ...baseDoc,
    originalTxHash: 'txhash-refund-1743',
    studentId: 'STU001',
    amount: 50,
    status: 'pending',
    reason: 'test refund reason',
    initiatedBy: { userId: 'user-1', displayName: 'Tester' },
  }),
  Dispute: () => ({
    ...baseDoc,
    txHash: 'txhash-dispute-1743',
    studentId: 'STU001',
    raisedBy: 'Test Parent',
    reason: 'test dispute',
    status: 'open',
  }),
  PaymentIntent: () => ({
    ...baseDoc,
    studentId: 'STU001',
    amount: 100,
    memo: 'STU001',
    expiresAt: new Date(Date.now() + 86400000),
  }),
  Receipt: () => ({
    ...baseDoc,
    txHash: 'txhash-receipt-1743',
    studentId: 'STU001',
    amount: 100,
    confirmedAt: new Date(),
  }),
  EmailDelivery: () => ({
    ...baseDoc,
    studentId: 'STU001',
    provider: 'generic',
    providerMessageId: 'msg-1743',
    type: 'reminder',
    status: 'sent',
  }),
  PendingVerification: () => ({
    ...baseDoc,
    txHash: 'txhash-pending-1743',
    status: 'pending',
  }),
  PaymentPlan: () => ({
    ...baseDoc,
    studentId: 'STU001',
    totalAmount: 200,
    installments: [{ amount: 100, dueDate: new Date(Date.now() + 86400000) }],
  }),
  FeeAdjustmentRule: () => ({
    ...baseDoc,
    name: 'test-rule',
    type: 'discount_fixed',
    value: 10,
  }),
  AuditLog: () => ({
    ...baseDoc,
    action: 'test_action',
    performedBy: 'tester',
    targetId: 'target-1',
    targetType: 'student',
  }),
  ReminderLog: () => ({
    ...baseDoc,
    studentId: 'STU001',
    windowStart: new Date(),
    status: 'sent',
  }),
  FeeStructure: () => ({
    ...baseDoc,
    className: 'Grade 1',
    feeAmount: 250,
  }),
  ReconciliationReport: () => ({
    ...baseDoc,
    reportedAt: new Date(),
    dbTotalCredited: 1000,
    chainTotalReceived: 1000,
    drift: 0,
    driftPercentage: 0,
    threshold: 1,
  }),
  StudentFeeHistory: () => ({
    ...baseDoc,
    studentId: 'STU001',
    category: 'tuition',
    amount: 100,
  }),
};

// ── Test setup / teardown ─────────────────────────────────────────────────────

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// Clean all collections between test suites to avoid duplicate-key errors.
beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// Dynamically generate a describe block per tenant-scoped model.
const modelEntries = [
  ['Payment', Payment],
  ['Student', Student],
  ['Refund', Refund],
  ['Dispute', Dispute],
  ['PaymentIntent', PaymentIntent],
  ['Receipt', Receipt],
  ['EmailDelivery', EmailDelivery],
  ['PendingVerification', PendingVerification],
  ['PaymentPlan', PaymentPlan],
  ['FeeAdjustmentRule', FeeAdjustmentRule],
  ['AuditLog', AuditLog],
  ['ReminderLog', ReminderLog],
  ['FeeStructure', FeeStructure],
  ['ReconciliationReport', ReconciliationReport],
  ['StudentFeeHistory', StudentFeeHistory],
];

for (const [modelName, Model] of modelEntries) {
  describe(`#${modelName} (tenant-scoped) — #1743 findById behaviour`, () => {
    let createdDoc;

    beforeEach(async () => {
      const factory = docFactories[modelName];
      const doc = new Model(factory());
      createdDoc = await doc.save();
    });

    it('throws TenantScopeError on findById (no schoolId in filter)', async () => {
      await expect(Model.findById(createdDoc._id)).rejects.toThrow(
        /missing required "schoolId"/
      );
    });

    it('findById error has code TENANT_SCOPE_MISSING', async () => {
      try {
        await Model.findById(createdDoc._id);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe('TENANT_SCOPE_MISSING');
        expect(err.modelName).toBe(modelName);
      }
    });

    it('throws TenantScopeError on findByIdAndUpdate (no schoolId in filter)', async () => {
      await expect(
        Model.findByIdAndUpdate(createdDoc._id, { $set: { _touched: true } })
      ).rejects.toThrow(/missing required "schoolId"/);
    });

    it('findOne({ _id, schoolId }) returns the document', async () => {
      const found = await Model.findOne({ _id: createdDoc._id, schoolId: SCHOOL_ID });
      expect(found).not.toBeNull();
      expect(found._id.toString()).toBe(createdDoc._id.toString());
      expect(found.schoolId).toBe(SCHOOL_ID);
    });

    it('findOneAndUpdate({ _id, schoolId }, ...) succeeds', async () => {
      const updated = await Model.findOneAndUpdate(
        { _id: createdDoc._id, schoolId: SCHOOL_ID },
        { $set: { _testField: 'updated' } },
        { new: true }
      );
      expect(updated).not.toBeNull();
      expect(updated._id.toString()).toBe(createdDoc._id.toString());
      expect(updated._testField).toBe('updated');
    });

    it('findOne({ _id, schoolId: "WRONG" }) returns null (cross-tenant isolation)', async () => {
      const found = await Model.findOne({ _id: createdDoc._id, schoolId: 'SCH-OTHER' });
      expect(found).toBeNull();
    });
  });
}
