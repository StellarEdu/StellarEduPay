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
    /**
     * The wallet address this school used before its most recent rotation
     * (issue #1387). Set automatically by PUT /api/schools/:schoolId/stellar-address
     * whenever stellarAddress changes, so operators can identify the old
     * address to check for in-flight payments sent during a rotation window —
     * see docs/runbooks/wallet-rotation.md. Null if the address has never
     * been rotated.
     */
    previousStellarAddress: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value == null || StellarSdk.StrKey.isValidEd25519PublicKey(value),
        message: 'previousStellarAddress must be a valid Stellar public key (Ed25519)',
      },
    },
    /**
     * Every wallet address this school has rotated away from (#1799). Each
     * retired address keeps being polled until `drainUntil`, with its own
     * cursor, so payments sent to an old address (e.g. copied from a reminder
     * email) are still credited during the drain window.
     */
    walletHistory: {
      type: [{
        _id: false,
        address: {
          type: String,
          required: true,
          validate: {
            validator: (value) => StellarSdk.StrKey.isValidEd25519PublicKey(value),
            message: 'walletHistory.address must be a valid Stellar public key (Ed25519)',
          },
        },
        activeFrom: { type: Date, default: null },
        activeUntil: { type: Date, required: true },
        drainUntil: { type: Date, required: true },
        cursor: { type: String, default: null },
      }],
      default: [],
    },
    // When stellarAddress became the active payment address (#1799).
    walletActiveFrom: { type: Date, default: null },
    isActive:       { type: Boolean, default: true, index: true },
    /**
     * Horizon paging cursor for the transaction poller (#839).
     * Holds the `paging_token` of the most recently examined transaction for
     * this school's wallet. The poller resumes ascending paging from this value
     * each cycle, so it never re-scans history from genesis and never skips a
     * transaction (gap-free, resumable). Null/unset = start from the oldest
     * transaction on first run.
     */
    syncCursor:     { type: String, default: null },
    /**
     * Earliest transaction time the poller and verifier will ingest for this
     * school's wallet (#1818). Transactions dated before it are skipped, so an
     * existing, busy wallet does not replay its history. Null = no lower bound
     * (legacy behaviour). New schools and rotated wallets set it to "now".
     */
    ingestStartsAt: { type: Date, default: null },
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
    // webhookUrl / webhookSecret were removed (#1640): outbound webhooks are
    // configured only through WebhookEndpoint. Migration 036 converted every
    // School.webhookUrl into a WebhookEndpoint and unset both fields.
    /**
     * Per-school webhook payload field controls.
     * Determines which fields are included in outbound webhook payloads.
     *
     * allowedFields: whitelist of field names sent in every delivery.
     *   Defaults to the safe minimal set (no PII: studentId and senderAddress
     *   are excluded unless explicitly opted in).
     *   See utils/buildWebhookPayload.js for the full field enum and defaults.
     */
    webhookPayloadConfig: {
      allowedFields: {
        type: [String],
        default: () => [
          'event',
          'txHash',
          'transactionHash',
          'amount',
          'asset',
          'assetCode',
          'status',
          'schoolId',
          'ts',
          'timestamp',
          'correlationId',
          'referenceCode',
          'finalFee',
          'feeValidationStatus',
          'confirmedAt',
          'ledgerSequence',
          'reason',
          'isSuspicious',
          'originalTxHash',
          'refundTxHash',
          'refundedAt',
        ],
      },
    },
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
     * Per-tenant configuration for the suspicious-amount heuristic. A flat
     * multiplier off the expected fee mis-fires for schools whose normal
     * payments cluster differently; enabling the historical mode bases the
     * threshold on the school's OWN confirmed-payment distribution instead.
     *
     *   mode               — 'fee_multiplier' (default; uses suspiciousPaymentMultiplier)
     *                        or 'historical' (z-score against the school's history).
     *   historicalWindowDays    — lookback window for building the distribution.
     *   historicalStdDevMultiplier — flag amounts more than N std-devs from the mean.
     *   historicalMinSamples    — minimum confirmed payments before the historical
     *                             threshold engages (below this it falls back to
     *                             the fee multiplier, avoiding cold-start noise).
     */
    suspiciousAmountConfig: {
      mode: { type: String, enum: ['fee_multiplier', 'historical'], default: 'fee_multiplier' },
      historicalWindowDays: { type: Number, default: 90, min: 1, max: 730 },
      historicalStdDevMultiplier: { type: Number, default: 3.0, min: 1.0, max: 10 },
      historicalMinSamples: { type: Number, default: 20, min: 1, max: 100000 },
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
     * Per-school email branding and localization fields.
     *
     * logoUrl        — URL to the school logo image, embedded in reminder emails.
     * supportContact — Phone number or email for the school's support/admin contact.
     * primaryColor   — Hex color for the email header background (e.g. '#1a56db').
     * emailLocale    — BCP-47-style locale code for email template language.
     *                  Supported: 'en', 'fr', 'es', 'pt', 'tpi' (Tok Pisin), 'ha' (Hausa).
     */
    logoUrl: { type: String, default: null },
    supportContact: { type: String, default: null },
    primaryColor: { type: String, default: '#1a56db' },
    emailLocale: {
      type: String,
      default: 'en',
      enum: ['en', 'fr', 'es', 'pt', 'tpi', 'ha'],
    },
    /**
     * MFA (TOTP) protection for school admin operations.
     * mfaSecret is AES-256-GCM encrypted; key is derived from JWT_SECRET.
     * mfaBackupCodes holds SHA-256 hashes — each code is single-use.
     *
     * DEPRECATION NOTICE (issue #1553):
     * mfaSecret / mfaBackupCodes on the School document represent a shared
     * second factor distributed to every admin of the school — a known-bad
     * security pattern. They are retained here only for a transition window.
     * New deployments should use per-user MFA (User.mfaSecret) enforced via
     * the requireMfa policy flag below.  The mfaSecret / mfaBackupCodes fields
     * will be removed in a future migration once all schools have migrated.
     */
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: null },
    /**
     * MFA policy flag (issue #1553).
     *
     * When requireMfa: true, every DB user belonging to this school MUST have
     * personal MFA enrolled (User.mfaEnabled === true).  At login time,
     * authController checks this flag and:
     *   - If the user already has personal MFA → proceeds normally.
     *   - If the user has NO personal MFA → issues a restricted
     *     mfaSetupPending token that only allows the MFA setup endpoints,
     *     forcing enrolment before any other action is permitted.
     *
     * This replaces the shared school-level mfaSecret approach: each user
     * gets their own TOTP secret, each MFA event is individually attributed
     * in the audit trail, and a departing employee's removal does not require
     * re-issuing a new secret to everyone else.
     *
     * When requireMfa: false (default), MFA is optional.  Users who have
     * enrolled personal MFA still use it; those who have not are allowed in
     * without a second factor.
     */
    requireMfa: { type: Boolean, default: false },
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
     *   maxSyncBatchSize     — max transactions per polling cycle (number)
     *   reminderEnabled      — enable/disable fee reminder emails (boolean)
     *   reminderIntervalMs   — how often reminder scheduler runs (number, ms)
     *   reminderTimeWindow   — { startHour, endHour } defining the local-time
     *                          window during which reminders may be sent
     *                          (default: { startHour: 8, endHour: 18 })
     *   betaFeatures         — array of opted-in beta feature flags (string[])
     */
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /**
     * School class/grade naming convention (Issue #1337).
     * Configurable per school to support multi-country deployments.
     * Examples:
     *   Nigeria: ["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"]
     *   PNG: ["Grade 1", "Grade 2", ..., "Grade 12"]
     *   Kenya: ["Form 1", "Form 2", "Form 3", "Form 4"]
     *   UK: ["Year 1", "Year 2", ..., "Year 13"]
     */
    classOptions: {
      type: [String],
      default: ['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'],
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
schoolSchema.index({ isActive: 1, name: 1 });

// toJSON transform to exclude sensitive fields
schoolSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.jwtSecret;
    delete ret.internalNotes;
    delete ret.mfaSecret;
    delete ret.mfaBackupCodes;
    return ret;
  },
});

module.exports = mongoose.model('School', schoolSchema);