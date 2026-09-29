const mongoose = require('mongoose');

const schoolSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    address: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    logoUrl: {
      type: String,
      trim: true,
    },
    // Notification channel preference for reminders and payment confirmations.
    // Determines which channel(s) the school uses to reach parents.
    notificationChannel: {
      type: String,
      enum: ['email', 'sms', 'whatsapp'],
      default: 'email',
    },
    // Whether SMS/WhatsApp notifications are enabled for this school.
    // Parents must additionally opt in individually before receiving them.
    smsNotificationsEnabled: {
      type: Boolean,
      default: false,
    },
    // Quiet hours window (e.g. "20:00-07:00") during which reminders are not sent.
    reminderTimeWindow: {
      type: String,
      trim: true,
      default: '07:00-20:00',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('School', schoolSchema);
