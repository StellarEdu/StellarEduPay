'use strict';

/**
 * Issue #1817 — super-admin operations overview.
 * GET /api/admin/ops/overview reports, per school, whether payment detection is
 * operating, how far the poller lags, and the verification / webhook backlog.
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_DELAYED_AFTER_MS,
  classifyPaymentDetection,
  buildSchoolOpsRow,
} = require('../backend/src/utils/opsStatus');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000).toISOString();

describe('classifyPaymentDetection (#1817)', () => {
  it('reports never_synced when there is no successful poll on record', () => {
    expect(classifyPaymentDetection(null, NOW)).toBe('never_synced');
    expect(classifyPaymentDetection(undefined, NOW)).toBe('never_synced');
  });

  it('reports never_synced for an unparseable timestamp', () => {
    expect(classifyPaymentDetection('garbage', NOW)).toBe('never_synced');
  });

  it('reports operational when the last poll is within the threshold', () => {
    expect(classifyPaymentDetection(minutesAgo(2), NOW)).toBe('operational');
  });

  it('reports delayed once the last poll is older than the threshold', () => {
    expect(classifyPaymentDetection(minutesAgo(16), NOW)).toBe('delayed');
  });

  it('treats a poll exactly at the threshold as operational', () => {
    const at = new Date(NOW - DEFAULT_DELAYED_AFTER_MS).toISOString();
    expect(classifyPaymentDetection(at, NOW)).toBe('operational');
  });

  it('honours a custom threshold', () => {
    expect(classifyPaymentDetection(minutesAgo(5), NOW, 60 * 1000)).toBe('delayed');
  });
});

describe('buildSchoolOpsRow (#1817)', () => {
  const school = {
    schoolId: 'SCH-1',
    name: 'Riverside',
    isActive: true,
    syncCursor: '123-456',
    ingestStartsAt: new Date('2026-06-01T00:00:00Z'),
  };

  it('computes lag in whole seconds from the last successful poll', () => {
    const row = buildSchoolOpsRow(school, { lastSyncAt: minutesAgo(2) }, NOW);
    expect(row.lagSeconds).toBe(120);
    expect(row.paymentDetection).toBe('operational');
  });

  it('reports null lag when the school has never synced', () => {
    const row = buildSchoolOpsRow(school, { lastSyncAt: null }, NOW);
    expect(row.lagSeconds).toBeNull();
    expect(row.paymentDetection).toBe('never_synced');
  });

  it('never reports negative lag for a clock-skewed future timestamp', () => {
    const future = new Date(NOW + 5000).toISOString();
    expect(buildSchoolOpsRow(school, { lastSyncAt: future }, NOW).lagSeconds).toBe(0);
  });

  it('maps verification statuses onto stable keys with zero defaults', () => {
    const row = buildSchoolOpsRow(school, { verifications: { pending: 3, dead_letter: 1 } }, NOW);
    expect(row.pendingVerifications).toEqual({ pending: 3, processing: 0, deadLetter: 1 });
  });

  it('reports zero backlog when there are no counts for the school', () => {
    const row = buildSchoolOpsRow(school, {}, NOW);
    expect(row.pendingVerifications).toEqual({ pending: 0, processing: 0, deadLetter: 0 });
    expect(row.webhookDeadLetters).toBe(0);
  });

  it('exposes cursor presence and ingest start without leaking the cursor value', () => {
    const row = buildSchoolOpsRow(school, {}, NOW);
    expect(row.hasCursor).toBe(true);
    expect(row.ingestStartsAt).toEqual(school.ingestStartsAt);
    expect(row).not.toHaveProperty('syncCursor');
  });

  it('treats a missing isActive flag as active (legacy documents)', () => {
    expect(buildSchoolOpsRow({ ...school, isActive: undefined }, {}, NOW).isActive).toBe(true);
  });
});

describe('ops overview wiring (#1817)', () => {
  const CONTROLLER = SRC('backend/src/controllers/opsAdminController.js');
  const ROUTES = SRC('backend/src/routes/adminRoutes.js');

  it('is mounted behind admin authentication', () => {
    expect(ROUTES).toMatch(/router\.get\('\/ops\/overview', requireAdminAuth, getOpsOverview\)/);
  });

  it('reads each source with one grouped query, not one query per school', () => {
    expect(CONTROLLER).toContain('PendingVerification.aggregate(');
    expect(CONTROLLER).toContain('WebhookRetry.aggregate(');
    expect(CONTROLLER).not.toMatch(/schools\.map\([^)]*\)\s*=>\s*\{?[^}]*\.(findOne|find|countDocuments)\(/);
  });

  it('only counts the verification statuses that represent a backlog', () => {
    expect(CONTROLLER).toContain("status: { $in: ['pending', 'processing', 'dead_letter'] }");
  });
});
