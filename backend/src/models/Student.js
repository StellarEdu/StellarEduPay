const mongoose = require('mongoose');

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const studentSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    parentName: {
      type: String,
      trim: true,
    },
    parentEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    parentPhone: {
      type: String,
      trim: true,
      validate: {
        validator(value) {
          if (value === undefined || value === null || value === '') return true;
          return E164_REGEX.test(value);
        },
        message: 'parentPhone must be a valid E.164 phone number (e.g. +14155552671)',
      },
    },
    // Per-parent opt-in for SMS/WhatsApp notifications. Email remains the default channel.
    smsOptIn: {
      type: Boolean,
      default: false,
    },
    // Set when the parent replies STOP; suppresses SMS/WhatsApp until re-opted in.
    smsOptOut: {
      type: Boolean,
      default: false,
    },
    school: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: true,
    },
    grade: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'graduated'],
      default: 'active',
    },
  },
  { timestamps: true }
);

studentSchema.index({ school: 1, status: 1 });

module.exports = mongoose.model('Student', studentSchema);
