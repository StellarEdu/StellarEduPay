'use strict';

/**
 * requireParentAuth — authenticates the `parent` principal (#1637).
 *
 * The magic-link token is accepted ONLY from the `X-Parent-Token` header or
 * `Authorization: Parent <token>` — never from the query string, so it does
 * not end up in access logs or Referer headers. The frontend /parent page
 * reads it from the link once and strips it from the address bar.
 *
 * A short-lived session cookie (scoped to /api/parent, HttpOnly) issued by
 * POST /api/parent/session is also accepted, so the long-lived magic token is
 * only ever sent once per device.
 *
 * On success sets:
 *   req.parent   = { tokenId, schoolId, studentIds, expiresAt }
 *   req.schoolId = the token's school (authoritative; no X-School-ID needed)
 */

const {
  verifyParentToken,
  verifyParentSession,
  PARENT_SESSION_COOKIE,
} = require('../services/parentPortalService');

function _extractToken(req) {
  const header = req.get('X-Parent-Token');
  if (header) return header.trim();
  const auth = req.get('Authorization') || '';
  const match = /^Parent\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : null;
}

function _extractSession(req) {
  const cookies = req.cookies || {};
  const value = cookies[PARENT_SESSION_COOKIE];
  return typeof value === 'string' && value ? value : null;
}

async function requireParentAuth(req, res, next) {
  try {
    const session = _extractSession(req);
    const record = session
      ? await verifyParentSession(session)
      : await verifyParentToken(_extractToken(req));
    req.parent = {
      tokenId: record.tokenId,
      schoolId: record.schoolId,
      studentIds: [...record.studentIds],
      expiresAt: record.expiresAt,
    };
    req.schoolId = record.schoolId;
    return next();
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ error: err.message, code: err.code });
    }
    return next(err);
  }
}

/**
 * Guard for routes with a :studentId param — the student must be one of the
 * students the link was issued for. Returns 404 (not 403) so a link cannot be
 * used to probe which student IDs exist.
 */
function requireLinkedStudent(req, res, next) {
  if (!req.parent || !req.parent.studentIds.includes(req.params.studentId)) {
    return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
  }
  return next();
}

module.exports = { requireParentAuth, requireLinkedStudent };
