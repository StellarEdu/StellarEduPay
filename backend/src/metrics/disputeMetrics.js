'use strict';

/**
 * disputeMetrics.js — Prometheus metrics for dispute resolution (#1375).
 *
 * The dispute model already tracks slaDeadline, slaBreachedAt and resolvedAt,
 * but none of it was exported, so SLA compliance and how long resolution
 * actually takes were only visible by querying the database by hand.
 *
 * Exported metrics (all registered on the shared registry from metrics/index.js):
 *
 *   dispute_raised_total{schoolId}
 *     Counter. Incremented when a dispute is flagged.
 *
 *   dispute_resolved_total{schoolId, outcome}
 *     Counter. Incremented when a dispute reaches a terminal state.
 *     outcome: 'resolved' | 'rejected'
 *
 *   dispute_resolution_duration_hours{schoolId, outcome}
 *     Histogram. Hours from createdAt to resolvedAt — the resolution time
 *     distribution the SLA is actually judged on. Buckets run from one hour to
 *     two weeks, which brackets a typical 72h SLA on both sides.
 *
 *   dispute_sla_breached_total{schoolId}
 *     Counter. Incremented when a dispute is resolved after its slaDeadline.
 *     Rated against dispute_resolved_total it gives the SLA compliance ratio.
 *
 *   dispute_open_total{schoolId, status}
 *     Gauge. Currently open disputes by status. A counter cannot express this,
 *     because the number goes down as disputes are resolved. Refreshed by
 *     refreshOpenDisputeGauge().
 *
 *   dispute_sla_at_risk_total{schoolId}
 *     Gauge. Open disputes already past their slaDeadline — the queue an
 *     operator has to act on now, rather than a count of past breaches.
 */

const { registry } = require('./index');
const client = require('prom-client');

/** Statuses that mean a dispute is still being worked. */
const OPEN_STATUSES = ['open', 'under_review'];

// ── dispute_raised_total ──────────────────────────────────────────────────────
const disputeRaisedTotal = new client.Counter({
  name: 'dispute_raised_total',
  help: 'Total disputes raised, by school',
  labelNames: ['schoolId'],
  registers: [registry],
});

// ── dispute_resolved_total ────────────────────────────────────────────────────
const disputeResolvedTotal = new client.Counter({
  name: 'dispute_resolved_total',
  help: 'Total disputes reaching a terminal state, by school and outcome',
  labelNames: ['schoolId', 'outcome'],
  registers: [registry],
});

// ── dispute_resolution_duration_hours ─────────────────────────────────────────
// Buckets bracket a typical 72h SLA on both sides: same-day resolutions stay
// distinguishable at the low end, and anything past a week lands in a bucket
// that keeps the tail visible rather than collapsing it into +Inf.
const disputeResolutionDurationHours = new client.Histogram({
  name: 'dispute_resolution_duration_hours',
  help: 'Hours from dispute creation to resolution',
  labelNames: ['schoolId', 'outcome'],
  buckets: [1, 4, 12, 24, 48, 72, 120, 168, 336],
  registers: [registry],
});

// ── dispute_sla_breached_total ────────────────────────────────────────────────
const disputeSlaBreachedTotal = new client.Counter({
  name: 'dispute_sla_breached_total',
  help: 'Disputes resolved after their SLA deadline, by school',
  labelNames: ['schoolId'],
  registers: [registry],
});

// ── dispute_open_total ────────────────────────────────────────────────────────
// Gauge, not a counter: the value falls as disputes are resolved.
const disputeOpenTotal = new client.Gauge({
  name: 'dispute_open_total',
  help: 'Currently open disputes, by school and status',
  labelNames: ['schoolId', 'status'],
  registers: [registry],
});

// ── dispute_sla_at_risk_total ─────────────────────────────────────────────────
const disputeSlaAtRiskTotal = new client.Gauge({
  name: 'dispute_sla_at_risk_total',
  help: 'Open disputes already past their SLA deadline, by school',
  labelNames: ['schoolId'],
  registers: [registry],
});

/**
 * Hours between two instants, or null when either is missing or the pair is
 * not a sane forward interval.
 * @param {Date|string|null} from
 * @param {Date|string|null} to
 * @returns {number|null}
 */
function hoursBetween(from, to) {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / (1000 * 60 * 60);
}

/**
 * Record a newly raised dispute.
 * @param {string} schoolId
 */
function recordDisputeRaised(schoolId) {
  if (!schoolId) return;
  disputeRaisedTotal.inc({ schoolId });
}

/**
 * Record a dispute reaching a terminal state.
 *
 * The duration is observed only when both timestamps are present and sane, so
 * a document written before this metric existed cannot skew the histogram with
 * a zero.
 *
 * @param {object} dispute - The resolved dispute document
 * @param {string} dispute.schoolId
 * @param {string} dispute.status - Terminal status ('resolved' | 'rejected')
 * @param {Date} [dispute.createdAt]
 * @param {Date} [dispute.resolvedAt]
 * @param {Date} [dispute.slaDeadline]
 */
function recordDisputeResolved(dispute) {
  if (!dispute || !dispute.schoolId) return;

  const schoolId = dispute.schoolId;
  const outcome = dispute.status;
  disputeResolvedTotal.inc({ schoolId, outcome });

  const resolvedAt = dispute.resolvedAt || new Date();
  const durationHours = hoursBetween(dispute.createdAt, resolvedAt);
  if (durationHours !== null) {
    disputeResolutionDurationHours.observe({ schoolId, outcome }, durationHours);
  }

  if (dispute.slaDeadline && new Date(resolvedAt) > new Date(dispute.slaDeadline)) {
    disputeSlaBreachedTotal.inc({ schoolId });
  }
}

/**
 * Refresh the open-dispute gauges from the collection. Called on startup and
 * after each state change, mirroring refreshDeadLetterGauge().
 *
 * @returns {Promise<void>}
 */
async function refreshOpenDisputeGauge() {
  try {
    const Dispute = require('../models/disputeModel');

    const byStatus = await Dispute.aggregate([
      { $match: { status: { $in: OPEN_STATUSES } } },
      { $group: { _id: { schoolId: '$schoolId', status: '$status' }, count: { $sum: 1 } } },
    ]);

    disputeOpenTotal.reset();
    for (const { _id, count } of byStatus) {
      if (_id && _id.schoolId) {
        disputeOpenTotal.set({ schoolId: _id.schoolId, status: _id.status }, count);
      }
    }

    const atRisk = await Dispute.aggregate([
      {
        $match: {
          status: { $in: OPEN_STATUSES },
          slaDeadline: { $ne: null, $lt: new Date() },
        },
      },
      { $group: { _id: '$schoolId', count: { $sum: 1 } } },
    ]);

    disputeSlaAtRiskTotal.reset();
    for (const { _id, count } of atRisk) {
      if (_id) disputeSlaAtRiskTotal.set({ schoolId: _id }, count);
    }
  } catch (_) {
    // DB may not be ready yet; scrape still succeeds with last-known values
  }
}

module.exports = {
  OPEN_STATUSES,
  disputeRaisedTotal,
  disputeResolvedTotal,
  disputeResolutionDurationHours,
  disputeSlaBreachedTotal,
  disputeOpenTotal,
  disputeSlaAtRiskTotal,
  hoursBetween,
  recordDisputeRaised,
  recordDisputeResolved,
  refreshOpenDisputeGauge,
};
