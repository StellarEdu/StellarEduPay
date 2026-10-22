'use strict';

/**
 * Parent self-service portal — magic-link issuance and verification (#1637).
 *
 * A link is `${APP_URL}/parent?token=<jwt>`. The JWT is signed with a key
 * derived from JWT_SECRET (so it can never be accepted as a staff token, and
 * staff tokens can never be accepted here), carries `typ: 'parent'`, the
 * school and the `jti` of a ParentAccessToken record. The record — not the
 * JWT — decides which students the link can see and whether it has been
 * revoked, so a school can revoke a link at any time.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const ParentAccessToken = require('../models/parentAccessTokenModel');
const Student = require('../models/studentModel');
const School = require('../models/schoolModel');
const { hashParentEmail } = require('./studentPiiEncryption');
const logger = require('../utils/logger').child('ParentPortal');

const AUDIENCE = 'parent-portal';
const DEFAULT_TTL_DAYS = parseInt(process.env.PARENT_PORTAL_TOKEN_TTL_DAYS, 10) || 30;
const MAX_TTL_DAYS = 180;

function _signingKey() {
  return crypto.createHmac('sha256', config.JWT_SECRET).update('stellaredupay:parent-portal:v1').digest();
}

function _hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function _ttlDays(requested) {
  const n = parseInt(requested, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
}

function buildPortalUrl(token) {
  const baseUrl = (config.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${baseUrl}/parent?token=${encodeURIComponent(token)}`;
}

function _error(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Resolve which students a new link should cover.
 * Either explicit studentIds, or every active student in the school whose
 * parentEmail matches (via the blind index — no plaintext query).
 */
async function _resolveStudents(schoolId, { studentIds, parentEmail }) {
  if (Array.isArray(studentIds) && studentIds.length > 0) {
    const unique = [...new Set(studentIds.map(String))];
    const students = await Student.find({ schoolId, studentId: { $in: unique }, deletedAt: null });
    if (students.length !== unique.length) {
      const found = new Set(students.map((s) => s.studentId));
      throw _error(`Unknown student(s): ${unique.filter((id) => !found.has(id)).join(', ')}`, 'STUDENT_NOT_FOUND', 404);
    }
    return students;
  }
  if (parentEmail) {
    const students = await Student.find({ schoolId, parentEmailHash: hashParentEmail(parentEmail), deletedAt: null });
    if (students.length === 0) {
      throw _error('No students found for this parent email', 'STUDENT_NOT_FOUND', 404);
    }
    return students;
  }
  throw _error('Provide studentIds or parentEmail', 'VALIDATION_ERROR', 400);
}

/**
 * Issue a new magic link.
 *
 * @param {object} opts
 * @param {string} opts.schoolId
 * @param {string[]} [opts.studentIds]
 * @param {string} [opts.parentEmail]
 * @param {number} [opts.ttlDays]
 * @param {string} opts.createdBy - staff user id or 'system'
 * @param {boolean} [opts.send]   - email the link to the parent
 * @returns {Promise<{tokenId, token, url, expiresAt, studentIds, emailed}>}
 */
async function issueParentLink({ schoolId, studentIds, parentEmail, ttlDays, createdBy, send = false }) {
  const students = await _resolveStudents(schoolId, { studentIds, parentEmail });
  const days = _ttlDays(ttlDays);
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
  const tokenId = crypto.randomBytes(16).toString('hex');

  const token = jwt.sign({ typ: 'parent', sid: schoolId }, _signingKey(), {
    jwtid: tokenId,
    audience: AUDIENCE,
    expiresIn: days * 24 * 3600,
  });

  const email = parentEmail || students.find((s) => s.parentEmail)?.parentEmail || null;

  await ParentAccessToken.create({
    schoolId,
    tokenId,
    tokenHash: _hashToken(token),
    studentIds: students.map((s) => s.studentId),
    parentEmailHash: email ? hashParentEmail(email) : null,
    expiresAt,
    createdBy: createdBy || 'system',
  });

  const url = buildPortalUrl(token);
  let emailed = false;
  if (send && email) {
    emailed = await _sendLinkEmail({ schoolId, to: email, url, students, expiresAt });
  }

  return { tokenId, token, url, expiresAt, studentIds: students.map((s) => s.studentId), emailed };
}

async function _sendLinkEmail({ schoolId, to, url, students, expiresAt }) {
  try {
    const { sendEmail } = require('./email');
    const school = await School.findOne({ schoolId }).lean();
    const schoolName = school?.name || 'StellarEduPay';
    const names = students.map((s) => s.name).join(', ');
    const expires = expiresAt.toISOString().slice(0, 10);
    const { escapeHtml } = require('../utils/escapeHtml');
    const text = [
      `Hello,`,
      ``,
      `${schoolName} has given you access to the parent portal for ${names}.`,
      `You can see balances, payment history and download receipts here:`,
      ``,
      url,
      ``,
      `This link is personal — do not forward it. It expires on ${expires}.`,
    ].join('\n');
    const html = `<p>Hello,</p>
<p>${escapeHtml(schoolName)} has given you access to the parent portal for <strong>${escapeHtml(names)}</strong>.
You can see balances, payment history and download receipts.</p>
<p><a href="${escapeHtml(url)}">Open the parent portal</a></p>
<p>This link is personal — do not forward it. It expires on ${escapeHtml(expires)}.</p>`;
    const result = await sendEmail({ to, subject: `${schoolName} — your parent portal link`, text, html, category: 'parent_portal' });
    return Boolean(result && result.sent !== false);
  } catch (err) {
    logger.warn('Failed to email parent portal link', { schoolId, error: err.message });
    return false;
  }
}

/**
 * Verify a presented token and return its active ParentAccessToken record.
 * Throws a 401-style error for anything invalid, expired or revoked.
 */
async function verifyParentToken(token) {
  if (!token || typeof token !== 'string') throw _error('Missing parent token', 'PARENT_TOKEN_MISSING', 401);

  let payload;
  try {
    payload = jwt.verify(token, _signingKey(), { audience: AUDIENCE, algorithms: ['HS256'] });
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'PARENT_TOKEN_EXPIRED' : 'PARENT_TOKEN_INVALID';
    throw _error('This link is invalid or has expired', code, 401);
  }
  if (payload.typ !== 'parent' || !payload.sid || !payload.jti) {
    throw _error('This link is invalid or has expired', 'PARENT_TOKEN_INVALID', 401);
  }

  const record = await ParentAccessToken.findOne({ schoolId: payload.sid, tokenId: payload.jti }).select('+tokenHash');
  if (!record || record.tokenHash !== _hashToken(token)) {
    throw _error('This link is invalid or has expired', 'PARENT_TOKEN_INVALID', 401);
  }
  if (record.revokedAt) throw _error('This link has been revoked by the school', 'PARENT_TOKEN_REVOKED', 401);
  if (record.expiresAt <= new Date()) throw _error('This link has expired', 'PARENT_TOKEN_EXPIRED', 401);

  ParentAccessToken.updateOne(
    { schoolId: record.schoolId, tokenId: record.tokenId },
    { $set: { lastUsedAt: new Date() }, $inc: { useCount: 1 } }
  ).catch(() => {});

  return record;
}

async function revokeParentLink({ schoolId, tokenId, revokedBy, reason = null }) {
  const record = await ParentAccessToken.findOneAndUpdate(
    { schoolId, tokenId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy, revokeReason: reason } },
    { new: true }
  );
  return record;
}

/** Revoke every active link that covers a student (e.g. custody change). */
async function revokeLinksForStudent({ schoolId, studentId, revokedBy, reason = null }) {
  const result = await ParentAccessToken.updateMany(
    { schoolId, studentIds: studentId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedBy, revokeReason: reason } }
  );
  return result.modifiedCount || 0;
}

async function listParentLinks({ schoolId, studentId = null, includeInactive = false }) {
  const filter = { schoolId };
  if (studentId) filter.studentIds = studentId;
  if (!includeInactive) {
    filter.revokedAt = null;
    filter.expiresAt = { $gt: new Date() };
  }
  return ParentAccessToken.find(filter).sort({ createdAt: -1 }).limit(200).lean();
}

module.exports = {
  issueParentLink,
  verifyParentToken,
  revokeParentLink,
  revokeLinksForStudent,
  listParentLinks,
  buildPortalUrl,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
};
