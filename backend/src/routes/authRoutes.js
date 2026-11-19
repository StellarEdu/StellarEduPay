'use strict';

const express = require('express');
const { rl } = require('../middleware/rateLimiter');
const { handleLogin, handleRefresh, handleLogout, handleMe, handleListSessions, handleRevokeSession, handleChangePassword } = require('../controllers/authController');
const {
  setupUserMfa, verifyAndEnableUserMfa, disableUserMfa,
} = require('../controllers/mfaController');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

const router = express.Router();

// ── Login rate limiter (IP-based, per-account lockout handled in controller) ──
// Uses Redis-backed storage shared across replicas when REDIS_HOST is configured.
const loginLimiter = rl(
  15 * 60 * 1000,
  10,
  { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMIT_EXCEEDED' }
);

// #1945 — refresh and logout were unthrottled. Refresh costs a store lookup per
// call and can be flooded with random tokens, so both get a per-IP limit. The
// explicit `name` keeps this counter separate from other limiters in Redis.
const sessionLimiter = rl(
  60 * 1000,
  60,
  { error: 'Too many requests, please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
  { name: 'auth:session' }
);

// ── Core auth routes ──────────────────────────────────────────────────────────
// login / logout / refresh are public or semi-public — no auditContext (no
// authenticated actor yet at the time they run). The controllers themselves
// call logAudit with their own context when needed.
router.post('/login', loginLimiter, handleLogin);
router.post('/refresh', sessionLimiter, handleRefresh);
router.post('/logout', sessionLimiter, handleLogout);
// #1769 — /me must work for every authenticated role (school owners, staff,
// read_only), not just super-admins; the frontend derives schoolId/roles here.
router.get('/me', requireSchoolAuth(), handleMe);

// ── Password management ───────────────────────────────────────────────────────
// #1360 — Changing the password immediately invalidates all existing sessions
// so stolen refresh tokens cannot outlive a password reset.
router.post('/change-password', requireSchoolAuth(), auditContext, handleChangePassword);

// ── Session management ────────────────────────────────────────────────────────
// #1769 — session management is scoped to the caller (any authenticated user);
// super-admins may still revoke any session (enforced in the controller).
router.get('/sessions', requireSchoolAuth(), handleListSessions);
// #1554 — session revocation changes auth state; attribute the actor.
router.delete('/sessions/:sessionId', requireSchoolAuth(), auditContext, handleRevokeSession);

// #1946 — The school-level MFA endpoints (/mfa/setup, /mfa/verify,
// /mfa/disable, /mfa/backup-codes/regenerate) were removed. They managed a
// shared per-school TOTP secret and authenticated backup-code regeneration with
// one process-wide password. Per-user MFA below is the only supported path.

// ── User-level TOTP / MFA routes (any authenticated user) ────────────────────
router.post('/mfa/user/setup',   requireSchoolAuth(), auditContext, setupUserMfa);
router.post('/mfa/user/verify',  requireSchoolAuth(), auditContext, verifyAndEnableUserMfa);
router.post('/mfa/user/disable', requireSchoolAuth(), auditContext, disableUserMfa);

module.exports = router;
