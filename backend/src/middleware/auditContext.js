'use strict';

/**
 * auditContext — middleware that captures audit-relevant information from the request.
 *
 * Attaches req.auditContext with:
 *   - performedBy: authenticated user identifier (school user or admin)
 *   - ipAddress: client IP
 *   - userAgent: client user agent
 *
 * Should be applied after the authentication middleware (requireSchoolAuth or
 * requireAdminAuth). School-scoped access tokens carry `req.user.userId` rather
 * than an email, so we prefer that identifier; admin tokens fall back to
 * `req.admin` identifiers.
 */
function auditContext(req, res, next) {
  req.auditContext = {
    performedBy:
      req.user?.userId ||
      req.user?.email ||
      req.admin?.email ||
      req.admin?.userId ||
      'unknown',
    ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'] || null,
  };
  next();
}

module.exports = { auditContext };