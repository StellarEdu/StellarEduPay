'use strict';

/**
 * Tests for issue #1375 — dispute resolution metrics.
 *
 * The model already tracked slaDeadline, slaBreachedAt and resolvedAt, but none
 * of it reached /metrics, so SLA compliance and the resolution-time
 * distribution could only be got at by querying the database by hand.
 *
 * These tests drive the recording functions directly against the shared
 * registry — no database, no HTTP.
 */

const fs = require('fs');
const path = require('path');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);

const { registry } = require('../backend/src/metrics');
const disputeMetrics = require('../backend/src/metrics/disputeMetrics');

const {
  hoursBetween,
  recordDisputeRaised,
  recordDisputeResolved,
  disputeRaisedTotal,
  disputeResolvedTotal,
  disputeResolutionDurationHours,
  disputeSlaBreachedTotal,
  OPEN_STATUSES,
} = disputeMetrics;

const HOUR = 60 * 60 * 1000;

/** Sum of a counter's values across all label sets. */
async function counterTotal(metric) {
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** The `_sum` sample of a histogram, across all label sets. */
async function histogramSum(metric) {
  const { values } = await metric.get();
  return values
    .filter((v) => v.metricName && v.metricName.endsWith('_sum'))
    .reduce((sum, v) => sum + v.value, 0);
}

beforeEach(() => {
  disputeRaisedTotal.reset();
  disputeResolvedTotal.reset();
  disputeResolutionDurationHours.reset();
  disputeSlaBreachedTotal.reset();
});

describe('registration', () => {
  it('registers every dispute metric on the shared registry', async () => {
    const exposed = await registry.metrics();
    for (const name of [
      'dispute_raised_total',
      'dispute_resolved_total',
      'dispute_resolution_duration_hours',
      'dispute_sla_breached_total',
      'dispute_open_total',
      'dispute_sla_at_risk_total',
    ]) {
      expect(exposed).toContain(name);
    }
  });

  it('treats open and under_review as the unresolved statuses', () => {
    expect(OPEN_STATUSES).toEqual(['open', 'under_review']);
  });
});

describe('hoursBetween', () => {
  it('converts a millisecond span to hours', () => {
    expect(hoursBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T06:00:00Z'))).toBe(6);
  });

  it('returns null when either end is missing', () => {
    expect(hoursBetween(null, new Date())).toBeNull();
    expect(hoursBetween(new Date(), null)).toBeNull();
  });

  it('returns null for a negative interval rather than a bogus observation', () => {
    expect(hoursBetween(new Date('2026-01-02T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('accepts ISO strings as well as Date objects', () => {
    expect(hoursBetween('2026-01-01T00:00:00Z', '2026-01-01T12:00:00Z')).toBe(12);
  });
});

describe('recordDisputeRaised', () => {
  it('counts a raised dispute', async () => {
    recordDisputeRaised('SCH-1');
    expect(await counterTotal(disputeRaisedTotal)).toBe(1);
  });

  it('ignores a missing schoolId rather than emitting an empty label', async () => {
    recordDisputeRaised(undefined);
    expect(await counterTotal(disputeRaisedTotal)).toBe(0);
  });
});

describe('recordDisputeResolved', () => {
  const createdAt = new Date(Date.now() - 10 * HOUR);

  it('counts the resolution under its outcome', async () => {
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'resolved',
      createdAt,
      resolvedAt: new Date(),
    });
    const { values } = await disputeResolvedTotal.get();
    expect(values).toHaveLength(1);
    expect(values[0].labels).toEqual({ schoolId: 'SCH-1', outcome: 'resolved' });
    expect(values[0].value).toBe(1);
  });

  it('observes the resolution duration in hours', async () => {
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'resolved',
      createdAt,
      resolvedAt: new Date(createdAt.getTime() + 10 * HOUR),
    });
    expect(await histogramSum(disputeResolutionDurationHours)).toBeCloseTo(10, 5);
  });

  it('does not observe a duration when createdAt is missing', async () => {
    recordDisputeResolved({ schoolId: 'SCH-1', status: 'resolved', resolvedAt: new Date() });
    expect(await histogramSum(disputeResolutionDurationHours)).toBe(0);
    // The resolution itself is still counted.
    expect(await counterTotal(disputeResolvedTotal)).toBe(1);
  });

  it('counts an SLA breach when resolved after the deadline', async () => {
    const resolvedAt = new Date();
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'resolved',
      createdAt,
      resolvedAt,
      slaDeadline: new Date(resolvedAt.getTime() - HOUR),
    });
    expect(await counterTotal(disputeSlaBreachedTotal)).toBe(1);
  });

  it('counts no breach when resolved before the deadline', async () => {
    const resolvedAt = new Date();
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'resolved',
      createdAt,
      resolvedAt,
      slaDeadline: new Date(resolvedAt.getTime() + HOUR),
    });
    expect(await counterTotal(disputeSlaBreachedTotal)).toBe(0);
  });

  it('counts no breach when no SLA deadline was set', async () => {
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'resolved',
      createdAt,
      resolvedAt: new Date(),
    });
    expect(await counterTotal(disputeSlaBreachedTotal)).toBe(0);
  });

  it('separates rejected from resolved', async () => {
    recordDisputeResolved({
      schoolId: 'SCH-1',
      status: 'rejected',
      createdAt,
      resolvedAt: new Date(),
    });
    const { values } = await disputeResolvedTotal.get();
    expect(values[0].labels.outcome).toBe('rejected');
  });

  it('ignores a document with no schoolId', async () => {
    recordDisputeResolved({ status: 'resolved', createdAt, resolvedAt: new Date() });
    expect(await counterTotal(disputeResolvedTotal)).toBe(0);
  });

  it('ignores a null document', async () => {
    recordDisputeResolved(null);
    expect(await counterTotal(disputeResolvedTotal)).toBe(0);
  });
});

describe('controller wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'controllers', 'dispute.controller.js'),
    'utf8'
  );

  it('records a raised dispute in flagDispute', () => {
    expect(source).toContain('recordDisputeRaised(schoolId)');
  });

  it('records a resolution only on a terminal status', () => {
    expect(source).toContain('if (isTerminal) recordDisputeResolved(dispute)');
  });

  it('refreshes the open gauge on both paths', () => {
    const calls = source.match(/await refreshOpenDisputeGauge\(\)/g) || [];
    expect(calls.length).toBe(2);
  });

  it('never lets a metrics failure fail the request', () => {
    const guarded = source.match(/catch \(metricsErr\)/g) || [];
    expect(guarded.length).toBe(2);
  });
});
