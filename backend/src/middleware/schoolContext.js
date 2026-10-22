'use strict';

const School = require('../models/schoolModel');
const cache = require('../cache');
const jwt = require('jsonwebtoken');
const { logAudit } = require('../services/auditService');

const SUPER_ADMIN_AUDIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Record a super-admin access to a school in that school's audit log (#1800).
 *
 * One entry per (token session, school, hour) — the cache key prevents a
 * write on every request. The IP is req.ip, which honours the configured
 * trust-proxy hops, so a client cannot choose it via X-Forwarded-For.
 */
async function auditSuperAdminAccess(req, decoded, school) {
  const performedBy = decoded.username || decoded.userId || decoded.sub || decoded.id || 'super_admin';
  const sessionId = decoded.jti || decoded.sessionId || `${performedBy}:${decoded.iat}`;
  const hourBucket = Math.floor(Date.now() / SUPER_ADMIN_AUDIT_WINDOW_MS);
  const dedupKey = `superadmin-audit:${sessionId}:${school.schoolId}:${hourBucket}`;

  if (cache.get(dedupKey)) return;
  cache.set(dedupKey, true, SUPER_ADMIN_AUDIT_WINDOW_MS / 1000);

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  await logAudit({
    schoolId: school.schoolId,
    action: 'super_admin_school_override',
    performedBy,
    targetId: school.schoolId,
    targetType: 'school',
    details: {
      tokenSchoolId: decoded.schoolId || null,
      requestedSchoolId: school.schoolId,
      username: decoded.username || null,
      userId: decoded.userId || null,
      sessionId,
      ip,
    },
    result: 'success',
    ipAddress: ip,
    userAgent: req.headers?.['user-agent'],
  });
}

/**
 * resolveSchool — middleware that identifies the current school from the request.
 *
 * Lookup strategy (in order of precedence):
 *   1. X-School-ID header   — opaque schoolId string (e.g. "SCH-3F2A")
 *   2. X-School-Slug header — human slug (e.g. "lincoln-high")
 *
 * Security — tenant binding:
 *   If the request carries a JWT, the resolved school is validated against the
 *   token's schoolId. Super-admin tokens (role:'admin' or roles:['super_admin'])
 *   may override any school, but each override is audited.
 *
 * Results are cached in memory with a 5-minute TTL to reduce DB load.
 *
 * On success: attaches req.school (lean School doc) and req.schoolId (string).
 * On failure: 400 if no header provided, 404 if school not found or inactive,
 *             403 on tenant mismatch.
 */
async function resolveSchool(req, res, next) {
  try {
    const schoolId   = req.headers['x-school-id'];
    const schoolSlug = req.headers['x-school-slug'];

    // Issue #1574 — EventSource cannot send custom headers, so the SSE
    // /payments/events endpoint passes schoolId as a query parameter.
    // Accept req.query.schoolId as a fallback *only* for that route so
    // every other route continues to enforce the header requirement.
    const querySid = req.query.schoolId;
    const isSSERoute = req.path === '/events' || req.path.endsWith('/payments/events');
    const effectiveId = schoolId || (isSSERoute && querySid ? querySid : null);

    if (!effectiveId && !schoolSlug) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({
        error: 'School context is required. Provide X-School-ID or X-School-Slug header.',
        code: 'MISSING_SCHOOL_CONTEXT',
      });
    }

    const lookupKey = effectiveId ? effectiveId : schoolSlug.toLowerCase().trim();
    const cacheKey = cache.KEYS.school ? cache.KEYS.school(lookupKey) : `school:${lookupKey}`;

    let school = cache.get(cacheKey);

    if (!school) {
      const query = effectiveId ? { schoolId: effectiveId } : { slug: lookupKey };
      school = await School.findOne(query).lean();
      if (school && school.isActive) {
        const ttl = cache.TTL.SCHOOL || 300;
        if (school.schoolId) {
          const idKey = cache.KEYS.school ? cache.KEYS.school(school.schoolId) : `school:${school.schoolId}`;
          cache.set(idKey, school, ttl);
        }
        if (school.slug) {
          const slugKey = cache.KEYS.school ? cache.KEYS.school(school.slug) : `school:${school.slug}`;
          cache.set(slugKey, school, ttl);
        }
      }
    }

    if (!school) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({
        error: 'School not found.',
        code: 'NOT_FOUND',
      });
    }

    if (!school.isActive) {
      res.set('Cache-Control', 'no-store');
      return res.status(403).json({
        error: 'School is deactivated.',
        code: 'SCHOOL_INACTIVE',
      });
    }

    // ── Tenant binding: check JWT schoolId matches resolved school ────────────
    // Extract token from Authorization header or cookie (no hard failure if absent
    // — unauthenticated requests are handled by subsequent auth middleware).
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies?.admin_token || null;
    const rawToken = cookieToken || bearerToken;

    if (rawToken) {
      try {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET);
        const isSuperAdmin =
          decoded.role === 'admin' ||
          (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

        if (isSuperAdmin) {
          // Super-admin override is permitted — audit every cross-tenant use.
          // The env super-admin token carries no schoolId, so it is always
          // cross-tenant and must be audited too (#1800).
          if (!decoded.schoolId || decoded.schoolId !== school.schoolId) {
            await auditSuperAdminAccess(req, decoded, school);
          }
        } else if (decoded.schoolId && decoded.schoolId !== school.schoolId) {
          // Non-super-admin token for a different tenant — reject immediately.
          res.set('Cache-Control', 'no-store');
          return res.status(403).json({
            error: 'Forbidden. Token schoolId does not match the requested school.',
            code: 'TENANT_MISMATCH',
          });
        }
      } catch {
        // Malformed/expired token — let the auth middleware handle it downstream.
      }
    }

    if (school.maintenanceMode) {
      return res.status(503).json({
        error: 'This school is temporarily unavailable due to maintenance.',
        code: 'SCHOOL_MAINTENANCE_MODE',
      });
    }

    req.school   = school;
    req.schoolId = school.schoolId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveSchool };
module.exports.resolveSchool = resolveSchool;
