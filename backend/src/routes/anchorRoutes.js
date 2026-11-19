'use strict';

/**
 * Anchor Routes (Issue #1571, hardened in Issue #1953)
 *
 * Public-facing routes that enable the SEP-24 "Pay with bank / mobile money"
 * flow for parents.  School context is required so the correct anchor
 * configuration is resolved.
 *
 * GET  /api/anchor/anchors              — list enabled anchors for the school
 * POST /api/anchor/initiate             — start a SEP-24 interactive deposit
 * GET  /api/anchor/status/:anchorTxId   — poll anchor deposit status
 *
 * Hardening (Issue #1953):
 *  - `POST /initiate` and `GET /status/:anchorTxId` require a valid pay
 *    context: a pay-link token or parent-portal token, or (for anonymous use)
 *    a CAPTCHA / proof-of-work proof.
 *  - Per-IP and per-school rate limiters throttle the outbound-work endpoints
 *    so the backend cannot be used for SSRF amplification or to burn the
 *    anchor's rate limits.
 */

const express = require('express');
const router = express.Router();
const { listAnchors, initiateDeposit, getDepositStatus } = require('../controllers/anchorController');
const { resolveSchool } = require('../middleware/schoolContext');
const { rl } = require('../middleware/rateLimiter');
const { requirePayContext } = require('../middleware/payContext');

// All anchor routes need school context so the right anchor config is used.
// `resolveSchool` must run first so the per-school limiter can key off it.
router.use(resolveSchool);

// Per-IP limiter: 10 requests / minute. 100 rapid calls from one IP will
// therefore return 429 after the limit.
const anchorIpLimiter = rl({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `anchor:ip:${req.ip}`,
  message: 'Too many anchor requests from this IP, please try again later.',
});

// Per-school limiter: 20 requests / minute across all IPs for a school.
const anchorSchoolLimiter = rl({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const schoolId =
      (req.school && (req.school.id || req.school._id)) ||
      (req.schoolContext && (req.schoolContext.id || req.schoolContext._id)) ||
      req.schoolId ||
      'unknown';
    return `anchor:school:${schoolId}`;
  },
  message: 'Too many anchor requests for this school, please try again later.',
});

// Outbound-work endpoints: throttle per IP and per school, and require a
// valid pay context (pay-link token / parent-portal token / CAPTCHA or PoW).
const outboundGuards = [
  anchorIpLimiter,
  anchorSchoolLimiter,
  requirePayContext,
];

// Listing anchors is cheap and read-only; keep it public but still throttled
// per IP to avoid enumeration abuse.
router.get('/anchors', anchorIpLimiter, listAnchors);

router.post('/initiate', ...outboundGuards, initiateDeposit);
router.get('/status/:anchorTxId', ...outboundGuards, getDepositStatus);

module.exports = router;