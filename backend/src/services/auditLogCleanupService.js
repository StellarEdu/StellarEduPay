'use strict';

// #885 — Archive-instead-of-delete: records are never hard-deleted.
// The scheduler marks old entries as archived=true so they can be offloaded
// to cold storage without losing forensic/compliance value.
//
// #1609 — Retention is controlled by a single setting. AUDIT_LOG_RETENTION_DAYS
// is the canonical variable; AUDIT_LOG_TTL_DAYS is accepted as a deprecated
// alias so operators migrating from the old TTL index keep working. The TTL
// index on `auditlogs` is dropped in migration 002 so entries are archived,
// never hard-deleted, before any offload to cold storage.

const { archiveAuditLogs } = require('./auditService');

const INTERVAL_MS = 10 * 60 * 1000;

function resolveRetentionDays() {
  const raw = process.env.AUDIT_LOG_RETENTION_DAYS || process.env.AUDIT_LOG_TTL_DAYS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 730;
}

const RETENTION_DAYS = resolveRetentionDays();
let _timer = null;

function startAuditLogCleanupScheduler() {
  if (_timer) return;
  _timer = setInterval(() => archiveAuditLogs(RETENTION_DAYS), INTERVAL_MS);
  _timer.unref();
}

function stopAuditLogCleanupScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startAuditLogCleanupScheduler, stopAuditLogCleanupScheduler, resolveRetentionDays };
