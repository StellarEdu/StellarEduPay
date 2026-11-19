'use strict';

/**
 * Account (user credential and membership) request schemas used by the
 * validate.js middleware.
 *
 * These mirror the schemas the live handlers enforce: the password schemas as
 * declared in routes/userRoutes.js, and updateSchoolUserSchema as declared in
 * controllers/userController.js. Keep them in step with those definitions.
 */

const Joi = require('joi');

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

const updateSchoolUserSchema = Joi.object({
  roles: Joi.array()
    .items(Joi.string().valid('owner', 'staff', 'read_only'))
    .min(1)
    .optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

module.exports = {
  setPasswordSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  updateSchoolUserSchema,
};
