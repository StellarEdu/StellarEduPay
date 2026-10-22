'use strict';

/**
 * webhookEndpointService.js
 *
 * Shared WebhookEndpoint operations used by both the /api/webhook-endpoints
 * controller and the deprecated per-school webhook routes.
 *
 *  - #1639: one secret-rotation implementation (dual-signing overlap window).
 *  - #1640: WebhookEndpoint is the only outbound webhook configuration model.
 *           The deprecated POST /api/schools/:slug/webhooks and
 *           PUT /api/schools/:schoolId/webhook-secret routes operate on the
 *           school's "legacy" endpoint (source = 'legacy_school_webhook')
 *           instead of School.webhookUrl / School.webhookSecret.
 */

const WebhookEndpoint = require('../models/webhookEndpointModel');
const { LEGACY_SCHOOL_EVENTS, ENDPOINT_SOURCES } = require('../models/webhookEndpointModel');
const { generateWebhookSecret } = require('../utils/webhookSecretPolicy');
const { LEGACY_SIGNATURE_VERSIONS } = require('../utils/webhookSignaturePolicy');

// Default / maximum dual-signing overlap after a secret rotation (#1538, #1639).
const DEFAULT_ROTATION_OVERLAP_S = parseInt(process.env.WEBHOOK_SECRET_ROTATION_OVERLAP_S || '86400', 10);
const MAX_ROTATION_OVERLAP_S = 7 * 24 * 60 * 60;

/**
 * Parse a caller-supplied overlapSeconds value.
 *
 * @param {*} raw
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function parseOverlapSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: DEFAULT_ROTATION_OVERLAP_S };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_ROTATION_OVERLAP_S) {
    return { ok: false, error: `overlapSeconds must be an integer between 0 and ${MAX_ROTATION_OVERLAP_S}` };
  }
  return { ok: true, value };
}

/**
 * Replace an endpoint's signing secret, keeping the old one as previousSecret
 * for `overlapSeconds` so deliveries are signed with both until the receiver
 * has deployed the new secret. Does not save the document.
 *
 * The endpoint must have been loaded with .select('+secret +previousSecret').
 *
 * @param {object} endpoint        WebhookEndpoint document
 * @param {string} newSecret
 * @param {number} overlapSeconds  0 = switch immediately
 * @param {Date}   [now]
 */
function applySecretRotation(endpoint, newSecret, overlapSeconds, now = new Date()) {
  if (overlapSeconds > 0 && endpoint.secret) {
    endpoint.previousSecret = endpoint.secret;
    endpoint.previousSecretExpiresAt = new Date(now.getTime() + overlapSeconds * 1000);
  } else {
    endpoint.previousSecret = null;
    endpoint.previousSecretExpiresAt = null;
  }
  endpoint.secret = newSecret;
  endpoint.secretRotatedAt = now;
}

/**
 * Discard previous secrets whose overlap window has closed (#1639). Delivery
 * already ignores an expired previousSecret; this removes it from storage so
 * the old secret is genuinely gone after the overlap period.
 *
 * @param {Date} [now]
 * @returns {Promise<number>} number of endpoints cleaned up
 */
async function purgeExpiredPreviousSecrets(now = new Date()) {
  const result = await WebhookEndpoint.updateMany(
    { previousSecretExpiresAt: { $ne: null, $lte: now } },
    { $set: { previousSecret: null, previousSecretExpiresAt: null } }
  );
  return result.modifiedCount || 0;
}

/**
 * Find the endpoint created for a school by the deprecated per-school webhook
 * route or by migration 036.
 *
 * @param {string} schoolId
 * @param {object} [opts]
 * @param {boolean} [opts.withSecrets=false]
 */
function findLegacySchoolEndpoint(schoolId, { withSecrets = false } = {}) {
  const query = WebhookEndpoint.findOne({ schoolId, source: ENDPOINT_SOURCES.LEGACY_SCHOOL_WEBHOOK });
  return withSecrets ? query.select('+secret +previousSecret') : query;
}

/**
 * Create or update a school's legacy endpoint from the deprecated
 * POST /api/schools/:slug/webhooks route (#1640).
 *
 * A newly created endpoint gets a server-generated secret, which is returned
 * once. Updating an existing endpoint only changes its URL.
 *
 * @param {object} opts
 * @param {string} opts.schoolId
 * @param {string} opts.url
 * @param {string} [opts.createdBy]
 * @returns {Promise<{ endpoint: object, created: boolean, secret: string|null }>}
 */
async function upsertLegacySchoolEndpoint({ schoolId, url, createdBy = null }) {
  const existing = await findLegacySchoolEndpoint(schoolId);
  if (existing) {
    existing.url = url;
    existing.isActive = true;
    await existing.save();
    return { endpoint: existing, created: false, secret: null };
  }

  const secret = generateWebhookSecret();
  const endpoint = await WebhookEndpoint.create({
    schoolId,
    url,
    secret,
    subscribedEvents: [...LEGACY_SCHOOL_EVENTS],
    // The legacy path always dual-signed (v1 + v2) — keep that for receivers
    // written against it until WEBHOOK_V1_SUNSET.
    signatureVersions: [...LEGACY_SIGNATURE_VERSIONS],
    isActive: true,
    description: 'School webhook (registered via deprecated /api/schools/:slug/webhooks)',
    createdBy,
    source: ENDPOINT_SOURCES.LEGACY_SCHOOL_WEBHOOK,
  });
  return { endpoint, created: true, secret };
}

/**
 * Set the RFC 8594 / draft-ietf-httpapi-deprecation-header headers on a
 * response from a deprecated webhook route, pointing at the replacement API.
 *
 * @param {object} res  Express response
 */
function setWebhookDeprecationHeaders(res) {
  res.set('Deprecation', 'true');
  res.set('Link', '</api/webhook-endpoints>; rel="successor-version"');
}

module.exports = {
  DEFAULT_ROTATION_OVERLAP_S,
  MAX_ROTATION_OVERLAP_S,
  parseOverlapSeconds,
  applySecretRotation,
  purgeExpiredPreviousSecrets,
  findLegacySchoolEndpoint,
  upsertLegacySchoolEndpoint,
  setWebhookDeprecationHeaders,
  generateWebhookSecret,
};
