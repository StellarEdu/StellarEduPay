'use strict';

const express = require('express');
const { rl } = require('../middleware/rateLimiter');
const { handleLogin, handleRefresh, handleLogout, handleMe, handleListSessions, handleRevokeSession, handleChangePassword } = require('../controllers/authController');
const {
  setupMfa, verifyAndEnableMfa, disableMfa, regenerateBackupCodes,
  setupUserMfa, verifyAndEnableUserMfa, disableUserMfa,
} = require('../controllers/mfaController');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');

const router = express.Router();

// ── Login rate limiter (IP-based, per-account lockout handled in controller) ──
// Uses Redis-backed storage shared across replicas when REDIS_HOST is configured.
const loginLimiter = rl(
  15 * 60 * 1000,
  10,
  { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMIT_EXCEEDED' }
);

// ── Core auth routes ──────────────────────────────────────────────────────────
router.post('/login', loginLimiter, handleLogin);
router.post('/refresh', handleRefresh);
router.post('/logout', handleLogout);
router.get('/me', requireAdminAuth, handleMe);

// ── Password management ───────────────────────────────────────────────────────
// #1360 — Changing the password immediately invalidates all existing sessions
// so stolen refresh tokens cannot outlive a password reset.
router.post('/change-password', requireSchoolAuth(), handleChangePassword);

// ── Session management ────────────────────────────────────────────────────────
router.get('/sessions', requireAdminAuth, handleListSessions);
router.delete('/sessions/:sessionId', requireAdminAuth, handleRevokeSession);

// ── School-level TOTP / MFA routes (require super-admin auth) ────────────────
router.post('/mfa/setup',   requireAdminAuth, setupMfa);
router.post('/mfa/verify',  requireAdminAuth, verifyAndEnableMfa);
router.post('/mfa/disable', requireAdminAuth, disableMfa);
router.post('/mfa/backup-codes/regenerate', requireAdminAuth, regenerateBackupCodes);

// ── User-level TOTP / MFA routes (any authenticated user) ────────────────────
router.post('/mfa/user/setup',   requireSchoolAuth(), setupUserMfa);
router.post('/mfa/user/verify',  requireSchoolAuth(), verifyAndEnableUserMfa);
router.post('/mfa/user/disable', requireSchoolAuth(), disableUserMfa);

module.exports = router;
