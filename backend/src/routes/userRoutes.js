'use strict';

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { rl, RL_MSG } = require('../middleware/rateLimiter');
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

// Length, byte-size and content rules live in utils/passwordPolicy so every
// entrypoint returns the same structured codes. Joi only bounds the input size.
const setPasswordSchema = Joi.object({
  token: Joi.string().trim().max(512).required(),
  password: Joi.string().max(1024).required(),
});

const requestPasswordResetSchema = Joi.object({
  email: emailField,
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().trim().max(512).required(),
  password: Joi.string().max(1024).required(),
});

// ── Rate limiters ──────────────────────────────────────────────────────────────
// Per-IP limits for credential endpoints. rl() takes (windowMs, max, message,
// opts); the earlier object form left `max` undefined, so these never blocked.
// Fixed in the password-policy change (#1948).
const setPasswordLimiter = rl(15 * 60 * 1000, 10, RL_MSG, { name: 'users:set-password' });
const resetPasswordLimiter = rl(15 * 60 * 1000, 10, RL_MSG, { name: 'users:reset-password' });

// Reset requests: 20 per hour per IP, plus 5 per hour per email address.
const requestResetIpLimiter = rl(60 * 60 * 1000, 20, RL_MSG, { name: 'users:reset-request-ip' });
const requestResetEmailLimiter = rl(60 * 60 * 1000, 5, RL_MSG, {
  name: 'users:reset-request-email',
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