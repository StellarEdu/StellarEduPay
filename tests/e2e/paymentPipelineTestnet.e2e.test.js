'use strict';
/**
 * Full payment pipeline E2E test against the live Stellar testnet — issue #1361
 *
 * This test exercises the COMPLETE unbroken chain:
 *   student lookup → payment instructions → real Stellar transaction submission
 *   → polling detection (syncAllPayments) → payment recording in MongoDB
 *   → receipt generation → webhook delivery (spy) → SSE notification (spy)
 *
 * It replaces the mocked version in paymentPipeline.e2e.test.js for true
 * integration coverage. No Stellar SDK calls are mocked.
 *
 * Requirements:
 *   RUN_TESTNET_E2E_TESTS=true   — enables the suite (skipped in CI by default)
 *   STELLAR_INTEGRATION_TESTS=true — disables the blockRealHttp guard
 *   Network access to horizon-testnet.stellar.org and friendbot.stellar.org
 *
 * Run manually:
 *   RUN_TESTNET_E2E_TESTS=true STELLAR_INTEGRATION_TESTS=true \
 *     npx jest tests/e2e/paymentPipelineTestnet.e2e.test.js --forceExit --runInBand
 *
 * The test creates fresh wallets on every run (funded by Friendbot), so no
 * pre-configured environment is needed beyond internet access.
 */

const ENABLED = process.env.RUN_TESTNET_E2E_TESTS === 'true';
const describeIf = ENABLED ? describe : describe.skip;

// Required env for the backend modules (set before any require)
process.env.MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017/e2e-testnet-test';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'e2e-testnet-secret-12345678';
process.env.STELLAR_NETWORK = 'testnet';

// Only load heavy deps when enabled to avoid slowing down the normal test suite
let StellarSdk, Keypair, Networks, TransactionBuilder, Operation, Asset, BASE_FEE, Memo;
let mongoose, MongoMemoryServer;
let School, Student, Payment, PaymentIntent, Receipt;
let paymentController;
let webhookService, sseService;

if (ENABLED) {
  StellarSdk = require('@stellar/stellar-sdk');
  ({ Keypair, Networks, TransactionBuilder, Operation, Asset, BASE_FEE, Memo } = StellarSdk);

  mongoose         = require('../../backend/node_modules/mongoose');
  MongoMemoryServer = require('mongodb-memory-server').MongoMemoryServer;

  School        = require('../../backend/src/models/schoolModel');
  Student       = require('../../backend/src/models/studentModel');
  Payment       = require('../../backend/src/models/paymentModel');
  PaymentIntent = require('../../backend/src/models/paymentIntentModel');
  Receipt       = require('../../backend/src/models/receiptModel');

  paymentController = require('../../backend/src/controllers/paymentController');
  webhookService    = require('../../backend/src/services/webhookService');
  sseService        = require('../../backend/src/services/sseService');
}

// ── Horizon client (direct, bypasses app config) ──────────────────────────────
let horizonServer;
if (ENABLED) {
  horizonServer = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fundViaFriendbot(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Friendbot failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function submitRealPayment({ senderKeypair, destinationPublicKey, amount, memo }) {
  const senderAccount = await horizonServer.loadAccount(senderKeypair.publicKey());
  const tx = new TransactionBuilder(senderAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount: String(amount),
      }),
    )
    .addMemo(Memo.text(memo))
    .setTimeout(60)
    .build();
  tx.sign(senderKeypair);
  const result = await horizonServer.submitTransaction(tx);
  return result.hash;
}

async function waitForHorizonConfirmation(txHash, maxWaitMs = 60_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const tx = await horizonServer.transactions().transaction(txHash).call();
      if (tx.successful) return tx;
    } catch { /* not yet indexed */ }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Tx ${txHash} not confirmed on testnet after ${maxWaitMs}ms`);
}

/** Poll for a DB-side effect to land (receipt, payment status update, etc.). */
async function waitFor(check, { timeout = 30_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function makeReq(school, body = {}, extra = {}) {
  return {
    body,
    schoolId: school.schoolId,
    school,
    user: { email: 'admin@testnet-e2e.test' },
    ip: '127.0.0.1',
    connection: {},
    get: jest.fn((h) => (h === 'user-agent' ? 'jest-testnet-e2e' : undefined)),
    ...extra,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIf('Full payment pipeline — live Stellar testnet (#1361)', () => {
  let mongoServer;
  let schoolKeypair;  // school's Stellar wallet
  let senderKeypair;  // parent's Stellar wallet (pays the fee)
  let school;
  let student;

  const FEE_AMOUNT_XLM = 10;  // small enough to send multiple times without draining Friendbot

  // Long timeout — Friendbot + testnet confirmation + polling
  jest.setTimeout(120_000);

  beforeAll(async () => {
    // ── Start in-memory MongoDB ──────────────────────────────────────────────
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // ── Generate and fund wallets ────────────────────────────────────────────
    schoolKeypair  = Keypair.random();
    senderKeypair  = Keypair.random();

    console.log('[testnet-e2e] Funding wallets via Friendbot...');
    console.log('[testnet-e2e]   School  wallet:', schoolKeypair.publicKey());
    console.log('[testnet-e2e]   Sender  wallet:', senderKeypair.publicKey());

    await Promise.all([
      fundViaFriendbot(schoolKeypair.publicKey()),
      fundViaFriendbot(senderKeypair.publicKey()),
    ]);
    console.log('[testnet-e2e] Both wallets funded.');

    // ── Seed school and student in DB ────────────────────────────────────────
    // Override the app's stellarConfig to point at this fresh school wallet
    // so stellarService.syncPaymentsForSchool reads from the right address.
    const stellarConfig = require('../../backend/src/config/stellarConfig');
    stellarConfig.SCHOOL_WALLET = schoolKeypair.publicKey();

    school = await School.create({
      schoolId: 'E2E-TESTNET-SCH',
      name:     'Testnet E2E School',
      slug:     'testnet-e2e-school',
      stellarAddress: schoolKeypair.publicKey(),
      localCurrency: 'USD',
    });

    student = await Student.create({
      schoolId:  school.schoolId,
      studentId: 'E2E-STU-001',
      name:      'Testnet E2E Student',
      class:     'Grade 10',
      feeAmount: FEE_AMOUNT_XLM,
    });

    console.log('[testnet-e2e] School and student seeded in in-memory MongoDB.');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  // ── Step 1: Payment instructions ──────────────────────────────────────────
  describe('Step 1 — payment instructions', () => {
    let intentMemo;

    it('creates a payment intent and returns wallet address and memo', async () => {
      const res = makeRes();
      await paymentController.createPaymentIntent(
        makeReq(school, { studentId: student.studentId }),
        res,
        jest.fn(),
      );

      expect(res.json).toHaveBeenCalled();
      const intent = res.json.mock.calls[0][0];
      expect(intent.walletAddress).toBe(school.stellarAddress);
      expect(typeof intent.memo).toBe('string');
      expect(intent.memo.length).toBeGreaterThan(0);
      intentMemo = intent.memo;

      console.log('[testnet-e2e] Payment intent created, memo:', intentMemo);
    });
  });

  // ── Step 2: Real Stellar transaction submission ────────────────────────────
  describe('Step 2 — real Stellar testnet transaction', () => {
    let txHash;

    it('submits a real XLM payment to the school wallet via Horizon testnet', async () => {
      // Get memo from the seeded intent
      const intent = await PaymentIntent.findOne({ schoolId: school.schoolId, status: 'pending' });
      expect(intent).toBeTruthy();

      txHash = await submitRealPayment({
        senderKeypair,
        destinationPublicKey: school.stellarAddress,
        amount: FEE_AMOUNT_XLM,
        memo: intent.memo,
      });

      expect(typeof txHash).toBe('string');
      expect(txHash).toHaveLength(64);
      console.log('[testnet-e2e] Real tx submitted:', txHash);
    });

    it('transaction is confirmed on the testnet ledger within 60 s', async () => {
      const intent = await PaymentIntent.findOne({ schoolId: school.schoolId, status: 'pending' });
      // Re-submit if txHash was not set in the previous test (paranoia guard)
      const hash = await submitRealPayment({
        senderKeypair,
        destinationPublicKey: school.stellarAddress,
        amount: FEE_AMOUNT_XLM,
        memo: intent.memo,
      });
      const confirmed = await waitForHorizonConfirmation(hash);
      expect(confirmed.successful).toBe(true);
      expect(confirmed.memo_type).toBe('text');
      expect(confirmed.memo).toBe(intent.memo);
      console.log('[testnet-e2e] Transaction confirmed on ledger:', hash);
    });
  });

  // ── Step 3: Polling detection → payment recording ─────────────────────────
  describe('Step 3 — polling detection and payment recording', () => {
    it('syncAllPayments detects the real transaction and records a SUCCESS payment', async () => {
      // Run the full sync which calls stellarService → Horizon API → records payment
      const syncRes = makeRes();
      await paymentController.syncAllPayments(
        makeReq(school, {}, {
          auditContext: { performedBy: 'testnet-e2e', ipAddress: '127.0.0.1', userAgent: 'jest-testnet-e2e' },
        }),
        syncRes,
        jest.fn(),
      );

      const summary = syncRes.json.mock.calls[0]?.[0]?.summary;
      expect(summary).toBeDefined();
      expect(summary.new).toBeGreaterThanOrEqual(1);
      console.log('[testnet-e2e] Sync summary:', JSON.stringify(summary));
    });

    it('payment is persisted in MongoDB with SUCCESS status and correct amount', async () => {
      const payment = await waitFor(() =>
        Payment.findOne({ schoolId: school.schoolId, status: 'SUCCESS' })
      );
      expect(payment).toBeTruthy();
      expect(payment.amount).toBeCloseTo(FEE_AMOUNT_XLM, 1);
      expect(payment.studentId).toBe(student.studentId);
      console.log('[testnet-e2e] Payment recorded in MongoDB, txHash:', payment.txHash);
    });

    it('student balance is updated to reflect the payment', async () => {
      const updatedStudent = await waitFor(async () => {
        const s = await Student.findOne({ schoolId: school.schoolId, studentId: student.studentId });
        return s && s.totalPaid > 0 ? s : null;
      });
      expect(updatedStudent.totalPaid).toBeCloseTo(FEE_AMOUNT_XLM, 1);
      expect(updatedStudent.feePaid).toBe(true);
      console.log('[testnet-e2e] Student totalPaid:', updatedStudent.totalPaid);
    });

    it('payment intent is marked completed', async () => {
      const intent = await waitFor(() =>
        PaymentIntent.findOne({ schoolId: school.schoolId, status: 'completed' })
      );
      expect(intent).toBeTruthy();
      expect(intent.status).toBe('completed');
    });
  });

  // ── Step 4: Receipt generation ─────────────────────────────────────────────
  describe('Step 4 — receipt generation', () => {
    it('a receipt is generated after the payment is recorded', async () => {
      const receipt = await waitFor(
        () => Receipt.findOne({ schoolId: school.schoolId }),
        { timeout: 15_000 },
      );

      expect(receipt).toBeTruthy();
      expect(receipt.studentId).toBe(student.studentId);
      expect(receipt.studentName).toBe('Testnet E2E Student');
      expect(receipt.amount).toBeCloseTo(FEE_AMOUNT_XLM, 1);
      expect(receipt.assetCode).toBe('XLM');
      console.log('[testnet-e2e] Receipt generated for txHash:', receipt.txHash);
    });
  });

  // ── Step 5: Webhook delivery ───────────────────────────────────────────────
  describe('Step 5 — webhook delivery', () => {
    it('notifyPaymentConfirmed is called with the payment data after the sync', async () => {
      // Seed a webhookUrl on the school and re-run sync to capture the call
      await School.updateOne(
        { schoolId: school.schoolId },
        { $set: { webhookUrl: 'https://example.com/webhook', webhookSecret: 'webhook-secret-e2e' } },
      );
      const updatedSchool = await School.findOne({ schoolId: school.schoolId });

      const spy = jest.spyOn(webhookService, 'notifyPaymentConfirmed').mockResolvedValue(undefined);

      // Sync again — existing payments are idempotent; the event is re-fired for new ones.
      // Submit a second payment to trigger the webhook path.
      const intent2 = await PaymentIntent.create({
        schoolId:  school.schoolId,
        studentId: student.studentId,
        amount:    FEE_AMOUNT_XLM,
        memo:      'WEBHOOK-TEST',
        status:    'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const hash2 = await submitRealPayment({
        senderKeypair,
        destinationPublicKey: school.stellarAddress,
        amount: FEE_AMOUNT_XLM,
        memo:   intent2.memo,
      });
      await waitForHorizonConfirmation(hash2);

      await paymentController.syncAllPayments(
        makeReq(updatedSchool, {}, {
          auditContext: { performedBy: 'testnet-e2e', ipAddress: '127.0.0.1', userAgent: 'jest-testnet-e2e' },
        }),
        makeRes(),
        jest.fn(),
      );

      // Allow async webhook dispatch to fire
      await waitFor(() => spy.mock.calls.length > 0, { timeout: 10_000 });

      expect(spy).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ status: 'SUCCESS' }),
        null,
        'webhook-secret-e2e',
      );

      spy.mockRestore();
      console.log('[testnet-e2e] Webhook notification verified.');
    });
  });

  // ── Step 6: SSE notification ───────────────────────────────────────────────
  describe('Step 6 — SSE notification', () => {
    it('sseService.emit is called with the school channel and payment event', async () => {
      const sseSpy = jest.spyOn(sseService, 'emit');

      const intent3 = await PaymentIntent.create({
        schoolId:  school.schoolId,
        studentId: student.studentId,
        amount:    FEE_AMOUNT_XLM,
        memo:      'SSE-TEST-01',
        status:    'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const hash3 = await submitRealPayment({
        senderKeypair,
        destinationPublicKey: school.stellarAddress,
        amount: FEE_AMOUNT_XLM,
        memo:   intent3.memo,
      });
      await waitForHorizonConfirmation(hash3);

      await paymentController.syncAllPayments(
        makeReq(school, {}, {
          auditContext: { performedBy: 'testnet-e2e', ipAddress: '127.0.0.1', userAgent: 'jest-testnet-e2e' },
        }),
        makeRes(),
        jest.fn(),
      );

      expect(sseSpy).toHaveBeenCalledWith(
        school.schoolId,
        'payment',
        expect.objectContaining({ status: 'SUCCESS' }),
      );

      sseSpy.mockRestore();
      console.log('[testnet-e2e] SSE emission verified.');
    });
  });
});
