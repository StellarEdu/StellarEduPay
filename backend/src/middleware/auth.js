'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger').child('AuthMiddleware');
const { logAudit } = require('../services/auditService');
const { get, set } = require('../cache');
const { sendAdminAlert } = require('../services/alertService');

// ── Shared failure handler (used by both middleware factories) ────────────────

async function handleAuthFailure(req, res, ip, reason, code, { countTowardsBlock = true } = {}) {
  logger.warn(`Failed auth attempt: ${reason} from ${ip}`, { endpoint: req.originalUrl, code });

  const schoolId = req.headers['x-school-id'] || 'system';

  await logAudit({
    schoolId,
    action: 'auth_failure',
    performedBy: 'anonymous',
    targetId: 'admin_auth',
    targetType: 'school',
    details: { ip, endpoint: req.originalUrl, code, reason },
    result: 'failure',
    errorMessage: reason,
    ipAddress: ip,
    userAgent: req.headers?.['user-agent'],
  });

  if (countTowardsBlock) {
    const failKey = `fail_count:${ip}`;
    const blockKey = `blocked_ip:${ip}`;
    const failCount = (get(failKey) || 0) + 1;
    set(failKey, failCount, 300); // 5 min

    if (failCount >= 5) {
      set(blockKey, true, 900); // 15 min
      await sendAdminAlert(`IP ${ip} blocked due to repeated auth failures`, { ip, endpoint: req.originalUrl });
    }
  }

  return res.status(401).json({ error: reason, code });
}

// ── requireAdminAuth ──────────────────────────────────────────────────────────
// Protects global super-admin endpoints. Accepts JWTs with role:'admin' (env
// super-admin) or roles including 'super_admin' (DB super-admin).

async function requireAdminAuth(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const blockKey = `blocked_ip:${ip}`;

  if (get(blockKey)) {
    return res.status(429).json({ error: 'Too many requests, IP temporarily blocked.', code: 'IP_BLOCKED' });
  }

  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = req.cookies?.admin_token || null;
  const token = cookieToken || bearerToken;

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
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET is not set.', code: 'AUTH_MISCONFIGURED' });
    }

    const decoded = jwt.verify(token, secret);

    // Accept the old role:'admin' shape AND the new roles:['super_admin'] shape
    const isSuperAdmin =
      decoded.role === 'admin' ||
      (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

    if (!isSuperAdmin) {
      return res.status(403).json({ error: 'Forbidden. Admin role required.', code: 'INSUFFICIENT_ROLE' });
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
//  • JWT must be valid and signed with JWT_SECRET.
//  • Token schoolId must match X-School-ID request header (tenant isolation).
//  • If allowedRoles is non-empty, the token's roles array must contain at least
//    one of them.
//  • The env super-admin (role:'admin') is always granted access so that the
//    break-glass account can reach every tenant without needing a scoped token.

function requireSchoolAuth(allowedRoles = []) {
  return async function schoolAuthMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const blockKey = `blocked_ip:${ip}`;

    if (get(blockKey)) {
      return res.status(429).json({ error: 'Too many requests, IP temporarily blocked.', code: 'IP_BLOCKED' });
    }

    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies?.admin_token || null;
    const token = cookieToken || bearerToken;

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
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET is not set.', code: 'AUTH_MISCONFIGURED' });
      }
      decoded = jwt.verify(token, secret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return handleAuthFailure(req, res, ip, 'Token has expired.', 'TOKEN_EXPIRED', { countTowardsBlock: false });
      }
      return handleAuthFailure(req, res, ip, 'Invalid token.', 'INVALID_AUTH_TOKEN');
    }

    // Super-admin bypass — break-glass access to all tenants
    const isSuperAdmin =
      decoded.role === 'admin' ||
      (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

    if (!isSuperAdmin) {
      // Tenant scope: token schoolId must match the requested school
      const requestedSchoolId = req.headers['x-school-id'] || req.params?.schoolId;
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
    }

    req.user = decoded;
    req.admin = decoded; // alias so downstream code works regardless of which middleware ran
    next();
  };
}

module.exports = { requireAdminAuth, requireSchoolAuth };
