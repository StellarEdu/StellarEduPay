'use strict';

const { v4: uuidv4 } = require('uuid');
const WebhookEndpoint = require('../models/webhookEndpointModel');
const { WEBHOOK_EVENTS, SIGNATURE_VERSIONS, DEFAULT_SIGNATURE_VERSIONS } = require('../models/webhookEndpointModel');
const { generateWebhookSecret, validateWebhookSecretStrength } = require('../utils/webhookSecretPolicy');
const WebhookDelivery = require('../models/webhookDeliveryModel');
const { validateWebhookUrl } = require('../utils/validateWebhookUrl');
const { logAudit } = require('../services/auditService');
const { fireWebhook, sendTestDelivery } = require('../services/webhookService');
const { parseOverlapSeconds, applySecretRotation } = require('../services/webhookEndpointService');
const { requireStepUp } = require('../middleware/stepUpMiddleware');
const logger = require('../utils/logger').child('WebhookEndpointsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate a caller-supplied signatureVersions array (#1539).
 * Must be a non-empty subset of SIGNATURE_VERSIONS and always include 'v2' —
 * the deprecated V1 signature can only be received alongside V2.
 *
 * @returns {string|null} error message, or null when valid
 */
function _validateSignatureVersions(versions) {
  if (!Array.isArray(versions) || versions.length === 0) {
    return 'signatureVersions must be a non-empty array';
  }
  const invalid = versions.filter((v) => !SIGNATURE_VERSIONS.includes(v));
  if (invalid.length > 0) {
    return `Unknown signature versions: ${invalid.join(', ')}. Valid versions: ${SIGNATURE_VERSIONS.join(', ')}`;
  }
  if (!versions.includes('v2')) {
    return "signatureVersions must include 'v2'";
  }
  return null;
}

function _callerSchoolId(req) {
  // Tenant is derived exclusively from resolveSchool (req.schoolId / req.school).
  // The client-supplied X-School-ID header is never trusted.
  return req.schoolId || req.school?._id || req.school?.id || null;
}

function _performedBy(req) {
  // Access tokens carry userId (not email/sub); fall back to admin identity.
  return (
    req.user?.userId ||
    req.user?.id ||
    req.admin?.userId ||
    req.admin?.id ||
    req.admin?.email ||
    'unknown'
  );
}

// ── POST /api/webhook-endpoints ───────────────────────────────────────────────
async function createEndpoint(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'schoolId required', code: 'MISSING_SCHOOL_ID' });

    // Creating an endpoint points outbound payment data at a new URL — require
    // step-up confirmation, same helper as wallet rotation.
    const stepUpError = await requireStepUp(req);
    if (stepUpError) return res.status(stepUpError.status).json(stepUpError.body);

    const { url, secret, subscribedEvents, isActive = true, description, signatureVersions } = req.body;

    if (!url) return res.status(400).json({ error: 'url is required', code: 'VALIDATION_ERROR' });
    if (!subscribedEvents || !Array.isArray(subscribedEvents) || subscribedEvents.length === 0) {
      return res.status(400).json({ error: 'subscribedEvents must be a non-empty array', code: 'VALIDATION_ERROR' });
    }

    // Validate event names
    const invalidEvents = subscribedEvents.filter((e) => !WEBHOOK_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return res.status(400).json({
        error: `Unknown event types: ${invalidEvents.join(', ')}. Valid events: ${WEBHOOK_EVENTS.join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
    }

    // #1538: reject weak caller-supplied secrets; generate one otherwise.
    if (secret !== undefined && secret !== null && secret !== '') {
      const strength = validateWebhookSecretStrength(secret);
      if (!strength.valid) {
        return res.status(400).json({ error: strength.reason, code: 'WEAK_WEBHOOK_SECRET' });
      }
    }

    // #1539: new endpoints receive only the V2 signature unless they ask otherwise.
    if (signatureVersions !== undefined) {
      const versionError = _validateSignatureVersions(signatureVersions);
      if (versionError) return res.status(400).json({ error: versionError, code: 'VALIDATION_ERROR' });
    }

    // SSRF validation
    const urlCheck = await validateWebhookUrl(url);
    if (!urlCheck.valid) {
      return res.status(400).json({
        error: 'URL is not a valid public HTTPS endpoint',
        code: 'INVALID_WEBHOOK_URL',
      });
    }

    const endpointSecret = secret || generateWebhookSecret();

    const endpoint = await WebhookEndpoint.create({
      schoolId,
      url,
      secret: endpointSecret,
      signatureVersions: signatureVersions ? [...new Set(signatureVersions)] : [...DEFAULT_SIGNATURE_VERSIONS],
      subscribedEvents,
      isActive: Boolean(isActive),
      description: description || null,
      createdBy: _performedBy(req),
    });

    await logAudit({
      schoolId,
      action: 'webhook_endpoint_created',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: { url, subscribedEvents, isActive, signatureVersions: endpoint.signatureVersions },
    });

    // Return the secret once on creation; it is stripped from all subsequent reads.
    const obj = endpoint.toJSON();
    obj.secret = endpointSecret;
    return res.status(201).json(obj);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/webhook-endpoints ────────────────────────────────────────────────
async function listEndpoints(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'schoolId required', code: 'MISSING_SCHOOL_ID' });

    const endpoints = await WebhookEndpoint.find({ schoolId }).sort({ createdAt: -1 }).lean();
    return res.json({ endpoints });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/webhook-endpoints/:id ───────────────────────────────────────────
async function getEndpoint(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    // Scope the query to the caller's schoolId so cross-tenant IDs produce the
    // same 404 as non-existent IDs — eliminating the existence side-channel
    // that a prior 403 vs 404 divergence would reveal. (#1179)
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId }).lean();
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
    // secret is stripped by toJSON transform; lean() bypasses that — strip manually
    delete endpoint.secret;
    delete endpoint.previousSecret;
    return res.json(endpoint);
  } catch (err) {
    next(err);
  }
}

// ── PUT /api/webhook-endpoints/:id ───────────────────────────────────────────
async function updateEndpoint(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    // Scope the query to the caller's schoolId — cross-tenant IDs and missing
    // IDs both return 404, removing the existence side-channel. (#1179)
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId }).select('+secret +previousSecret');
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    const { url, secret, subscribedEvents, isActive, description, signatureVersions, overlapSeconds } = req.body;
    let secretOverlapSeconds = null;

    if (url !== undefined && url !== endpoint.url) {
      // Changing the delivery URL redirects future payment data — require
      // step-up confirmation, same helper as wallet rotation.
      const stepUpError = await requireStepUp(req);
      if (stepUpError) return res.status(stepUpError.status).json(stepUpError.body);
    }

    if (url !== undefined) {
      const urlCheck = await validateWebhookUrl(url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: 'URL is not a valid public HTTPS endpoint', code: 'INVALID_WEBHOOK_URL' });
      }
      endpoint.url = url;
    }
    if (secret !== undefined) {
      // #1538: same strength policy as on creation.
      const strength = validateWebhookSecretStrength(secret);
      if (!strength.valid) {
        return res.status(400).json({ error: strength.reason, code: 'WEAK_WEBHOOK_SECRET' });
      }
      // #1639: a caller-supplied secret no longer switches instantly — the old
      // secret keeps co-signing for the overlap window (default
      // WEBHOOK_SECRET_ROTATION_OVERLAP_S; pass overlapSeconds: 0 to switch
      // immediately). Prefer POST /:id/rotate-secret, which also generates a
      // strong secret server-side.
      const overlap = parseOverlapSeconds(overlapSeconds);
      if (!overlap.ok) return res.status(400).json({ error: overlap.error, code: 'VALIDATION_ERROR' });
      secretOverlapSeconds = overlap.value;
      applySecretRotation(endpoint, secret, secretOverlapSeconds);
    }
    if (signatureVersions !== undefined) {
      // #1539: lets integrators that have migrated to V2 drop V1 early.
      const versionError = _validateSignatureVersions(signatureVersions);
      if (versionError) return res.status(400).json({ error: versionError, code: 'VALIDATION_ERROR' });
      endpoint.signatureVersions = [...new Set(signatureVersions)];
    }
    if (subscribedEvents !== undefined) {
      if (!Array.isArray(subscribedEvents) || subscribedEvents.length === 0) {
        return res.status(400).json({ error: 'subscribedEvents must be a non-empty array', code: 'VALIDATION_ERROR' });
      }
      const invalidEvents = subscribedEvents.filter((e) => !WEBHOOK_EVENTS.includes(e));
      if (invalidEvents.length > 0) {
        return res.status(400).json({ error: `Unknown event types: ${invalidEvents.join(', ')}`, code: 'VALIDATION_ERROR' });
      }
      endpoint.subscribedEvents = subscribedEvents;
    }
    if (isActive !== undefined) endpoint.isActive = Boolean(isActive);
    if (description !== undefined) endpoint.description = description;

    await endpoint.save();

    await logAudit({
      schoolId,
      action: 'webhook_endpoint_updated',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: {
        url: endpoint.url,
        subscribedEvents: endpoint.subscribedEvents,
        isActive: endpoint.isActive,
        signatureVersions: endpoint.signatureVersions,
        secretChanged: secret !== undefined,
        ...(secret !== undefined ? {
          overlapSeconds: secretOverlapSeconds,
          previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
        } : {}),
      },
    });

    const obj = endpoint.toJSON(); // secret stripped
    return res.json(obj);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/webhook-endpoints/:id/rotate-secret ────────────────────────────
/**
 * Rotate an endpoint's signing secret (#1538, #1639).
 *
 * A new secret is always generated server-side and returned exactly once.
 * For `overlapSeconds` (default WEBHOOK_SECRET_ROTATION_OVERLAP_S = 24h,
 * max 7 days, 0 = no overlap) deliveries are signed with both secrets: the
 * X-StellarEduPay-Signature-V2 header carries two comma-separated values
 * (new first), and X-StellarEduPay-Signature-V2-Previous carries the old one.
 * Receivers can therefore deploy the new secret without dropping events. The
 * old secret is discarded once the window closes (webhookRetryScheduler).
 */
async function rotateSecret(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId }).select('+secret +previousSecret');
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    const overlap = parseOverlapSeconds(req.body ? req.body.overlapSeconds : undefined);
    if (!overlap.ok) return res.status(400).json({ error: overlap.error, code: 'VALIDATION_ERROR' });
    const overlapSeconds = overlap.value;

    const newSecret = generateWebhookSecret();
    applySecretRotation(endpoint, newSecret, overlapSeconds);
    await endpoint.save();

    await logAudit({
      schoolId,
      action: 'webhook_endpoint_secret_rotated',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: { overlapSeconds, previousSecretExpiresAt: endpoint.previousSecretExpiresAt },
    });

    // The new secret is returned once; it is stripped from all subsequent reads.
    return res.json({
      id: String(endpoint._id),
      secret: newSecret,
      secretRotatedAt: endpoint.secretRotatedAt,
      previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/webhook-endpoints/:id ────────────────────────────────────────
async function deleteEndpoint(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    // Scope the query to the caller's schoolId — cross-tenant IDs and missing
    // IDs both return 404, removing the existence side-channel. (#1179)
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId });
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    await WebhookEndpoint.deleteOne({ _id: endpoint._id });

    await logAudit({
      schoolId,
      action: 'webhook_endpoint_deleted',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: { url: endpoint.url },
    });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/webhook-deliveries ───────────────────────────────────────────────
async function listDeliveries(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'schoolId required', code: 'MISSING_SCHOOL_ID' });

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const filter = { schoolId };
    if (req.query.endpointId) filter.endpointId = req.query.endpointId;
    if (req.query.event) filter.event = req.query.event;
    if (req.query.success !== undefined) filter.success = req.query.success === 'true';

    const [items, total] = await Promise.all([
      WebhookDelivery.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WebhookDelivery.countDocuments(filter),
    ]);

    return res.json({ total, page, limit, items });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/webhook-endpoints/:id/test ──────────────────────────────────────
/**
 * Send a signed `webhook.test` event with sample data to the endpoint through
 * the normal signing/delivery path and return the receiver's status code and
 * latency (#1639). Works for inactive endpoints too, so a receiver can be
 * verified before the endpoint is switched on. A failed test is not retried.
 */
async function sendTestEvent(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId }).select('+secret +previousSecret');
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    const result = await sendTestDelivery(endpoint);

    await logAudit({
      schoolId,
      action: 'webhook_test_sent',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: {
        deliveryId: result.deliveryId,
        event: result.event,
        success: result.success,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        error: result.error,
      },
    });

    return res.json({
      success: result.success,
      event: result.event,
      deliveryId: result.deliveryId,
      statusCode: result.statusCode,
      latencyMs: result.durationMs,
      error: result.error,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/webhook-deliveries/:id/replay ───────────────────────────────────
async function replayDelivery(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    const delivery = await WebhookDelivery.findById(req.params.id).lean();
    if (!delivery) return res.status(404).json({ error: 'Delivery not found', code: 'NOT_FOUND' });
    if (delivery.schoolId !== schoolId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    // Fetch the endpoint to get current URL + secret
    const endpoint = await WebhookEndpoint.findOne({ _id: delivery.endpointId, schoolId }).select('+secret');
    if (!endpoint) return res.status(404).json({ error: 'Associated endpoint not found', code: 'NOT_FOUND' });

    const newDeliveryId = uuidv4();

    const result = await fireWebhook(
      endpoint.url,
      delivery.event,
      delivery.payload,
      endpoint.secret,
      newDeliveryId,
      delivery.endpointId,
      schoolId,
    );

    await logAudit({
      schoolId,
      action: 'webhook_delivery_replayed',
      performedBy: _performedBy(req),
      targetId: String(delivery._id),
      targetType: 'school',
      details: { originalDeliveryId: delivery.deliveryId, newDeliveryId, success: result.success },
    });

    return res.json({ success: result.success, deliveryId: newDeliveryId, statusCode: result.statusCode });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createEndpoint,
  listEndpoints,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
  rotateSecret,
  sendTestEvent,
  listDeliveries,
  replayDelivery,
};
