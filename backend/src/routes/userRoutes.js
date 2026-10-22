'use strict';

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { rl } = require('../middleware/rateLimiter');
const {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  createSchoolUser,
  listSchoolUsers,
  updateSchoolUser,
  setPassword,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/userController');

// ── Body validation ────────────────────────────────────────────────────────────
function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid request body',
        details: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    return next();
  };
}

const emailField = Joi.string().trim().email().max(254).required();

const setPasswordSchema = Joi.object({
  token: Joi.string().trim().max(512).required(),
  password: Joi.string().min(8).max(128).required(),
});

const requestPasswordResetSchema = Joi.object({
  email: emailField,
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().trim().max(512).required(),
  password: Joi.string().min(8).max(128).required(),
});

// ── Rate limiters ──────────────────────────────────────────────────────────────
// Per-IP limits for credential endpoints.
const setPasswordLimiter = rl({ windowMs: 15 * 60 * 1000, max: 10 });
const resetPasswordLimiter = rl({ windowMs: 15 * 60 * 1000, max: 10 });

// Reset requests: 20 per hour per IP, plus 5 per hour per email address.
const requestResetIpLimiter = rl({ windowMs: 60 * 60 * 1000, max: 20 });
const requestResetEmailLimiter = rl({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const email = req.body && typeof req.body.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';
    return email ? `email:${email}` : null;
  },
});

// ── Super-admin endpoints ──────────────────────────────────────────────────────
router.post('/admin/users', requireAdminAuth, createUser);
router.get('/admin/users', requireAdminAuth, listUsers);
router.get('/admin/users/:userId', requireAdminAuth, getUser);
router.patch('/admin/users/:userId', requireAdminAuth, updateUser);
router.delete('/admin/users/:userId', requireAdminAuth, deleteUser);

// ── School-owner endpoints ─────────────────────────────────────────────────────
router.post('/schools/:schoolId/users', requireSchoolAuth(['owner']), createSchoolUser);
router.get('/schools/:schoolId/users', requireSchoolAuth(['owner', 'staff', 'read_only']), listSchoolUsers);
router.patch('/schools/:schoolId/users/:userId', requireSchoolAuth(['owner']), updateSchoolUser);

// ── Public password flows ──────────────────────────────────────────────────────
router.post(
  '/users/set-password',
  setPasswordLimiter,
  validateBody(setPasswordSchema),
  setPassword
);
router.post(
  '/users/request-password-reset',
  requestResetIpLimiter,
  validateBody(requestPasswordResetSchema),
  requestResetEmailLimiter,
  requestPasswordReset
);
router.post(
  '/users/reset-password',
  resetPasswordLimiter,
  validateBody(resetPasswordSchema),
  resetPassword
);

module.exports = router;