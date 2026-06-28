'use strict';

const mongoose = require('mongoose');
const StellarSdk = require('@stellar/stellar-sdk');

/**
 * School model — each school is a fully independent tenant.
 *
 * Fields:
 *   schoolId       — auto-generated unique ID (e.g. "SCH-3F2A")
 *   name           — human-readable name (e.g. "Lincoln High School")
 *   slug           — URL-safe identifier used in API headers (e.g. "lincoln-high")
 *   stellarAddress — this school's Stellar wallet that receives fee payments
 *   network        — 'testnet' | 'mainnet'; each school can operate independently
 *   isActive       — soft-delete flag
 */
const schoolSchema = new mongoose.Schema(
  {
    schoolId:       { type: String, required: true, unique: true, index: true },
    name:           { type: String, required: true, trim: true },
    slug:           { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    stellarAddress: {
      type: String,
      required: true,
      validate: {
        validator: (value) => StellarSdk.StrKey.isValidEd25519PublicKey(value),
        message: 'stellarAddress must be a valid Stellar public key (Ed25519)',
      },
    },
    network:        { type: String, enum: ['testnet', 'mainnet'], default: 'testnet' },
    isActive:       { type: Boolean, default: true, index: true },
    adminEmail:     { type: String, default: null },
    address:        { type: String, default: null },
    /**
     * Contact email for the school. Used for reminder emails, receipts, and admin notifications.
     * Must be a valid email format.
     */
    contactEmail:   {
      type: String,
      default: null,
      validate: {
        validator: function(v) {
          if (!v) return true; // Allow null/empty
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: 'Invalid email address format',
      },
    },
    /**
     * Preferred local currency for fee display (ISO 4217 code, uppercase).
     * Used by the currency conversion layer to show fiat equivalents.
     * e.g. "USD" for US schools, "PGK" for Papua New Guinea, "NGN" for Nigeria.
     */
    localCurrency:  { type: String, default: 'USD', uppercase: true, trim: true },
    /**
     * School's timezone (IANA timezone identifier, e.g. "America/New_York", "Pacific/Port_Moresby").
     * Used for date grouping in reports and dashboard metrics.
     * Defaults to UTC.
     */
    timezone: {
      type: String,
      default: 'UTC',
      trim: true,
      validate: {
        validator(tz) {
          if (!tz) return true;
          try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
        },
        message: props => `'${props.value}' is not a valid IANA timezone identifier`,
      },
    },
    /**
     * Per-school webhook endpoint URL. Must be an https:// URL that resolves
     * to a public IP address (RFC 1918, loopback, and link-local are rejected).
     * Validated at registration time and on each delivery attempt.
     */
    webhookUrl:     { type: String, default: null },
    /**
     * Per-school HMAC secret used to sign outbound webhook deliveries.
     * Recipients verify the X-StellarEduPay-Signature header to confirm
     * the payload originated from this server and was not tampered with.
     * Generate with: crypto.randomBytes(32).toString('hex')
     */
    webhookSecret:  { type: String, default: null },
    /**
     * Multiplier threshold for flagging suspicious payments.
     * Payments deviating from expected fee by more than this multiplier are flagged.
     * E.g., multiplier=3.0 flags payments >3× or <1/3 of expected fee.
     * Default: 3.0 (matches original hardcoded behavior).
     * Min: 1.1 (prevents overly sensitive detection).
     */
    suspiciousPaymentMultiplier: {
      type: Number,
      default: 3.0,
      min: [1.1, 'suspiciousPaymentMultiplier must be at least 1.1'],
      max: [100, 'suspiciousPaymentMultiplier must not exceed 100'],
    },
    /**
     * Maximum payment multiplier for this school.
     * The maximum allowed payment is feeAmount * maxPaymentMultiplier.
     * Allows each school to define what constitutes a suspicious overpayment.
     * Default: 3.0 (allows payments up to 3× the fee).
     * Min: 1.1 (must allow at least 10% overpayment).
     * Max: 100 (prevents unreasonably high limits).
     */
    maxPaymentMultiplier: {
      type: Number,
      default: 3.0,
      min: [1.1, 'maxPaymentMultiplier must be at least 1.1'],
      max: [100, 'maxPaymentMultiplier must not exceed 100'],
    },
    /**
     * Maximum number of students this school can register.
     * Enforces per-school student quotas for subscription tiers.
     * Default: 10000 (effectively unlimited for most schools).
     * Set to a lower value to enforce tier-based limits.
     */
    maxStudents: {
      type: Number,
      default: 10000,
      min: [1, 'maxStudents must be at least 1'],
    },
    /**
     * MFA (TOTP) protection for school admin operations.
     * mfaSecret is AES-256-GCM encrypted; key is derived from JWT_SECRET.
     * mfaBackupCodes holds SHA-256 hashes — each code is single-use.
     */
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: null },
    /**
     * Per-school maintenance mode. When true, the school's API endpoints
     * return 503 Service Unavailable. Overrides the global maintenance mode
     * in SystemConfig for this school only.
     */
    maintenanceMode: { type: Boolean, default: false },
    /**
     * Per-school settings overrides. Each key overrides the corresponding
     * SystemConfig global default for this school only.
     *
     * Supported keys:
     *   maxSyncBatchSize   — max transactions per polling cycle (number)
     *   reminderEnabled    — enable/disable fee reminder emails (boolean)
     *   reminderIntervalMs — how often reminder scheduler runs (number, ms)
     *   betaFeatures       — array of opted-in beta feature flags (string[])
     */
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    mfaBackupCodes: [
      {
        hash: { type: String, required: true },
        used: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

schoolSchema.index({ slug: 1 }, { unique: true });
schoolSchema.index({ slug: 1, isActive: 1 });

// toJSON transform to exclude sensitive fields
schoolSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.jwtSecret;
    delete ret.webhookSecret;
    delete ret.internalNotes;
    delete ret.mfaSecret;
    delete ret.mfaBackupCodes;
    return ret;
  },
});

module.exports = mongoose.model('School', schoolSchema);