"use strict";

/**
 * Unified configuration loader.
 *
 * Multi-school note: SCHOOL_WALLET_ADDRESS is no longer required at startup.
 * Each school's Stellar address is stored in the school document in MongoDB.
 * The variable is still read here (optional) for the legacy default-school
 * backfill migration in backend/migrations/033_backfill_default_school.js.
 */

const Joi = require("joi");

// ── Schema ────────────────────────────────────────────────────────────────────
// Every variable this module owns is declared here with its type, default,
// allowed range and whether it is a secret. `process.env` is read only inside
// this module; consumers import the validated values from `config`.
const schema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),

  // ── Required ────────────────────────────────────────────────────────────────
  MONGO_URI: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required().secret(),
  RECEIPT_SIGNATURE_SECRET: Joi.string().required().secret(),

  // ── Server ──────────────────────────────────────────────────────────────────
  PORT: Joi.number().integer().min(0).max(65535).default(5000),
  MAX_BODY_SIZE: Joi.string().default("10kb"),
  REQUEST_TIMEOUT_MS: Joi.number().integer().min(0).default(30000),
  TRUSTED_PROXY_HOPS: Joi.number().integer().min(0).default(1),

  // ── Stellar ─────────────────────────────────────────────────────────────────
  STELLAR_NETWORK: Joi.string().valid("testnet", "mainnet").default("testnet"),
  STELLAR_HORIZON_URL: Joi.string().uri().optional(),
  HORIZON_URL: Joi.string().uri().optional(),
  STELLAR_HORIZON_URLS: Joi.string().optional(),
  STELLAR_TIMEOUT_MS: Joi.number().integer().min(0).default(10000),
  SCHOOL_WALLET_ADDRESS: Joi.string()
    .pattern(/^G[A-Z2-7]{55}$/)
    .allow(null, "")
    .default(null),
  USDC_ISSUER: Joi.string().pattern(/^G[A-Z2-7]{55}$/).optional(),
  ACCEPTED_ASSET: Joi.string().valid("XLM", "USDC").default("XLM"),
  CONFIRMATION_THRESHOLD: Joi.number().integer().min(0).default(2),
  FINALIZATION_THRESHOLD: Joi.number().integer().min(0).optional(),

  // ── Sync / polling ──────────────────────────────────────────────────────────
  POLL_INTERVAL_MS: Joi.number().integer().min(0).default(30000),
  SYNC_INTERVAL_MS: Joi.number().integer().min(0).optional(),
  SYNC_LOCK_TTL_MS: Joi.number().integer().min(0).default(60000),

  // ── Retry service ───────────────────────────────────────────────────────────
  RETRY_INTERVAL_MS: Joi.number().integer().min(0).default(60000),
  RETRY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(10),

  // ── Payment limits ──────────────────────────────────────────────────────────
  MIN_PAYMENT_AMOUNT: Joi.number().min(0).default(0.01),
  MAX_PAYMENT_AMOUNT: Joi.number().greater(Joi.ref("MIN_PAYMENT_AMOUNT")).default(100000),

  // ── Concurrent payment processor ────────────────────────────────────────────
  MAX_QUEUE_DEPTH: Joi.number().integer().min(1).default(1000),
  QUEUE_BACKPRESSURE_HIGH_WATER: Joi.number().integer().min(0).optional(),
  QUEUE_BACKPRESSURE_LOW_WATER: Joi.number().integer().min(0).optional(),

  // ── Auth ────────────────────────────────────────────────────────────────────
  JWT_EXPIRES_IN: Joi.string().default("8h"),

  // ── Fee reminders ───────────────────────────────────────────────────────────
  REMINDER_INTERVAL_MS: Joi.number().integer().min(0).default(60 * 60 * 1000),
  REMINDER_COOLDOWN_HOURS: Joi.number().integer().min(0).default(48),
  REMINDER_MAX_COUNT: Joi.number().integer().min(1).default(5),

  // ── Student PII retention ───────────────────────────────────────────────────
  STUDENT_PII_RETENTION_DAYS: Joi.number().integer().min(0).default(90),

  // ── SMTP ────────────────────────────────────────────────────────────────────
  SMTP_HOST: Joi.string().allow(null, "").default(null),
  SMTP_PORT: Joi.number().integer().min(0).max(65535).default(587),
  SMTP_SECURE: Joi.boolean().truthy("true").falsy("false").default(false),
  SMTP_USER: Joi.string().allow(null, "").default(null),
  SMTP_PASS: Joi.string().allow(null, "").default(null).secret(),
  SMTP_FROM: Joi.string().allow(null, "").default(null),
})
  .unknown(true) // tolerate variables owned by other modules during migration
  .prefs({ convert: true, abortEarly: false });

const { value: env, error } = schema.validate(process.env, {
  stripUnknown: false,
});

if (error) {
  const details = error.details
    .map((d) => `  - ${d.path.join(".")}: ${d.message}`)
    .join("\n");
  throw new Error(
    `[Config] Invalid environment configuration:\n${details}\n` +
      "Check your .env file against .env.example.",
  );
}

// ── Derived values ────────────────────────────────────────────────────────────
const PORT = env.PORT;
const MONGO_URI = env.MONGO_URI;
const RECEIPT_SIGNATURE_SECRET = env.RECEIPT_SIGNATURE_SECRET;
const STELLAR_NETWORK = env.STELLAR_NETWORK;
const IS_TESTNET = STELLAR_NETWORK !== "mainnet";

const HORIZON_URL =
  env.STELLAR_HORIZON_URL ||
  env.HORIZON_URL ||
  "https://horizon.stellar.org";

// Comma-separated, priority-ordered list of Horizon URLs for failover.
// When set, the HorizonFailoverClient will try each URL in order.
// Falls back to HORIZON_URL (single-endpoint mode) when not set.
const STELLAR_HORIZON_URLS = env.STELLAR_HORIZON_URLS
  ? env.STELLAR_HORIZON_URLS.split(',').map((u) => u.trim()).filter(Boolean)
  : [HORIZON_URL];

// Optional — only used by the migration script to seed the default school
const SCHOOL_WALLET_ADDRESS = env.SCHOOL_WALLET_ADDRESS || null;

const USDC_ISSUER =
  env.USDC_ISSUER ||
  (IS_TESTNET
    ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

// Which asset the school accepts: 'XLM' (default) or 'USDC'
const ACCEPTED_ASSET = env.ACCEPTED_ASSET;

const CONFIRMATION_THRESHOLD = env.CONFIRMATION_THRESHOLD;

// Finality threshold (issue #747): ledgers required beyond CONFIRMATION_THRESHOLD
// before a payment is promoted from 'confirmed' to 'finalized' — the point at
// which it is treated as practically irreversible and should never require
// manual correction. Must be >= CONFIRMATION_THRESHOLD; defaults to 5x it.
const FINALIZATION_THRESHOLD =
  env.FINALIZATION_THRESHOLD ?? CONFIRMATION_THRESHOLD * 5;
if (FINALIZATION_THRESHOLD < CONFIRMATION_THRESHOLD) {
  throw new Error(
    "[Config] FINALIZATION_THRESHOLD must be >= CONFIRMATION_THRESHOLD.",
  );
}

const POLL_INTERVAL_MS = env.POLL_INTERVAL_MS;

// SYNC_INTERVAL_MS is the canonical env var for auto-sync interval.
// Falls back to POLL_INTERVAL_MS for backwards compatibility.
// Set to 0 to disable auto-sync entirely.
const SYNC_INTERVAL_MS = env.SYNC_INTERVAL_MS ?? POLL_INTERVAL_MS;

// How long a per-school sync lock is held before auto-expiring. Acts as the
// crash-safety net for the distributed lock around each poll cycle: must
// comfortably exceed the time it takes to poll a single school, but stay short
// enough that a dead worker's lock frees up reasonably quickly. Default: 60s.
const SYNC_LOCK_TTL_MS = env.SYNC_LOCK_TTL_MS;

// ── Retry Service ─────────────────────────────────────────────────────────────
const RETRY_INTERVAL_MS = env.RETRY_INTERVAL_MS;
const RETRY_MAX_ATTEMPTS = env.RETRY_MAX_ATTEMPTS;

// ── Payment Limits ────────────────────────────────────────────────────────────
const MIN_PAYMENT_AMOUNT = env.MIN_PAYMENT_AMOUNT;
const MAX_PAYMENT_AMOUNT = env.MAX_PAYMENT_AMOUNT;

// ── Concurrent Payment Processor ─────────────────────────────────────────────
const MAX_QUEUE_DEPTH = env.MAX_QUEUE_DEPTH;
const QUEUE_BACKPRESSURE_HIGH_WATER =
  env.QUEUE_BACKPRESSURE_HIGH_WATER ?? Math.ceil(MAX_QUEUE_DEPTH * 0.8);
const QUEUE_BACKPRESSURE_LOW_WATER =
  env.QUEUE_BACKPRESSURE_LOW_WATER ?? Math.floor(MAX_QUEUE_DEPTH * 0.5);

// ── Global Rate Limiting & Request Queue (issue #1597) ────────────────────────
// The global limiter previously hard-coded 100 req/min per IP, which throttled
// entire schools sharing a single NAT/CGNAT address. These values are now
// configurable per environment. Authenticated traffic is keyed by user/school
// principal (see app.js), so the authenticated limit can be generous while the
// anonymous limit stays strict.
const RATE_LIMIT_GLOBAL_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_GLOBAL_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_GLOBAL_MAX = parseInt(
  process.env.RATE_LIMIT_GLOBAL_MAX || "100",
  10,
);
// Higher default for authenticated principals (user/school) so a bursar's
// dashboard and multiple staff behind one IP are not throttled.
const RATE_LIMIT_AUTHENTICATED_MAX = parseInt(
  process.env.RATE_LIMIT_AUTHENTICATED_MAX || "600",
  10,
);

const REQUEST_QUEUE_MAX_CONCURRENT = parseInt(
  process.env.REQUEST_QUEUE_MAX_CONCURRENT || "50",
  10,
);
const REQUEST_QUEUE_MAX_SIZE = parseInt(
  process.env.REQUEST_QUEUE_MAX_SIZE || "1000",
  10,
);
const REQUEST_QUEUE_DEFAULT_TIMEOUT_MS = parseInt(
  process.env.REQUEST_QUEUE_DEFAULT_TIMEOUT_MS || "30000",
  10,
);

if (isNaN(RATE_LIMIT_GLOBAL_WINDOW_MS) || RATE_LIMIT_GLOBAL_WINDOW_MS <= 0) {
  throw new Error(
    `[Config] RATE_LIMIT_GLOBAL_WINDOW_MS must be a positive integer, got: ${process.env.RATE_LIMIT_GLOBAL_WINDOW_MS}`,
  );
}
if (isNaN(RATE_LIMIT_GLOBAL_MAX) || RATE_LIMIT_GLOBAL_MAX <= 0) {
  throw new Error(
    `[Config] RATE_LIMIT_GLOBAL_MAX must be a positive integer, got: ${process.env.RATE_LIMIT_GLOBAL_MAX}`,
  );
}
if (isNaN(RATE_LIMIT_AUTHENTICATED_MAX) || RATE_LIMIT_AUTHENTICATED_MAX <= 0) {
  throw new Error(
    `[Config] RATE_LIMIT_AUTHENTICATED_MAX must be a positive integer, got: ${process.env.RATE_LIMIT_AUTHENTICATED_MAX}`,
  );
}
if (isNaN(REQUEST_QUEUE_MAX_CONCURRENT) || REQUEST_QUEUE_MAX_CONCURRENT <= 0) {
  throw new Error(
    `[Config] REQUEST_QUEUE_MAX_CONCURRENT must be a positive integer, got: ${process.env.REQUEST_QUEUE_MAX_CONCURRENT}`,
  );
}
if (isNaN(REQUEST_QUEUE_MAX_SIZE) || REQUEST_QUEUE_MAX_SIZE < 0) {
  throw new Error(
    `[Config] REQUEST_QUEUE_MAX_SIZE must be a non-negative integer, got: ${process.env.REQUEST_QUEUE_MAX_SIZE}`,
  );
}
if (isNaN(REQUEST_QUEUE_DEFAULT_TIMEOUT_MS) || REQUEST_QUEUE_DEFAULT_TIMEOUT_MS <= 0) {
  throw new Error(
    `[Config] REQUEST_QUEUE_DEFAULT_TIMEOUT_MS must be a positive integer, got: ${process.env.REQUEST_QUEUE_DEFAULT_TIMEOUT_MS}`,
  );
}

// ── Body Size Limit ───────────────────────────────────────────────────────────
// Global JSON body size limit (default: 10kb). Bulk import uses 1mb regardless.
const MAX_BODY_SIZE = env.MAX_BODY_SIZE;

// ── Bulk Import Limits ────────────────────────────────────────────────────────
// Maximum number of student rows accepted by a single bulk import, shared by
// both the CSV and JSON import paths so the two stay aligned (issue #1612).
const CSV_MAX_ROWS = parseInt(process.env.CSV_MAX_ROWS || "10000", 10);

// Body size limit for the JSON bulk import endpoint. Must be large enough to
// carry CSV_MAX_ROWS student records in a single JSON payload, so it is derived
// from CSV_MAX_ROWS rather than the global MAX_BODY_SIZE (default: 10kb).
// ~1 KB per student record is a generous upper bound; the floor keeps small
// CSV_MAX_ROWS overrides from shrinking the limit below the previous 1mb.
const BULK_IMPORT_BODY_SIZE =
  process.env.BULK_IMPORT_BODY_SIZE ||
  `${Math.max(1, Math.ceil((CSV_MAX_ROWS * 1024) / (1024 * 1024)))}mb`;

// ── Timeouts ──────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = env.REQUEST_TIMEOUT_MS;
const STELLAR_TIMEOUT_MS = env.STELLAR_TIMEOUT_MS;

// ── Proxy Configuration ────────────────────────────────────────────────────────
const TRUSTED_PROXY_HOPS = env.TRUSTED_PROXY_HOPS;

// ── Auth ──────────────────────────────────────────────────────────────────────
// Secret used to sign/verify admin JWTs. Must be at least 32 characters.
const JWT_SECRET = env.JWT_SECRET;
const JWT_SECRET_MIN_LENGTH = 32;
const JWT_EXPIRES_IN = env.JWT_EXPIRES_IN;

// ── Fee Reminders ─────────────────────────────────────────────────────────────
// How often the scheduler checks for unpaid fees (default: 1 hour).
// Schools are only processed during their configured send window, so a shorter
// interval ensures every school gets picked up at the right local time.
const REMINDER_INTERVAL_MS = env.REMINDER_INTERVAL_MS;
// Minimum hours between reminders for the same student (default: 48 hours)
const REMINDER_COOLDOWN_HOURS = env.REMINDER_COOLDOWN_HOURS;
// Maximum reminders to send per student before stopping (default: 5)
const REMINDER_MAX_COUNT = env.REMINDER_MAX_COUNT;

// ── Student PII Data Retention ────────────────────────────────────────────────
// Number of days to retain student PII (name, date of birth, parent name, etc.)
// after soft-delete before automatic anonymization (default: 90 days, ~3 months).
// After the retention window, sensitive fields are cleared to reduce breach exposure.
const STUDENT_PII_RETENTION_DAYS = env.STUDENT_PII_RETENTION_DAYS;

// SMTP settings for nodemailer
const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = env.SMTP_PORT;
const SMTP_SECURE = env.SMTP_SECURE;
const SMTP_USER = env.SMTP_USER;
const SMTP_PASS = env.SMTP_PASS;
const SMTP_FROM = env.SMTP_FROM;

module.exports = {
  PORT,
  MONGO_URI,
  RECEIPT_SIGNATURE_SECRET,
  STELLAR_NETWORK,
  IS_TESTNET,
  HORIZON_URL,
  STELLAR_HORIZON_URLS,
  SCHOOL_WALLET_ADDRESS,
  USDC_ISSUER,
  ACCEPTED_ASSET,
  CONFIRMATION_THRESHOLD,
  FINALIZATION_THRESHOLD,
  POLL_INTERVAL_MS,
  SYNC_INTERVAL_MS,
  SYNC_LOCK_TTL_MS,
  RETRY_INTERVAL_MS,
  RETRY_MAX_ATTEMPTS,
  MIN_PAYMENT_AMOUNT,
  MAX_PAYMENT_AMOUNT,
  MAX_QUEUE_DEPTH,
  QUEUE_BACKPRESSURE_HIGH_WATER,
  QUEUE_BACKPRESSURE_LOW_WATER,
  RATE_LIMIT_GLOBAL_WINDOW_MS,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_AUTHENTICATED_MAX,
  REQUEST_QUEUE_MAX_CONCURRENT,
  REQUEST_QUEUE_MAX_SIZE,
  REQUEST_QUEUE_DEFAULT_TIMEOUT_MS,
  MAX_BODY_SIZE,
  CSV_MAX_ROWS,
  BULK_IMPORT_BODY_SIZE,
  REQUEST_TIMEOUT_MS,
  STELLAR_TIMEOUT_MS,
  TRUSTED_PROXY_HOPS,
  JWT_SECRET,
  JWT_SECRET_MIN_LENGTH,
  JWT_EXPIRES_IN,
  REMINDER_INTERVAL_MS,
  REMINDER_COOLDOWN_HOURS,
  REMINDER_MAX_COUNT,
  STUDENT_PII_RETENTION_DAYS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
};
