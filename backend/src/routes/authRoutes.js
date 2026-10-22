'use strict';

const express = require('express');
const { rl } = require('../middleware/rateLimiter');
const { handleLogin, handleRefresh, handleLogout, handleMe, handleListSessions, handleRevokeSession, handleChangePassword } = require('../controllers/authController');
const {
  setupMfa, verifyAndEnableMfa, disableMfa, regenerateBackupCodes,
  setupUserMfa, verifyAndEnableUserMfa, disableUserMfa,
} = require('../controllers/mfaController');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

const router = express.Router();

// ── Login rate limiter (IP-based, per-account lockout handled in controller) ──
// Uses Redis-backed storage shared across replicas when REDIS_HOST is configured.
const loginLimiter = rl(
  15 * 60 * 1000,
  10,
  { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMIT_EXCEEDED' }
);

// ── Core auth routes ──────────────────────────────────────────────────────────
// login / logout / refresh are public or semi-public — no auditContext (no
// authenticated actor yet at the time they run). The controllers themselves
// call logAudit with their own context when needed.
router.post('/login', loginLimiter, handleLogin);
router.post('/refresh', handleRefresh);
router.post('/logout', handleLogout);
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

// ── School-level TOTP / MFA routes (require super-admin auth) ────────────────
// #1554 — all MFA mutations (setup/verify/disable/backup) affect authentication
// state and must appear in the audit trail with the acting admin's identity.
router.post('/mfa/setup',   requireAdminAuth, auditContext, setupMfa);
router.post('/mfa/verify',  requireAdminAuth, auditContext, verifyAndEnableMfa);
router.post('/mfa/disable', requireAdminAuth, auditContext, disableMfa);
router.post('/mfa/backup-codes/regenerate', requireAdminAuth, auditContext, regenerateBackupCodes);

// ── User-level TOTP / MFA routes (any authenticated user) ────────────────────
router.post('/mfa/user/setup',   requireSchoolAuth(), auditContext, setupUserMfa);
router.post('/mfa/user/verify',  requireSchoolAuth(), auditContext, verifyAndEnableUserMfa);
router.post('/mfa/user/disable', requireSchoolAuth(), auditContext, disableUserMfa);

module.exports = router;
