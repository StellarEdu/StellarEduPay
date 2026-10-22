'use strict';

/**
 * Parent self-service portal routes (#1637), mounted at /api/parent.
 *
 *   Parent (magic-link token in X-Parent-Token):
 *     GET  /me                                  balances, fees, payment plan, preferences
 *     GET  /students/:studentId/payments        payment history
 *     GET  /receipts/:txHash[?format=pdf]       receipt download
 *     POST /disputes                            raise a dispute on own payment
 *     PUT  /students/:studentId/preferences     reminder opt-in / opt-out
 *
 *   School staff (owner/staff JWT + school context):
 *     POST   /links                             issue (and optionally email) a link
 *     GET    /links                             list links
 *     DELETE /links/:tokenId                    revoke one link
 *     POST   /links/revoke-student/:studentId   revoke every link for a student
 */

const express = require('express');
const router = express.Router();

const { rl } = require('../middleware/rateLimiter');
const { requireParentAuth, requireLinkedStudent } = require('../middleware/parentAuth');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { validateTxHashParam, validateStudentIdParam } = require('../middleware/validate');
const ctrl = require('../controllers/parentPortalController');

// Per-IP limit on every parent request, so a leaked or guessed token cannot be
// used to hammer the API, plus a tighter limit on writes.
const parentReadLimiter = rl(
  60 * 1000,
  parseInt(process.env.PARENT_PORTAL_RATE_LIMIT, 10) || 60,
  { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'rl:parent' },
);
const parentWriteLimiter = rl(
  15 * 60 * 1000,
  10,
  { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'rl:parent-write' },
);

const staff = [resolveSchool, requireSchoolAuth(['owner', 'staff'])];
const staffRead = [resolveSchool, requireSchoolAuth(['owner', 'staff', 'read_only'])];

// ── Staff: link management (registered first so /links never hits parent auth)
router.post('/links', ...staff, auditContext, ctrl.createLink);
router.get('/links', ...staffRead, ctrl.listLinks);
router.delete('/links/:tokenId', ...staff, auditContext, ctrl.revokeLink);
router.post('/links/revoke-student/:studentId', ...staff, validateStudentIdParam, auditContext, ctrl.revokeStudentLinks);

// ── Parent
router.get('/me', parentReadLimiter, requireParentAuth, ctrl.getOverview);
router.get('/students/:studentId/payments', parentReadLimiter, requireParentAuth, requireLinkedStudent, ctrl.getPaymentHistory);
router.get('/receipts/:txHash', parentReadLimiter, requireParentAuth, validateTxHashParam, ctrl.getReceipt);
router.post('/disputes', parentReadLimiter, parentWriteLimiter, requireParentAuth, ctrl.raiseDispute);
router.put('/students/:studentId/preferences', parentReadLimiter, parentWriteLimiter, requireParentAuth, requireLinkedStudent, ctrl.updatePreferences);

module.exports = router;
