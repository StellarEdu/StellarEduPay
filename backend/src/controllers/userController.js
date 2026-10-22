'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const User = require('../models/userModel');
const config = require('../config');
const logger = require('../utils/logger').child('UserController');
const { logAudit } = require('../services/auditService');
const { sendEmail } = require('../services/emailService');
const { renderEmailTemplate } = require('../services/emailTemplateService');
const { revokeAllUserSessions } = require('../services/sessionStore');

// ── Password policy ────────────────────────────────────────────────────────────
const MIN_PASSWORD_LENGTH = 12;

function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { valid: true };
}

// ── Body validation schemas ────────────────────────────────────────────────────
const updateSchoolUserSchema = Joi.object({
  roles: Joi.array()
    .items(Joi.string().valid('owner', 'staff', 'read_only'))
    .min(1)
    .optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

const emailBodySchema = Joi.object({
  email: Joi.string().trim().lowercase().email().max(254).required(),
});

// ── Token generation and storage ───────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Public URL helper ──────────────────────────────────────────────────────────
function getAppUrl() {
  const baseUrl = (config && config.APP_URL) || process.env.APP_URL;
  if (!baseUrl) {
    // Should never happen in production (boot fails), but keep a safe fallback for dev/test.
    return 'http://localhost:3000';
  }
  return String(baseUrl).replace(/\/+$/, '');
}

// ── Session revocation helper ──────────────────────────────────────────────────
async function revokeUserSessions(userId) {
  const userIdStr = userId.toString();

  // Bump tokenVersion so any outstanding access tokens are rejected by the auth middleware.
  try {
    await User.findByIdAndUpdate(userIdStr, { $inc: { tokenVersion: 1 } });
  } catch (err) {
    logger.warn('[UserController] Failed to bump tokenVersion', { error: err.message, userId: userIdStr });
  }

  // Revoke refresh-token sessions and families.
  try {
    const authController = require('./authController');
    const store = authController.getStore?.() || null;
    if (store) {
      const refreshTTL = authController.parseTTL?.('JWT_REFRESH_TOKEN_TTL', 30 * 86400) || 30 * 86400;
      const sessions = await store.listUserSessions(userIdStr);
      await Promise.all(
        sessions.map(async ({ sessionId, familyId }) => {
          if (familyId) await store.revokeFamily(familyId, refreshTTL).catch(() => {});
          await store.delSession(sessionId).catch(() => {});
        })
      );
    }
  } catch (err) {
    logger.warn('[UserController] Failed to revoke sessions', { error: err.message, userId: userIdStr });
  }
}

// ── Email dispatch helper (async, non-blocking) ────────────────────────────────
function dispatchEmail(payload) {
  // Fire-and-forget: never await in the request path so latency is identical
  // regardless of whether the account exists.
  setImmediate(() => {
    Promise.resolve()
      .then(() => sendEmail(payload))
      .catch(err => {
        logger.warn('[UserController] Failed to send email', { error: err.message, to: payload?.to });
      });
  });
}

// ── Super-admin endpoints: /api/admin/users ────────────────────────────────────

async function createUser(req, res) {
  const { email, schoolId, roles } = req.body;

  if (!email || !schoolId || !roles || !Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({
      error: 'email, schoolId, and roles are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Validate roles
  const validRoles = ['super_admin', 'owner', 'staff', 'read_only'];
  const invalidRoles = roles.filter(r => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    return res.status(400).json({
      error: `Invalid roles: ${invalidRoles.join(', ')}`,
      code: 'INVALID_ROLES',
    });
  }

  // Check if user already exists
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({
      error: 'User with this email already exists.',
      code: 'USER_EXISTS',
    });
  }

  // Generate invitation token
  const invitationToken = generateToken();
  const invitationTokenHash = hashToken(invitationToken);
  const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Create user with temporary password (invitation flow)
  const tempPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

  const user = new User({
    email: normalizedEmail,
    passwordHash: tempPasswordHash,
    schoolId,
    roles,
    isActive: false, // inactive until password is set
    invitationToken: invitationTokenHash,
    invitationExpires,
  });

  await user.save();

  // Send invitation email
  const baseUrl = getAppUrl();
  const invitationLink = `${baseUrl}/set-password#token=${invitationToken}`;

  try {
    const { html, text, subject } = await renderEmailTemplate('invitation', {
      locale: user.emailLocale,
      roles,
      invitationLink,
      expiresInDays: 7,
    });
    dispatchEmail({ to: normalizedEmail, subject, html, text });
  } catch (err) {
    logger.warn('[UserController] Failed to render invitation email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId: req.admin?.schoolId || 'system',
    action: 'user_created',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail, schoolId, roles },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.status(201).json({
    message: 'User created. Invitation email sent.',
    userId: user._id,
    email: user.email,
    invitationExpires,
  });
}

async function listUsers(req, res) {
  const { schoolId, role, isActive } = req.query;

  const filter = {};
  if (schoolId) filter.schoolId = schoolId;
  if (role) filter.roles = role;
  if (isActive !== undefined) filter.isActive = isActive === 'true';

  const users = await User.find(filter).select('-passwordHash -invitationToken -resetToken').sort({ createdAt: -1 });

  return res.json({ users });
}

async function getUser(req, res) {
  const { userId } = req.params;

  const user = await User.findById(userId).select('-passwordHash -invitationToken -resetToken');
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  return res.json({ user });
}

async function updateUser(req, res) {
  const { userId } = req.params;
  const { roles, isActive } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  const updates = {};
  if (roles !== undefined) {
    const validRoles = ['super_admin', 'owner', 'staff', 'read_only'];
    const invalidRoles = roles.filter(r => !validRoles.includes(r));
    if (invalidRoles.length > 0) {
      return res.status(400).json({
        error: `Invalid roles: ${invalidRoles.join(', ')}`,
        code: 'INVALID_ROLES',
      });
    }
    updates.roles = roles;
  }
  if (isActive !== undefined) updates.isActive = isActive;

  await User.findByIdAndUpdate(userId, { $set: updates });

  // Any change to roles or isActive must revoke sessions immediately.
  if (updates.roles !== undefined || updates.isActive !== undefined) {
    await revokeUserSessions(userId);
  }

  // Deactivating a user must invalidate every existing session and refresh token.
  if (isActive === false) {
    await revokeAllUserSessions(userId);
  }

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'user_updated',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: userId,
    targetType: 'user',
    details: updates,
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User updated successfully.' });
}

async function deleteUser(req, res) {
  const { userId } = req.params;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  // Revoke sessions before deletion so outstanding tokens cannot be used.
  await revokeUserSessions(userId);

  await User.findByIdAndDelete(userId);

  // Deleting a user must invalidate every existing session and refresh token.
  await revokeAllUserSessions(userId);

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'user_deleted',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: userId,
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User deleted successfully.' });
}

// ── School-owner endpoints: /api/schools/:schoolId/users ───────────────────────

async function createSchoolUser(req, res) {
  const { schoolId } = req.params;
  const { email, roles } = req.body;

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only create users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  if (!email || !roles || !Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({
      error: 'email and roles are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // School owners cannot grant super_admin
  if (roles.includes('super_admin')) {
    return res.status(403).json({
      error: 'School owners cannot grant super_admin role.',
      code: 'FORBIDDEN',
    });
  }

  const validRoles = ['owner', 'staff', 'read_only'];
  const invalidRoles = roles.filter(r => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    return res.status(400).json({
      error: `Invalid roles for school users: ${invalidRoles.join(', ')}`,
      code: 'INVALID_ROLES',
    });
  }

  // Check if user already exists
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({
      error: 'User with this email already exists.',
      code: 'USER_EXISTS',
    });
  }

  // Generate invitation token
  const invitationToken = generateToken();
  const invitationTokenHash = hashToken(invitationToken);
  const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const tempPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

  const user = new User({
    email: normalizedEmail,
    passwordHash: tempPasswordHash,
    schoolId,
    roles,
    isActive: false,
    invitationToken: invitationTokenHash,
    invitationExpires,
  });

  await user.save();

  // Send invitation email
  const baseUrl = getAppUrl();
  const invitationLink = `${baseUrl}/set-password#token=${invitationToken}`;

  try {
    const { html, text, subject } = await renderEmailTemplate('invitation', {
      locale: user.emailLocale,
      roles,
      invitationLink,
      expiresInDays: 7,
    });
    dispatchEmail({ to: normalizedEmail, subject, html, text });
  } catch (err) {
    logger.warn('[UserController] Failed to render invitation email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId,
    action: 'user_created',
    performedBy: req.user?.userId || req.admin?.userId,
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail, schoolId, roles },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.status(201).json({
    message: 'User invited successfully.',
    userId: user._id,
    email: user.email,
    invitationExpires,
  });
}

async function listSchoolUsers(req, res) {
  const { schoolId } = req.params;

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only view users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  const users = await User.find({ schoolId }).select('-passwordHash -invitationToken -resetToken').sort({ createdAt: -1 });

  return res.json({ users });
}

async function updateSchoolUser(req, res) {
  const { schoolId, userId } = req.params;

  // Validate body
  const { value, error } = updateSchoolUserSchema.validate(req.body || {}, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({
      error: error.details.map(d => d.message).join('; '),
      code: 'VALIDATION_ERROR',
    });
  }

  const { roles, isActive } = value;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  // Ensure the user belongs to the school
  if (user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'User does not belong to this school.',
      code: 'FORBIDDEN',
    });
  }

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only manage users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  const requestingUserId = req.user?.userId || req.admin?.userId;
  const isSelf = requestingUserId && requestingUserId.toString() === userId.toString();

  // Forbid self-demotion and self-deactivation
  if (isSelf) {
    if (roles !== undefined && !roles.includes('owner')) {
      return res.status(409).json({
        error: 'You cannot remove your own owner role.',
        code: 'SELF_DEMOTION_FORBIDDEN',
      });
    }
    if (isActive === false) {
      return res.status(409).json({
        error: 'You cannot deactivate your own account.',
        code: 'SELF_DEACTIVATION_FORBIDDEN',
      });
    }
  }

  const updates = {};
  if (roles !== undefined) {
    // School owners cannot grant super_admin
    if (roles.includes('super_admin')) {
      return res.status(403).json({
        error: 'School owners cannot grant super_admin role.',
        code: 'FORBIDDEN',
      });
    }
    updates.roles = roles;
  }
  if (isActive !== undefined) updates.isActive = isActive;

  // Last-owner protection: refuse if the change would leave zero active owners.
  const removesOwnerRole = updates.roles !== undefined && !updates.roles.includes('owner');
  const deactivates = updates.isActive === false;
  const currentlyOwner = Array.isArray(user.roles) && user.roles.includes('owner');
  const currentlyActive = user.isActive === true;

  if (currentlyOwner && currentlyActive && (removesOwnerRole || deactivates)) {
    const activeOwnerCount = await User.countDocuments({
      schoolId,
      roles: 'owner',
      isActive: true,
    });
    if (activeOwnerCount <= 1) {
      return res.status(409).json({
        error: 'Cannot remove or deactivate the last active owner of the school.',
        code: 'LAST_OWNER',
      });
    }
  }

  await User.findByIdAndUpdate(userId, { $set: updates });

  // Any change to roles or isActive must revoke sessions immediately.
  if (updates.roles !== undefined || updates.isActive !== undefined) {
    await revokeUserSessions(userId);
  }

  // Deactivating a user must invalidate every existing session and refresh token.
  if (isActive === false) {
    await revokeAllUserSessions(userId);
  }

  await logAudit({
    schoolId,
    action: 'user_updated',
    performedBy: requestingUserId,
    targetId: userId,
    targetType: 'user',
    details: updates,
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User updated successfully.' });
}

// ── Password flows ─────────────────────────────────────────────────────────────

async function setPassword(req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: 'token and password are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const validation = validatePassword(password);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, code: 'WEAK_PASSWORD' });
  }

  const tokenHash = hashToken(token);
  const user = await User.findOne({
    invitationToken: tokenHash,
    invitationExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({
      error: 'Invalid or expired invitation token.',
      code: 'INVALID_TOKEN',
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.findByIdAndUpdate(user._id, {
    $set: { passwordHash, isActive: true },
    $unset: { invitationToken: '', invitationExpires: '' },
  });

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_set',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'Password set successfully. You can now log in.' });
}

async function requestPasswordReset(req, res) {
  const genericMessage = 'If an account exists with that email, a password reset link has been sent.';

  // Guard against non-string bodies and validate email format.
  const { value, error } = emailBodySchema.validate(req.body || {}, {
    abortEarly: true,
    stripUnknown: true,
  });
  if (error) {
    // Return the same generic response to avoid account enumeration.
    return res.json({ message: genericMessage });
  }

  const normalizedEmail = value.email;

  const user = await User.findOne({ email: normalizedEmail, isActive: true });

  if (!user) {
    // Generic response to avoid account enumeration.
    return res.json({ message: genericMessage });
  }

  // Generate reset token
  const resetToken = generateToken();
  const resetTokenHash = hashToken(resetToken);
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // Overwrite any existing reset token so only one is active at a time.
  await User.findByIdAndUpdate(user._id, {
    $set: {
      resetToken: resetTokenHash,
      resetExpires,
      resetRequestIp: req.ip,
    },
  });

  // Send reset email asynchronously so latency is identical for known/unknown accounts.
  const baseUrl = getAppUrl();
  const resetLink = `${baseUrl}/reset-password#token=${resetToken}`;

  try {
    const { html, text, subject } = await renderEmailTemplate('passwordReset', {
      locale: user.emailLocale,
      resetLink,
      expiresInMinutes: 60,
    });
    dispatchEmail({ to: normalizedEmail, subject, html, text });
  } catch (err) {
    logger.warn('[UserController] Failed to render password reset email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_reset_requested',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail, ip: req.ip },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: genericMessage });
}

async function resetPassword(req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: 'token and password are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const validation = validatePassword(password);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, code: 'WEAK_PASSWORD' });
  }

  const tokenHash = hashToken(token);
  const user = await User.findOne({
    resetToken: tokenHash,
    resetExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({
      error: 'Invalid or expired reset token.',
      code: 'INVALID_TOKEN',
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.findByIdAndUpdate(user._id, {
    $set: { passwordHash },
    $unset: { resetToken: '', resetExpires: '', resetRequestIp: '' },
  });

  // Revoke all existing sessions after a password reset.
  await revokeUserSessions(user._id);

  // A password reset is typically performed because the account is compromised:
  // every pre-existing session and refresh token must be revoked.
  await revokeAllUserSessions(user._id.toString());

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_reset',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
}

module.exports = {
  // Super-admin endpoints
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,

  // School-owner endpoints
  createSchoolUser,
  listSchoolUsers,
  updateSchoolUser,

  // Password flows
  setPassword,
  requestPasswordReset,
  resetPassword,
};