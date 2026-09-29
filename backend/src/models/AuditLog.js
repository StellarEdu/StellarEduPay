const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      index: true,
    },
    seq: {
      type: Number,
      required: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    targetType: {
      type: String,
      default: null,
      trim: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    prevHash: {
      type: String,
      default: null,
    },
    entryHash: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Serialise appends per school: the (schoolId, seq) pair is the chain's total
// order and must be unique so concurrent writers cannot fork the chain.
auditLogSchema.index({ schoolId: 1, seq: 1 }, { unique: true });

// Per-school sequence counter used to allocate the next `seq` atomically.
const auditSequenceSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
      unique: true,
    },
    value: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: false,
  }
);

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const AuditSequence = mongoose.model('AuditSequence', auditSequenceSchema);

module.exports = AuditLog;
module.exports.AuditLog = AuditLog;
module.exports.AuditSequence = AuditSequence;
