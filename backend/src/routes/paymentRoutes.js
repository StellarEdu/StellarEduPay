"use strict";

const express = require("express");
const router = express.Router();

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
  reviewSuspiciousPayment,
  streamPaymentEvents,
  initiatePaymentRefund,
  approvePaymentRefund,
  getPaymentRefunds,
  getSchoolRefunds,
  verifyReceipt,
  getReconciliationReports,
  generateSchoolReconciliationReport,
  correctPlaceholderPayment,
} = require('../controllers/paymentAdminController');

const {
  validateStudentIdParam,
  validateTxHashParam,
  validateCreatePaymentIntent,
  validateVerifyPayment,
  validateSubmitTransaction,
} = require("../middleware/validate");
const { resolveSchool } = require("../middleware/schoolContext");
const idempotencyMiddleware = require("../middleware/idempotency");
const { requireAdminAuth, requireSchoolAuth } = require("../middleware/auth");
const { auditContext } = require("../middleware/auditContext");
const { strictLimiter, verifyLimiter } = require("../middleware/rateLimiter");

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

// Validation runs BEFORE resolveSchool so missing-school requests still get
// proper 400 validation errors when the body itself is invalid.
router.post(
  "/intent",
  validateCreatePaymentIntent,
  idempotency,
  resolveSchool,
  createPaymentIntent,
);
router.post(
  "/submit",
  validateSubmitTransaction,
  resolveSchool,
  submitTransaction,
);

// All remaining routes require school context
router.use(resolveSchool);

// Payment read endpoints now require authentication (Issue #1040)
router.get("/", requireSchoolAuth(), getAllPayments);
router.get("/summary", requireSchoolAuth(), getPaymentSummary);
router.get("/accepted-assets", requireSchoolAuth(), getAcceptedAssets);
router.get("/limits", requireSchoolAuth(), getPaymentLimitsEndpoint);
router.get("/sync/status", requireSchoolAuth(), getSyncStatus);
router.get("/events", requireSchoolAuth(), streamPaymentEvents);
router.get("/overpayments", requireSchoolAuth(), getOverpayments);
router.get("/suspicious", requireSchoolAuth(), getSuspiciousPayments);
router.get("/pending", requireSchoolAuth(), getPendingPayments);
router.get("/stuck", requireAdminAuth, getStuckPayments);
router.get("/retry-queue", requireAdminAuth, getRetryQueue);
router.get("/rates", requireSchoolAuth(), getExchangeRates);
router.get("/dlq", requireSchoolAuth(), getDeadLetterJobs);

router.post(
  "/verify",
  verifyLimiter,
  idempotency,
  validateVerifyPayment,
  verifyPayment,
);
router.post("/sync", strictLimiter, requireAdminAuth, auditContext, syncAllPayments);
router.post("/finalize", requireAdminAuth, auditContext, finalizePayments);
router.post("/dlq/:id/retry", requireSchoolAuth(), retryDeadLetterJob);

router.get("/balance/:studentId", validateStudentIdParam, requireSchoolAuth(), getStudentBalance);
router.get(
  "/instructions/:studentId",
  validateStudentIdParam,
  getPaymentInstructions,
);
router.get("/receipt/:txHash", generateReceipt);
router.get("/queue/:txHash", requireSchoolAuth(), getQueueJobStatus);
router.get("/:studentId", validateStudentIdParam, requireSchoolAuth(), getStudentPayments);

router.post("/:paymentId/lock", requireSchoolAuth(), lockPaymentForUpdate);
router.post("/:paymentId/unlock", requireSchoolAuth(), unlockPayment);

router.patch("/:txHash/status", requireAdminAuth, auditContext, updatePaymentStatus);
router.patch("/:txHash/suspicion-review", requireAdminAuth, auditContext, reviewSuspiciousPayment);
router.patch("/:txHash/correct-placeholder", requireAdminAuth, auditContext, correctPlaceholderPayment);

router.post("/:txHash/refund", requireAdminAuth, auditContext, initiatePaymentRefund);
router.post("/refunds/:refundId/approve", requireAdminAuth, auditContext, approvePaymentRefund);
router.get("/:txHash/refunds", getPaymentRefunds);
router.get("/refunds/school/list", requireAdminAuth, getSchoolRefunds);

router.get("/verify/:receiptId", verifyReceipt);

router.get("/reconciliation/reports", requireAdminAuth, getReconciliationReports);
router.post("/reconciliation/report", requireAdminAuth, auditContext, generateSchoolReconciliationReport);

module.exports = router;
