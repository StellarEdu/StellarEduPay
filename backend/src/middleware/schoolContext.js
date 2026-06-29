'use strict';

const School = require('../models/schoolModel');
const cache = require('../cache');
const jwt = require('jsonwebtoken');
const { logAudit } = require('../services/auditService');

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

    if (!schoolId && !schoolSlug) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({
        error: 'School context is required. Provide X-School-ID or X-School-Slug header.',
        code: 'MISSING_SCHOOL_CONTEXT',
      });
    }

    let school;
    let cacheKey;

    if (schoolId) {
      cacheKey = cache.KEYS.school ? cache.KEYS.school(schoolId) : `school:${schoolId}`;
      school = cache.get(cacheKey);

      if (school) {
        // Re-confirm isActive from DB on every cache hit to prevent stale entries
        // from bypassing deactivation (e.g. when isActive is flipped outside the
        // normal controller path or before the cache TTL expires).
        const live = await School.findOne({ schoolId }, { isActive: 1 }).lean();
        if (!live || !live.isActive) {
          cache.del(cacheKey);
          school = null;
        }
      }

      if (!school) {
        school = await School.findOne({ schoolId }).lean();
        if (school && school.isActive) {
          cache.set(cacheKey, school, cache.TTL.SCHOOL || 300);
        }
      }
    } else {
      const slug = schoolSlug.toLowerCase().trim();
      cacheKey = cache.KEYS.school ? cache.KEYS.school(slug) : `school:${slug}`;
      school = cache.get(cacheKey);

      if (school) {
        // Re-confirm isActive from DB on every cache hit.
        const live = await School.findOne({ slug }, { isActive: 1 }).lean();
        if (!live || !live.isActive) {
          cache.del(cacheKey);
          school = null;
        }
      }

      if (!school) {
        school = await School.findOne({ slug }).lean();
        if (school && school.isActive) {
          cache.set(cacheKey, school, cache.TTL.SCHOOL || 300);
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
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const authHeader = req.headers['authorization'];
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const cookieToken = req.cookies?.admin_token || null;
      const rawToken = cookieToken || bearerToken;

      if (rawToken) {
        try {
          const decoded = jwt.verify(rawToken, secret);
          const isSuperAdmin =
            decoded.role === 'admin' ||
            (Array.isArray(decoded.roles) && decoded.roles.includes('super_admin'));

          if (isSuperAdmin) {
            // Super-admin override is permitted — audit every cross-tenant use.
            if (decoded.schoolId && decoded.schoolId !== school.schoolId) {
              const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                req.socket?.remoteAddress || 'unknown';
              await logAudit({
                schoolId: school.schoolId,
                action: 'super_admin_school_override',
                performedBy: decoded.sub || decoded.id || 'super_admin',
                targetId: school.schoolId,
                targetType: 'school',
                details: { tokenSchoolId: decoded.schoolId, requestedSchoolId: school.schoolId, ip },
                result: 'success',
                ipAddress: ip,
                userAgent: req.headers?.['user-agent'],
              });
            }
          } else if (decoded.schoolId && decoded.schoolId !== school.schoolId) {
            // Non-super-admin token for a different tenant — reject immediately.
            res.set('Cache-Control', 'no-store');
            return res.status(403).json({
              error: 'Forbidden. Token schoolId does not match the requested school.',
              code: 'TENANT_MISMATCH',
            });
          }
        } catch (_) {
          // Malformed/expired token — let the auth middleware handle it downstream.
        }
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
