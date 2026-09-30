'use strict';

const express = require('express');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');

const {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  submitTransaction,
  verifyTransactionHash,
} = require('../controllers/paymentController');

const {
  getAcceptedAssets,
  getPaymentLimitsEndpoint,
  getStudentPayments,
  getAllPayments,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
  getExchangeRates,
  getPaymentSummary,
} = require('../controllers/paymentQueryController');

const {
  syncAllPayments,
  getSyncStatus,
  finalizePayments,
  generateReceipt,
  lockPaymentForUpdate,
  unlockPayment,
  getDeadLetterJobs,
  retryDeadLetterJob,
  getQueueJobStatus,
  getStuckPayments,
  updatePaymentStatus,
  bulkUpdatePaymentStatus,
  reviewSuspiciousPayment,
  streamPaymentEvents,
  initiatePaymentRefund,
  approvePaymentRefund,
  rejectPaymentRefund,
  completePaymentRefund,
  getPaymentRefunds,
  getSchoolRefunds,
  verifyReceipt,
  getReconciliationReports,
  generateSchoolReconciliationReport,
  correctPlaceholderPayment,
} = require('../controllers/paymentAdminController');

const {
  validateStudentIdParam,
  validatePaymentInstructionsQuery,
  validateTxHashParam,
  validateCreatePaymentIntent,
  validateVerifyPayment,
  validateSubmitTransaction,
} = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');
const idempotencyMiddleware = require('../middleware/idempotency');
const { auditContext } = require('../middleware/auditContext');
const { strictLimiter, verifyLimiter, syncLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Idempotency middleware for critical payment endpoints that must fail-closed
// when the datastore becomes unreachable to prevent duplicate submissions.
const idempotency = idempotencyMiddleware({ criticalPaymentEndpoints: true });

/**
 * @swagger
 * /api/payments/instructions/{studentId}:
 *   get:
 *     summary: Get payment instructions for a student
 *     operationId: getPaymentInstructions
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Student ID
 *       - in: query
 *         name: feeCategory
 *         required: false
 *         schema:
 *           type: string
 *           maxLength: 100
 *           pattern: '^[A-Za-z0-9_-]+$'
 *         description: Restrict the instructions to a single fee category
 *     responses:
 *       200:
 *         description: Payment instructions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 walletAddress:
 *                   type: string
 *                 memo:
 *                   type: string
 *                 acceptedAssets:
 *                   type: array
 *       400:
 *         description: VALIDATION_ERROR - feeCategory is malformed
 *       404:
 *         description: Student not found
 */

/**
 * @swagger
 * /api/payments/verify:
 *   post:
 *     summary: Verify a payment transaction
 *     operationId: verifyPayment
 *     tags:
 *       - Payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               txHash:
 *                 type: string
 *                 description: Stellar transaction hash
 *     responses:
 *       200:
 *         description: Payment verified
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Payment'
 *       400:
 *         description: Invalid transaction
 */

/**
 * @swagger
 * /api/payments/receipts/{receiptId}/verify:
 *   get:
 *     summary: Verify the authenticity of a payment receipt
 *     operationId: verifyReceipt
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: receiptId
 *         required: true
 *         schema:
 *           type: string
 *         description: Receipt ID embedded in the printed/emailed receipt
 *     responses:
 *       200:
 *         description: Receipt verification result
 *       404:
 *         description: Receipt not found
 */

/**
 * @swagger
 * /api/payments/sync:
 *   post:
 *     summary: Sync payments from Stellar blockchain
 *     operationId: syncAllPayments
 *     tags:
 *       - Payments
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Sync completed
 *       401:
 *         description: Unauthorized
 */

// No school context required
router.get("/verify/:txHash", validateTxHashParam, verifyLimiter, verifyTransactionHash);

// Receipt verification lives on a distinct path so it is not shadowed by
// "/verify/:txHash" above (which rejects non-hash params with 400).
router.get("/receipts/:receiptId/verify", verifyReceipt);

// Validation runs BEFORE resolveSchool so missing-school requests still get
// proper 400 validation errors when the body itself is invalid.
// resolveSchool runs BEFORE idempotency so schoolId is available for tenant-scoped
// idempotency keys, preventing cross-tenant intent replay (#1522).
router.post(
  "/intent",
  validateCreatePaymentIntent,
  resolveSchool,
  idempotency,
  createPaymentIntent,
);
// /submit is a public relay for signed payment transactions. It is rate-limited
// per IP and per school, and idempotent (keyed by tx hash when no header is
// supplied) so client retries cannot cause duplicate processing (#1561).
router.post(
  "/submit",
  strictLimiter,
  validateSubmitTransaction,
  resolveSchool,
  idempotency,
  submitTransaction,
);

// All remaining routes require school context
router.use(resolveSchool);

// Payment read endpoints require authentication
router.get("/", requireSchoolAuth(['owner', 'staff', 'read_only']), getAllPayments);
router.get("/summary", requireSchoolAuth(['owner', 'staff', 'read_only']), getPaymentSummary);
router.get("/accepted-assets", requireSchoolAuth(['owner', 'staff', 'read_only']), getAcceptedAssets);
router.get("/limits", requireSchoolAuth(['owner', 'staff', 'read_only']), getPaymentLimitsEndpoint);
router.get("/sync/status", requireSchoolAuth(['owner', 'staff', 'read_only']), getSyncStatus);
router.get("/events", requireSchoolAuth(['owner', 'staff', 'read_only']), streamPaymentEvents);
router.get("/overpayments", requireSchoolAuth(['owner', 'staff', 'read_only']), getOverpayments);
router.get("/suspicious", requireSchoolAuth(['owner', 'staff', 'read_only']), getSuspiciousPayments);
router.get("/pending", requireSchoolAuth(['owner', 'staff', 'read_only']), getPendingPayments);
router.get("/stuck", requireSchoolAuth(['owner', 'staff']), getStuckPayments);
router.get("/retry-queue", requireSchoolAuth(['owner', 'staff']), getRetryQueue);
router.get("/rates", requireSchoolAuth(['owner', 'staff', 'read_only']), getExchangeRates);
router.get("/dlq", requireSchoolAuth(['owner', 'staff']), getDeadLetterJobs);

router.post(
  "/verify",
  verifyLimiter,
  idempotency,
  validateVerifyPayment,
  verifyPayment,
);
// syncLimiter runs after auth: it keys on req.schoolId populated by auth
router.post("/sync", strictLimiter, requireSchoolAuth(['owner', 'staff']), syncLimiter, auditContext, syncAllPayments);
router.post("/finalize", requireSchoolAuth(['owner', 'staff']), auditContext, finalizePayments);
router.post("/dlq/:id/retry", requireSchoolAuth(['owner', 'staff']), auditContext, retryDeadLetterJob);

router.get("/balance/:studentId", validateStudentIdParam, requireSchoolAuth(['owner', 'staff', 'read_only']), getStudentBalance);
router.get(
  "/instructions/:studentId",
  validateStudentIdParam,
  validatePaymentInstructionsQuery,
  getPaymentInstructions,
);
router.get("/receipt/:txHash", generateReceipt);
router.get("/queue/:txHash", requireSchoolAuth(['owner', 'staff', 'read_only']), getQueueJobStatus);
router.get("/:studentId", validateStudentIdParam, requireSchoolAuth(['owner', 'staff', 'read_only']), getStudentPayments);

router.post("/:paymentId/

/* … truncated 1838 chars — edit only what you need near the top … */
