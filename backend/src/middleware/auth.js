'use strict';

const logger = require('../utils/logger').child('AuthMiddleware');
const { logAudit } = require('../services/auditService');
const { get, set } = require('../cache');
const { sendAdminAlert } = require('../services/alertService');
const { getRedisClient, isRedisReady } = require('../config/redisClient');
const { hashIp, stripQueryString } = require('../utils/piiRedaction');
const User = require('../models/userModel');
const School = require('../models/School');
const tokenService = require('../services/tokenService');
const {
  findActiveBlock,
  recordAuthFailure,
  BLOCK_TTL,
} = require('../services/authIpBlockService');

// Missing-credential requests are not counted towards a block, but they still
// reach the server, so they are audited at most once per IP per window.
const MISSING_TOKEN_AUDIT_WINDOW = 60; // seconds

// Keyed by hashIp so the in-process audit sampler never holds a raw address.
function missingTokenAuditKey(ip) {
  return `auth_missing_audit:${hashIp(ip)}`;
}

// X-School-ID is attacker-controlled at this point (no token has been verified),
// so it is only recorded as a claim when it names a school that actually exists.
async function resolveClaimedSchoolId(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue) return undefined;
  try {
    const school = await School.exists({ schoolId: headerValue });
    return school ? headerValue : undefined;
  } catch (err) {
    logger.warn('[AuthMiddleware] Failed to verify claimed school', { error: err.message });
    return undefined;
  }
}

// Cookie first, then Bearer header. Both middlewares use the same precedence.
function presentedToken(req) {
  const authHeader = req.headers?.['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = req.cookies?.admin_token || null;
  return cookieToken || bearerToken;
}

function sendIpBlocked(res) {
  if (typeof res.set === 'function') res.set('Retry-After', String(BLOCK_TTL));
  return res.status(429).json({ error: 'Too many requests, IP temporarily blocked.', code: 'IP_BLOCKED' });
}

// ── Session revocation check ──────────────────────────────────────────────────
// Deactivation and role changes bump user.tokenVersion and revoke refresh
// families. Access tokens carry the tokenVersion they were minted with, so a
// mismatch (or an inactive user) means the session must be rejected now rather
// than at access-token expiry.
//
// Returns null when the token is still valid, or a { status, body } object to
// send back when it has been revoked.
async function checkSessionRevoked(decoded) {
  // Env super-admin tokens (role:'admin') are not backed by a DB user row.
  // #1939 — the env super-admin's userId is the literal 'super_admin', which is not
  // an ObjectId; looking it up would throw a CastError and fail every request.
  if (decoded.userId === 'super_admin') return null;
  if (decoded.role === 'admin' && !decoded.userId && !decoded.sub) return null;

  const userId = decoded.userId || decoded.sub || decoded.id;
  if (!userId) return null;

  let user;
  try {
    user = await User.findById(userId).select('isActive tokenVersion').lean();
  } catch (err) {
    logger.error('[AuthMiddleware] Failed to load user for session check', { error: err.message, userId });
    return { status: 500, body: { error: 'Server error validating session.', code: 'SESSION_CHECK_FAILED' } };
  }

  if (!user) {
    return { status: 401, body: { error: 'Session is no longer valid.', code: 'SESSION_REVOKED' } };
  }

  if (user.isActive === false) {
    return { status: 401, body: { error: 'Account is deactivated.', code: 'SESSION_REVOKED' } };
  }

  const storedVersion = user.tokenVersion || 0;
  const tokenVersion = decoded.tokenVersion || 0;
  if (storedVersion !== tokenVersion) {
    return { status: 401, body: { error: 'Session has been revoked.', code: 'SESSION_REVOKED' } };
  }

  return null;
}

// ── Shared failure handler (used by both middleware factories) ────────────────

async function handleAuthFailure(req, res, ip, reason, code, { countTowardsBlock = true } = {}) {
  const ipHash = hashIp(ip);
  const endpoint = stripQueryString(req.originalUrl);
  logger.warn(`Failed auth attempt: ${reason}`, { ipHash, endpoint, code });

  // Every failure is audited under the system tenant, never under a tenant the
  // caller names. Missing-credential probes are sampled to one row per IP per window.
  let shouldAudit = true;
  if (code === 'MISSING_AUTH_TOKEN') {
    shouldAudit = !get(missingTokenAuditKey(ip));
    if (shouldAudit) set(missingTokenAuditKey(ip), true, MISSING_TOKEN_AUDIT_WINDOW);
  }

  if (shouldAudit) {
    const claimedSchoolId = await resolveClaimedSchoolId(req.headers?.['x-school-id']);

    await logAudit({
      schoolId: 'system',
      action: 'auth_failure',
      performedBy: 'anonymous',
      targetType: 'auth',
      details: {
        ipHash,
        endpoint,
        code,
        reason,
        ...(claimedSchoolId ? { claimedSchoolId } : {}),
      },
      result: 'failure',
      errorMessage: reason,
      // Stored hashed, consistent with the logging policy in docs/privacy.md.
      ipAddress: ipHash,
      userAgent: req.headers?.['user-agent'],
    });
  }

  if (countTowardsBlock) {
    // Blocks are scoped to (IP, presented token). A shared NAT address is only
    // blocked for the credential that keeps failing; the IP-wide backstop is high.
    await recordAuthFailure({ ip, token: presentedToken(req) }).catch((err) => {
      logger.error('[AuthMiddleware] Failed to record auth failure', { error: err.message, ipHash });
    });
  }

  return res.status(401).json({ error: reason, code });
}

// ── requireAdminAuth ──────────────────────────────────────────────────────────
// Protects global super-admin endpoints. Accepts JWTs with role:'admin' (env
// super-admin) or roles including 'super_admin' (DB super-admin).

async function requireAdminAuth(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const token = presentedToken(req);

  if (await findActiveBlock({ ip, token })) {
    return sendIpBlocked(res);
  }

  if (!token) {
    // A missing credential is "not logged in yet", not a brute-force attempt —
    // there is nothing to guess. Counting it would let normal logged-out page
    // loads (e.g. an /auth/me probe) self-trigger the IP block. Forged/invalid
    // tokens and bad login credentials still count below.
    return handleAuthFailure(req, res, ip,
      'Authentication required. Provide an admin session cookie or Bearer token.',
      'MISSING_AUTH_TOKEN',
      { countTowardsBlock: false }
    );
  }

  try {
    const decoded = tokenService.verify(token);

    if (decoded.sid && await tokenService.isSessionRevoked(decoded.sid)) {
      return handleAuthFailure(req, res, ip, 'Session has been revoked.', 'SESSION_REVOKED', { countTowardsBlock: false });
    }

    // Accept the old role:'admin' shape AND the new roles:['super_admin'] shape
    const isSuperAdmin =
      decoded.role === 'admin' ||
      (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

    if (!isSuperAdmin) {
      return res.status(403).json({ error: 'Forbidden. Admin role required.', code: 'INSUFFICIENT_ROLE' });
    }

    // Reject tokens whose session has been revoked (deactivated/demoted user).
    const revoked = await checkSessionRevoked(decoded);
    if (revoked) {
      return res.status(revoked.status).json(revoked.body);
    }

    req.admin = decoded;
    req.user = decoded; // alias so downstream code works regardless of which middleware ran
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return handleAuthFailure(req, res, ip, 'Token has expired.', 'TOKEN_EXPIRED', { countTowardsBlock: false });
    }
    return handleAuthFailure(req, res, ip, 'Invalid token.', 'INVALID_AUTH_TOKEN');
  }
}

// ── requireSchoolAuth ─────────────────────────────────────────────────────────
// Tenant-scoped middleware for school-operator endpoints.
//
// Usage: router.get('/students', requireSchoolAuth(['owner', 'staff']), handler)
//
// Rules:
//  • JWT must be valid and signed with the pinned algorithm/issuer/audience.
//  • Token schoolId must match X-School-ID request header (tenant isolation).
//  • If allowedRoles is non-empty, the token's roles array must contain at least
//    one of them.
//  • The env super-admin (role:'admin') is always granted access so that the
//    break-glass account can reach every tenant without needing a scoped token.

function requireSchoolAuth(allowedRoles = []) {
  return async function schoolAuthMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const token = presentedToken(req);

    if (await findActiveBlock({ ip, token })) {
      return sendIpBlocked(res);
    }

    if (!token) {
      // See requireAdminAuth: a missing credential is not a brute-force attempt.
      return handleAuthFailure(req, res, ip,
        'Authentication required.',
        'MISSING_AUTH_TOKEN',
        { countTowardsBlock: false }
      );
    }

    let decoded;
    try {
      decoded = tokenService.verify(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return handleAuthFailure(req, res, ip, 'Token has expired.', 'TOKEN_EXPIRED', { countTowardsBlock: false });
      }
      return handleAuthFailure(req, res, ip, 'Invalid token.', 'INVALID_AUTH_TOKEN');
    }

    if (decoded.sid && await tokenService.isSessionRevoked(decoded.sid)) {
      return handleAuthFailure(req, res, ip, 'Session has been revoked.', 'SESSION_REVOKED', { countTowardsBlock: false });
    }

    // Reject tokens whose session has been revoked (deactivated/demoted user).
    const revoked = await checkSessionRevoked(decoded);
    if (revoked) {
      return res.status(revoked.status).json(revoked.body);
    }

    // Super-admin bypass — break-glass access to all tenants
    const isSuperAdmin =
      decoded.role === 'admin' ||
      (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

    if (!isSuperAdmin) {
      // Tenant scope: non-super-admin tokens MUST have a schoolId
      if (!decoded.schoolId) {
        return res.status(403).json({
          error: 'Forbidden. Token is not scoped to a school.',
          code: 'MISSING_TENANT_CLAIM',
        });
      }

      // Token schoolId must match the requested school.
      // Accept schoolId from X-School-ID header, URL param, or route param.
      // URL param support enables EventSource (which cannot send custom headers).
      const requestedSchoolId = req.headers['x-school-id'] || req.query?.schoolId || req.params?.schoolId;
      if (requestedSchoolId && decoded.schoolId !== requestedSchoolId) {
        return res.status(403).json({
          error: 'Forbidden. Token schoolId does not match the requested school.',
          code: 'TENANT_MISMATCH',
        });
      }

      // Role check
      if (allowedRoles.length > 0) {
        const userRoles = Array.isArray(decoded.roles) ? decoded.roles : [];
        const hasRole = allowedRoles.some((r) => userRoles.includes(r));
        if (!hasRole) {
          return res.status(403).json({
            error: `Forbidden. Required role: ${allowedRoles.join(' or ')}.`,
            code: 'INSUFFICIENT_ROLE',
          });
        }
      }

      // Set req.schoolId from token — authoritative source for downstream use
      req.schoolId = decoded.schoolId;
    }

    // Tenant isolation: token schoolId must match X-School-ID header
    const headerSchoolId = req.headers['x-school-id'];
    const isEnvSuperAdmin = decoded.role === 'admin';
    if (!isEnvSuperAdmin && headerSchoolId && decoded.schoolId && String(decoded.schoolId) !== String(headerSchoolId)) {
      // A stale school selection is a client mistake, not a guessing attempt, so it
      // is audited but never counts towards an IP or credential block (#1950).
      return handleAuthFailure(req, res, ip, 'Token school does not match requested school.', 'TENANT_MISMATCH', { countTowardsBlock: false });
    }

    // Role check
    if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !isEnvSuperAdmin) {
      const tokenRoles = Array.isArray(decoded.roles) ? decoded.roles : [];
      const hasRole = tokenRoles.some((r) => allowedRoles.includes(r));
      if (!hasRole) {
        return res.status(403).json({ error: 'Forbidden. Insufficient role.', code: 'INSUFFICIENT_ROLE' });
      }
    }

    req.user = decoded;
    req.admin = decoded;
    next();
  };
}

module.exports = {
  requireAdminAuth,
  requireSchoolAuth,
};
