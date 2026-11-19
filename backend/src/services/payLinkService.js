'use strict';

/**
 * Signed per-student pay links (#1937).
 *
 * Staff issue a link that lets a parent pay without typing a student ID. The
 * token (see utils/payLinkToken.js) binds school, student and the student's
 * current `linkVersion`. Revoking bumps `linkVersion`, which invalidates every
 * link issued before it; expiry is enforced by the token itself.
 */

const config = require('../config');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');
const logger = require('../utils/logger');
const {
  generatePayLinkToken,
  verifyPayLinkToken,
  DEFAULT_EXPIRY_SECONDS,
} = require('../utils/payLinkToken');

const MAX_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

class PayLinkError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'PayLinkError';
    this.code = code;
    this.status = status;
  }
}

function getSecret() {
  const secret = config.payLinkSecret;
  if (!secret) {
    throw new PayLinkError('PAY_LINK_NOT_CONFIGURED', 503, 'Pay links are not configured on this server.');
  }
  return secret;
}

function buildPayUrl(token) {
  const baseUrl = String(config.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${baseUrl}/pay/link/${token}`;
}

/**
 * Issue a pay link for a student.
 *
 * @param {{schoolId: string, studentId: string, expiresInSeconds?: number}} params
 * @returns {Promise<{token: string, url: string, expiresAt: string, linkVersion: number}>}
 */
async function issuePayLink({ schoolId, studentId, expiresInSeconds = DEFAULT_EXPIRY_SECONDS }) {
  const secret = getSecret();
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > MAX_EXPIRY_SECONDS) {
    throw new PayLinkError('VALIDATION_ERROR', 400, 'expiresInSeconds must be a positive integer up to 90 days.');
  }

  const student = await Student.findOne({ schoolId, studentId, deletedAt: null }).select('linkVersion').lean();
  if (!student) throw new PayLinkError('NOT_FOUND', 404, 'Student not found');

  const linkVersion = student.linkVersion ?? 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = generatePayLinkToken({ schoolId, studentId, linkVersion, expiresInSeconds }, secret, nowSeconds);

  return {
    token,
    url: buildPayUrl(token),
    expiresAt: new Date((nowSeconds + expiresInSeconds) * 1000).toISOString(),
    linkVersion,
  };
}

/**
 * Revoke every outstanding pay link for a student by bumping linkVersion.
 *
 * @returns {Promise<{linkVersion: number}>}
 */
async function revokePayLinks({ schoolId, studentId }) {
  const updated = await Student.findOneAndUpdate(
    { schoolId, studentId, deletedAt: null },
    { $inc: { linkVersion: 1 } },
    { new: true, projection: { linkVersion: 1 } },
  ).lean();
  if (!updated) throw new PayLinkError('NOT_FOUND', 404, 'Student not found');
  return { linkVersion: updated.linkVersion };
}

/**
 * Resolve a token to its school and student. Every failure mode is a 401 with a
 * distinct code so the client can tell an expired link from a revoked one.
 *
 * @param {string} token
 * @returns {Promise<{school: object, student: object}>}
 */
async function resolvePayLink(token) {
  const secret = getSecret();
  const verified = verifyPayLinkToken(token, secret);
  if (!verified.valid) {
    const code = verified.error === 'Token expired' ? 'PAY_LINK_EXPIRED' : 'PAY_LINK_INVALID';
    throw new PayLinkError(code, 401, verified.error);
  }

  const { schoolId, studentId, linkVersion } = verified;
  const student = await Student.findOne({ schoolId, studentId, deletedAt: null })
    .select('studentId name class feeAmount fees linkVersion')
    .lean();
  if (!student) throw new PayLinkError('PAY_LINK_INVALID', 401, 'Pay link does not match a student');

  if ((student.linkVersion ?? 0) !== linkVersion) {
    throw new PayLinkError('PAY_LINK_REVOKED', 401, 'Pay link has been revoked');
  }

  const school = await School.findOne({ schoolId, isActive: true })
    .select('schoolId name stellarAddress localCurrency')
    .lean();
  if (!school) throw new PayLinkError('PAY_LINK_INVALID', 401, 'Pay link does not match a school');

  return { school, student };
}

/**
 * Best-effort pay URL for reminder emails. Returns '' when links are disabled
 * (PAY_LINK_EMAIL_LINKS) or not configured; a failure never blocks the email.
 */
async function buildReminderPayUrl({ schoolId, studentId }) {
  if (!config.payLinkEmailLinks || !config.payLinkSecret) return '';
  try {
    const { url } = await issuePayLink({ schoolId, studentId });
    return url;
  } catch (err) {
    logger.warn('Failed to issue pay link for reminder', { schoolId, error: err.message });
    return '';
  }
}

module.exports = {
  PayLinkError,
  issuePayLink,
  revokePayLinks,
  resolvePayLink,
  buildReminderPayUrl,
};
