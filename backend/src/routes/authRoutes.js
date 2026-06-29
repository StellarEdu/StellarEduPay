'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { handleLogin, handleRefresh, handleLogout, handleMe, handleListSessions, handleRevokeSession } = require('../controllers/authController');
const {
  setupMfa, verifyAndEnableMfa, disableMfa,
  setupUserMfa, verifyAndEnableUserMfa, disableUserMfa,
} = require('../controllers/mfaController');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');

const router = express.Router();

// ── Login rate limiter (IP-based, per-account lockout handled in controller) ──
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMIT_EXCEEDED' },
});

// ── Core auth routes ──────────────────────────────────────────────────────────
router.post('/login', loginLimiter, handleLogin);
router.post('/refresh', handleRefresh);
router.post('/logout', handleLogout);
router.get('/me', requireAdminAuth, handleMe);

// ── Session management ────────────────────────────────────────────────────────
router.get('/sessions', requireAdminAuth, handleListSessions);
router.delete('/sessions/:sessionId', requireAdminAuth, handleRevokeSession);

// ── School-level TOTP / MFA routes (require super-admin auth) ────────────────
router.post('/mfa/setup',   requireAdminAuth, setupMfa);
router.post('/mfa/verify',  requireAdminAuth, verifyAndEnableMfa);
router.post('/mfa/disable', requireAdminAuth, disableMfa);

// ── User-level TOTP / MFA routes (any authenticated user) ────────────────────
router.post('/mfa/user/setup',   requireSchoolAuth(), setupUserMfa);
router.post('/mfa/user/verify',  requireSchoolAuth(), verifyAndEnableUserMfa);
router.post('/mfa/user/disable', requireSchoolAuth(), disableUserMfa);

module.exports = router;
