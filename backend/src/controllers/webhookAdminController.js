'use strict';

const WebhookRetry = require('../models/webhookRetryModel');
const logger = require('../utils/logger');

/**
 * GET /api/admin/webhooks/dlq
 * Lists exhausted webhook deliveries (status: failed). Supports ?page and ?limit.
 */
async function listDLQ(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      WebhookRetry.find({ status: 'failed' })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WebhookRetry.countDocuments({ status: 'failed' }),
    ]);

    res.json({ total, page, limit, items });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/webhooks/dlq/:id/retry
 * Re-queues a single exhausted delivery for immediate retry.
 * Resets attempt count so it gets a full retry budget again.
 * Only accepts deliveries in 'failed' state.
 */
async function retryDLQEntry(req, res, next) {
  try {
    const entry = await WebhookRetry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Webhook delivery not found' });
    if (entry.status !== 'failed') {
      return res.status(409).json({ error: 'Delivery is not in failed state', status: entry.status });
    }

    await WebhookRetry.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: 'pending',
          attemptCount: 0,
          nextRetryAt: new Date(),
          lastError: null,
          leasedAt: null,
          leasedBy: null,
        },
      }
    );

    logger.info('DLQ entry re-queued by admin', { deliveryId: entry.deliveryId, url: entry.url });
    res.json({ success: true, deliveryId: entry.deliveryId });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/webhooks/:id/replay — Issue #73
 *
 * Manual replay endpoint for any webhook delivery regardless of status.
 * Unlike /dlq/:id/retry (which only accepts 'failed' entries), this endpoint
 * accepts deliveries in any state and immediately re-queues them for delivery.
 *
 * Use cases:
 *   - Replay a 'failed' delivery after a receiver outage is resolved.
 *   - Force immediate re-delivery of a 'pending' delivery (e.g. stuck clock).
 *   - Re-deliver a 'succeeded' delivery when the receiver lost the event.
 *
 * By default, attemptCount is reset to 0 so the delivery gets a fresh
 * retry budget. Pass ?resetAttempts=false to preserve the current count
 * (useful when re-delivering a succeeded event without burning a retry slot).
 */
async function replayWebhook(req, res, next) {
  try {
    const entry = await WebhookRetry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Webhook delivery not found' });

    const resetAttempts = req.query.resetAttempts !== 'false'; // default: true

    const update = {
      $set: {
        status: 'pending',
        nextRetryAt: new Date(), // immediate
        lastError: null,
        leasedAt: null,
        leasedBy: null,
      },
    };

    if (resetAttempts) {
      update.$set.attemptCount = 0;
    }

    await WebhookRetry.updateOne({ _id: entry._id }, update);

    logger.info('Webhook replay triggered by admin', {
      deliveryId: entry.deliveryId,
      url: entry.url,
      previousStatus: entry.status,
      resetAttempts,
    });

    res.json({
      success: true,
      deliveryId: entry.deliveryId,
      previousStatus: entry.status,
      resetAttempts,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listDLQ, retryDLQEntry, replayWebhook };
