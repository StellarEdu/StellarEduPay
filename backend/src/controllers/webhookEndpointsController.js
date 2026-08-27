'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const WebhookEndpoint = require('../models/webhookEndpointModel');
const { WEBHOOK_EVENTS } = require('../models/webhookEndpointModel');
const WebhookDelivery = require('../models/webhookDeliveryModel');
const { validateWebhookUrl } = require('../utils/validateWebhookUrl');
const { logAudit } = require('../services/auditService');
const { fireWebhook } = require('../services/webhookService');
const logger = require('../utils/logger').child('WebhookEndpointsController');

// ── Helpers ───────────────────────────────────────────────────────────────────

function _generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function _callerSchoolId(req) {
  // Prefer the JWT's schoolId (tenant-scoped); fall back to header.
  return req.user?.schoolId || req.admin?.schoolId || req.headers['x-school-id'] || null;
}

function _performedBy(req) {
  return req.user?.email || req.admin?.email || req.user?.sub || req.admin?.sub || 'unknown';
}

// ── POST /api/webhook-endpoints ───────────────────────────────────────────────
async function createEndpoint(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    if (!schoolId) return res.status(400).json({ error: 'schoolId required', code: 'MISSING_SCHOOL_ID' });

    const { url, secret, subscribedEvents, isActive = true, description } = req.body;

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

    // SSRF validation
    const urlCheck = await validateWebhookUrl(url);
    if (!urlCheck.valid) {
      return res.status(400).json({
        error: 'URL is not a valid public HTTPS endpoint',
        code: 'INVALID_WEBHOOK_URL',
      });
    }

    const endpointSecret = secret || _generateSecret();

    const endpoint = await WebhookEndpoint.create({
      schoolId,
      url,
      secret: endpointSecret,
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
      details: { url, subscribedEvents, isActive },
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
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId });
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    const { url, secret, subscribedEvents, isActive, description } = req.body;

    if (url !== undefined) {
      const urlCheck = await validateWebhookUrl(url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: 'URL is not a valid public HTTPS endpoint', code: 'INVALID_WEBHOOK_URL' });
      }
      endpoint.url = url;
    }
    if (secret !== undefined) endpoint.secret = secret;
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
      details: { url: endpoint.url, subscribedEvents: endpoint.subscribedEvents, isActive: endpoint.isActive },
    });

    const obj = endpoint.toJSON(); // secret stripped
    return res.json(obj);
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
async function sendTestEvent(req, res, next) {
  try {
    const schoolId = _callerSchoolId(req);
    const endpoint = await WebhookEndpoint.findOne({ _id: req.params.id, schoolId });
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });

    const deliveryId = uuidv4();
    const testPayload = {
      testMode: true,
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook event from StellarEduPay',
    };

    const result = await fireWebhook(
      endpoint.url,
      'payment.test',
      testPayload,
      endpoint.secret,
      deliveryId,
      endpoint._id,
      schoolId,
    );

    await logAudit({
      schoolId,
      action: 'webhook_test_sent',
      performedBy: _performedBy(req),
      targetId: String(endpoint._id),
      targetType: 'school',
      details: { deliveryId, success: result.success },
    });

    return res.json({
      success: result.success,
      deliveryId,
      statusCode: result.statusCode,
      error: result.error || null,
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
    const endpoint = await WebhookEndpoint.findById(delivery.endpointId);
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
  sendTestEvent,
  listDeliveries,
  replayDelivery,
};
