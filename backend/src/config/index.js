"use strict";

/**
 * Unified configuration loader.
 *
 * Multi-school note: SCHOOL_WALLET_ADDRESS is no longer required at startup.
 * Each school's Stellar address is stored in the School document in MongoDB.
 * The variable is still read here (optional) to support the migration script
 * (scripts/migrate-default-school.js) which seeds the first school from it.
 */

// ── Unsupported / broken features ────────────────────────────────────────────
// MEMO_ENCRYPTION_KEY is not supported. AES-256-GCM output (IV + ciphertext +
// auth tag) base64url-encoded is always ≥ 40 characters, which exceeds
// Stellar's hard 28-byte MEMO_TEXT limit. The sync engine also only processes
// memo_type === 'text', so encrypted hash memos are silently dropped.
// Remove MEMO_ENCRYPTION_KEY from your environment to start the server.
if (process.env.MEMO_ENCRYPTION_KEY) {
  throw new Error(
    "[Config] MEMO_ENCRYPTION_KEY is set but memo encryption is not supported. " +
    "Encrypted memos always exceed Stellar's 28-byte MEMO_TEXT limit and will " +
    "silently break payment matching. Remove MEMO_ENCRYPTION_KEY from your environment.",
  );
}

// ── Required variables ────────────────────────────────────────────────────────
const REQUIRED = ["MONGO_URI"];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(
    `[Config] Missing required environment variables: ${missing.join(", ")}\n` +
      "Check your .env file against .env.example.",
  );
}

const PORT = parseInt(process.env.PORT || "5000", 10);
const MONGO_URI = process.env.MONGO_URI;
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || "testnet";
const IS_TESTNET = STELLAR_NETWORK !== "mainnet";

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ||
  process.env.HORIZON_URL ||
  "https://horizon.stellar.org";

// Comma-separated, priority-ordered list of Horizon URLs for failover.
// When set, the HorizonFailoverClient will try each URL in order.
// Falls back to HORIZON_URL (single-endpoint mode) when not set.
const STELLAR_HORIZON_URLS = process.env.STELLAR_HORIZON_URLS
  ? process.env.STELLAR_HORIZON_URLS.split(',').map((u) => u.trim()).filter(Boolean)
  : [HORIZON_URL];

// Optional — only used by the migration script to seed the default school
const SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || null;

const USDC_ISSUER =
  process.env.USDC_ISSUER ||
  (IS_TESTNET
    ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

// Which asset the school accepts: 'XLM' (default) or 'USDC'
const ACCEPTED_ASSET = (process.env.ACCEPTED_ASSET || "XLM").toUpperCase();

const CONFIRMATION_THRESHOLD = parseInt(
  process.env.CONFIRMATION_THRESHOLD || "2",
  10,
);

// Finality threshold (issue #747): ledgers required beyond CONFIRMATION_THRESHOLD
// before a payment is promoted from 'confirmed' to 'finalized' — the point at
// which it is treated as practically irreversible and should never require
// manual correction. Must be >= CONFIRMATION_THRESHOLD; defaults to 5x it.
const FINALIZATION_THRESHOLD = parseInt(
  process.env.FINALIZATION_THRESHOLD || String(CONFIRMATION_THRESHOLD * 5),
  10,
);
if (FINALIZATION_THRESHOLD < CONFIRMATION_THRESHOLD) {
  throw new Error(
    "[Config] FINALIZATION_THRESHOLD must be >= CONFIRMATION_THRESHOLD.",
  );
}

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

// SYNC_INTERVAL_MS is the canonical env var for auto-sync interval.
// Falls back to POLL_INTERVAL_MS for backwards compatibility.
// Set to 0 to disable auto-sync entirely.
const _syncRaw =
  process.env.SYNC_INTERVAL_MS ?? process.env.POLL_INTERVAL_MS ?? "60000";
const SYNC_INTERVAL_MS = parseInt(_syncRaw, 10);

// How long a per-school sync lock is held before auto-expiring. Acts as the
// crash-safety net for the distributed lock around each poll cycle: must
// comfortably exceed the time it takes to poll a single school, but stay short
// enough that a dead worker's lock frees up reasonably quickly. Default: 60s.
const SYNC_LOCK_TTL_MS = parseInt(process.env.SYNC_LOCK_TTL_MS || "60000", 10);

// ── Retry Service ─────────────────────────────────────────────────────────────
const RETRY_INTERVAL_MS = parseInt(
  process.env.RETRY_INTERVAL_MS || "60000",
  10,
);
const RETRY_MAX_ATTEMPTS = parseInt(process.env.RETRY_MAX_ATTEMPTS || "10", 10);

// ── Payment Limits ────────────────────────────────────────────────────────────
const MIN_PAYMENT_AMOUNT = parseFloat(process.env.MIN_PAYMENT_AMOUNT || "0.01");
const MAX_PAYMENT_AMOUNT = parseFloat(
  process.env.MAX_PAYMENT_AMOUNT || "100000",
);

// ── Concurrent Payment Processor ─────────────────────────────────────────────
const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH || "1000", 10);
const QUEUE_BACKPRESSURE_HIGH_WATER = parseInt(
  process.env.QUEUE_BACKPRESSURE_HIGH_WATER || String(Math.ceil(MAX_QUEUE_DEPTH * 0.8)),
  10,
);
const QUEUE_BACKPRESSURE_LOW_WATER = parseInt(
  process.env.QUEUE_BACKPRESSURE_LOW_WATER || String(Math.floor(MAX_QUEUE_DEPTH * 0.5)),
  10,
);

if (MIN_PAYMENT_AMOUNT < 0) {
  throw new Error("[Config] MIN_PAYMENT_AMOUNT must be a positive number");
}
if (MAX_PAYMENT_AMOUNT <= MIN_PAYMENT_AMOUNT) {
  throw new Error(
    "[Config] MAX_PAYMENT_AMOUNT must be greater than MIN_PAYMENT_AMOUNT",
  );
}

// ── Body Size Limit ───────────────────────────────────────────────────────────
// Global JSON body size limit (default: 10kb). Bulk import uses 1mb regardless.
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '10kb';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS || "30000",
  10,
);
const STELLAR_TIMEOUT_MS = parseInt(
  process.env.STELLAR_TIMEOUT_MS || "10000",
  10,
);

// ── Auth ──────────────────────────────────────────────────────────────────────
// Secret used to sign/verify admin JWTs. Must be at least 32 characters.
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SECRET_MIN_LENGTH = 32;
if (!JWT_SECRET || JWT_SECRET.length < JWT_SECRET_MIN_LENGTH) {
  const reason = !JWT_SECRET
    ? 'JWT_SECRET is not set'
    : `JWT_SECRET is too short (${JWT_SECRET.length} chars; minimum ${JWT_SECRET_MIN_LENGTH})`;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[Config] ${reason}. ` +
      "Generate a strong secret with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
    );
  } else {
    console.warn(
      `[Config] WARNING: ${reason}. Admin authentication is insecure. ` +
      'Set a strong JWT_SECRET before deploying to production.'
    );
  }
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

// ── Fee Reminders ─────────────────────────────────────────────────────────────
// How often the scheduler checks for unpaid fees (default: 1 hour).
// Schools are only processed during their configured send window, so a shorter
// interval ensures every school gets picked up at the right local time.
const REMINDER_INTERVAL_MS = parseInt(
  process.env.REMINDER_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);
// Minimum hours between reminders for the same student (default: 48 hours)
const REMINDER_COOLDOWN_HOURS = parseInt(
  process.env.REMINDER_COOLDOWN_HOURS || "48",
  10,
);
// Maximum reminders to send per student before stopping (default: 5)
const REMINDER_MAX_COUNT = parseInt(process.env.REMINDER_MAX_COUNT || "5", 10);

// SMTP settings for nodemailer
const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const SMTP_FROM = process.env.SMTP_FROM || "noreply@stellaredupay.com";

// Email provider inbound webhook secret
const EMAIL_PROVIDER_WEBHOOK_SECRET = process.env.EMAIL_PROVIDER_WEBHOOK_SECRET || null;

// Pluggable email provider (Issue #80): smtp | ses | sendgrid | console.
// When unset the email module auto-selects smtp (if SMTP_* configured) else console.
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || null;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || null;
const AWS_REGION = process.env.AWS_REGION || null;

// ── Twilio (SMS / WhatsApp) ────────────────────────────────────────────────
// All Twilio variables are optional. When unset, smsService falls back to
// console-log (dev mode) so the application starts without SMS credentials.
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID  || null;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || null;
const TWILIO_FROM_NUMBER  = process.env.TWILIO_FROM_NUMBER  || null;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || null;

// ── Freeze to prevent accidental mutation at runtime ─────────────────────────
const config = Object.freeze({
  EMAIL_PROVIDER_WEBHOOK_SECRET,
  PORT,
  MONGO_URI,
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
  MAX_BODY_SIZE,
  REQUEST_TIMEOUT_MS,
  STELLAR_TIMEOUT_MS,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  REMINDER_INTERVAL_MS,
  REMINDER_COOLDOWN_HOURS,
  REMINDER_MAX_COUNT,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TWILIO_WHATSAPP_FROM,
  EMAIL_PROVIDER,
  SENDGRID_API_KEY,
  AWS_REGION,
});

module.exports = config;
