'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');
const { encryptStudentPii, decryptStudentPii } = require('../services/studentPiiEncryption');

const DISPUTE_SLA_HOURS = parseInt(process.env.DISPUTE_SLA_HOURS, 10) || 72; // default 72h

/**
 * Dispute model — tracks disputed payments and their resolution lifecycle.
 *
 * A dispute is a separate entity that references a Payment by txHash.
 * This avoids mutating the immutable payment audit trail.
 *
 * Lifecycle: open → under_review → resolved | rejected
 *
 * SLA: disputes auto-escalate if not resolved within DISPUTE_SLA_HOURS
 * of creation. Evidence (screenshots, tx references) can be attached
 * to support the dispute.
 *
 * Notifications (#1638): the raiser's contact (raisedByEmail / raisedByPhone,
 * falling back to the student's parent contact) receives a confirmation on
 * creation and an update on every status change. Contact fields are PII and
 * are encrypted at rest with the same key as the student parent contact
 * (STUDENT_PII_ENCRYPTION_KEY, #1480).
 */
const DISPUTE_CONTACT_FIELDS = ['raisedByEmail', 'raisedByPhone'];

const evidenceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['screenshot', 'tx_reference', 'document', 'other'],
      required: true,
    },
    url:         { type: String, required: true, trim: true },
    description: { type: String, default: null, trim: true, maxlength: 500 },
    uploadedAt:  { type: Date, default: Date.now },
  },
  { _id: true }
);

const disputeSchema = new mongoose.Schema(
  {
    // Tenant isolation — all queries must include schoolId
    schoolId:    { type: String, required: true, index: true },

    // Reference to the disputed payment (txHash is the stable public identifier)
    txHash:      { type: String, required: true, index: true },
    studentId:   { type: String, required: true, index: true },

    // Additional transaction references linked to this dispute
    txReference: { type: String, default: null, trim: true, maxlength: 128 },

    // Who raised the dispute and why
    raisedBy:    { type: String, required: true, trim: true, maxlength: 200 },   // e.g. parent name / admin ID
    reason:      { type: String, required: true, trim: true, maxlength: 1000 },   // free-text description

    // Contact channel for the raiser (#1638) — encrypted at rest. When neither
    // is supplied, notifications go to the student's parent contact.
    raisedByEmail: { type: String, default: null, trim: true },
    raisedByPhone: { type: String, default: null, trim: true },

    // Supporting evidence
    evidence:    { type: [evidenceSchema], default: [] },

    status: {
      type: String,
      enum: ['open', 'under_review', 'resolved', 'rejected'],
      default: 'open',
      index: true,
    },

    // Assignment — who is handling this dispute
    assignedTo: { type: String, default: null, trim: true, maxlength: 200 },

    // SLA tracking — auto-calculated on creation
    slaDeadline: {
      type: Date,
      default: function () {
        return new Date(Date.now() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);
      },
    },
    slaBreachedAt: { type: Date, default: null },
    // Set once admins have been alerted about the SLA breach (#1638), so the
    // SLA sweep notifies exactly once per dispute.
    slaBreachNotifiedAt: { type: Date, default: null },

    // Escalation
    escalationLevel: {
      type: Number,
      enum: [0, 1, 2],
      default: 0, // 0 = normal, 1 = warning, 2 = breached
    },
    escalatedAt: { type: Date, default: null },

    // Tracks the last activity date (comments, evidence added, status change)
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },

    // Resolution details — populated when status moves to resolved/rejected
    resolvedBy:   { type: String, default: null },
    resolutionNote: { type: String, default: null, maxlength: 2000 },
    resolvedAt:   { type: Date, default: null },

    // Hold tracking — records whether the disputeHold was lifted on this
    // student when the dispute closed. Always null while the dispute is still
    // open or under_review.
    holdLifted:   { type: Boolean, default: null },
  },
  {
    timestamps: true, // createdAt = when dispute was raised, updatedAt = last change
  }
);

// Compound indexes for common query patterns
disputeSchema.index({ schoolId: 1, status: 1 });
disputeSchema.index({ schoolId: 1, txHash: 1 });
disputeSchema.index({ schoolId: 1, studentId: 1 });

// SLA and escalation queries
disputeSchema.index({ slaDeadline: 1, status: 1 });
disputeSchema.index({ status: 1, slaBreachNotifiedAt: 1, slaDeadline: 1 });
disputeSchema.index({ escalationLevel: 1, status: 1 });

// One open/under_review dispute per payment per school — prevent duplicate open disputes
disputeSchema.index(
  { schoolId: 1, txHash: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['open', 'under_review'] } },
  }
);

/**
 * Virtual: dispute age in hours since creation (for filtering stale disputes).
 */
disputeSchema.virtual('ageHours').get(function () {
  return (Date.now() - (this.createdAt || Date.now())) / (1000 * 60 * 60);
});

/**
 * Pre-save: update lastActivityAt and auto-escalate when SLA is breached.
 */
disputeSchema.pre('save', function (next) {
  this.lastActivityAt = new Date();

  // Check SLA breach automatically
  if (['open', 'under_review'].includes(this.status) && this.slaDeadline && new Date() > this.slaDeadline) {
    if (!this.slaBreachedAt) {
      this.slaBreachedAt = new Date();
      this.escalationLevel = 2;
      this.escalatedAt = new Date();
    }
  } else if (this.status === 'under_review' && this.slaDeadline) {
    // SLA approaching warning
    const hoursUntilDeadline = (this.slaDeadline - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilDeadline <= 24 && hoursUntilDeadline > 0 && this.escalationLevel < 1) {
      this.escalationLevel = 1;
    }
  }

  next();
});

// ── Raiser contact encryption at rest — Issue #1638 ─────────────────────────
// Mirrors the Student parent contact hooks (#1480): encrypt before persisting,
// decrypt back onto the in-memory document. No-ops without
// STUDENT_PII_ENCRYPTION_KEY.

disputeSchema.pre('save', function (next) {
  for (const field of DISPUTE_CONTACT_FIELDS) {
    if (this.isModified(field) && this[field] != null) {
      this[field] = encryptStudentPii(this[field]);
    }
  }
  next();
});

function _decryptContact(doc) {
  if (!doc) return doc;
  for (const field of DISPUTE_CONTACT_FIELDS) {
    if (doc[field] != null) doc[field] = decryptStudentPii(doc[field]);
  }
  return doc;
}

disputeSchema.post('save', function () { _decryptContact(this); });
disputeSchema.post('init', function () { _decryptContact(this); });

disputeSchema.plugin(tenantScope, { modelName: 'Dispute' });

module.exports = mongoose.model('Dispute', disputeSchema);
/** Decrypt contact fields on a .lean() result (post('init') does not run). */
module.exports.decryptLeanDispute = _decryptContact;
module.exports.DISPUTE_SLA_HOURS = DISPUTE_SLA_HOURS;
