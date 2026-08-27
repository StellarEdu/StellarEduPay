'use strict';

const Outbox = require('../models/outboxModel');
const logger = require('../utils/logger').child('OutboxAdminController');
const { logAudit } = require('../services/auditService');

/**
 * GET /api/admin/outbox/dead-letter
 * List all dead-lettered outbox events
 */
async function listDeadLetterEvents(req, res, next) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;

    const total = await Outbox.countDocuments({ deadLettered: true });
    const events = await Outbox.find({ deadLettered: true })
      .sort({ deadLetteredAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    res.json({
      events,
      total,
      limit,
      offset,
    });
  } catch (err) {
    logger.error('Failed to list dead-letter events', { error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/outbox/dead-letter/:eventId
 * Get details of a specific dead-lettered event
 */
async function getDeadLetterEventDetails(req, res, next) {
  try {
    const { eventId } = req.params;

    const event = await Outbox.findOne({ eventId, deadLettered: true }).lean();

    if (!event) {
      return res.status(404).json({
        error: `Dead-letter event ${eventId} not found`,
        code: 'EVENT_NOT_FOUND',
      });
    }

    res.json(event);
  } catch (err) {
    logger.error('Failed to get dead-letter event details', { eventId: req.params.eventId, error: err.message });
    next(err);
  }
}

/**
 * POST /api/admin/outbox/dead-letter/:eventId/replay
 * Replay a dead-lettered outbox event
 */
async function replayDeadLetterEvent(req, res, next) {
  try {
    const { eventId } = req.params;

    const event = await Outbox.findOne({ eventId, deadLettered: true });

    if (!event) {
      return res.status(404).json({
        error: `Dead-letter event ${eventId} not found`,
        code: 'EVENT_NOT_FOUND',
      });
    }

    // Reset to pending state for re-dispatch
    await Outbox.findByIdAndUpdate(event._id, {
      processed: false,
      deadLettered: false,
      deadLetteredAt: null,
      deadLetterReason: null,
      retryCount: 0,
      lastError: null,
    });

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'replay_dead_letter_outbox_event',
        performedBy: req.auditContext.performedBy,
        targetId: eventId,
        targetType: 'outbox_event',
        details: { eventId, eventType: event.eventType },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Replayed dead-letter event', { eventId, eventType: event.eventType });

    res.json({
      success: true,
      eventId,
      message: 'Event queued for re-dispatch',
    });
  } catch (err) {
    logger.error('Failed to replay dead-letter event', { eventId: req.params.eventId, error: err.message });
    next(err);
  }
}

/**
 * DELETE /api/admin/outbox/dead-letter/:eventId
 * Discard a dead-lettered event permanently
 */
async function discardDeadLetterEvent(req, res, next) {
  try {
    const { eventId } = req.params;

    const event = await Outbox.findOne({ eventId, deadLettered: true });

    if (!event) {
      return res.status(404).json({
        error: `Dead-letter event ${eventId} not found`,
        code: 'EVENT_NOT_FOUND',
      });
    }

    await Outbox.findByIdAndDelete(event._id);

    if (req.auditContext) {
      await logAudit({
        schoolId: 'system',
        action: 'discard_dead_letter_outbox_event',
        performedBy: req.auditContext.performedBy,
        targetId: eventId,
        targetType: 'outbox_event',
        details: { eventId, eventType: event.eventType },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    logger.info('Discarded dead-letter event', { eventId, eventType: event.eventType });

    res.json({
      success: true,
      eventId,
    });
  } catch (err) {
    logger.error('Failed to discard dead-letter event', { eventId: req.params.eventId, error: err.message });
    next(err);
  }
}

/**
 * GET /api/admin/outbox/stats
 * Get outbox queue statistics including dead-letter count
 */
async function getOutboxStats(req, res, next) {
  try {
    const [
      totalEvents,
      processedEvents,
      deadLetterEvents,
      pendingEvents,
      recentDeadLetters,
    ] = await Promise.all([
      Outbox.countDocuments({}),
      Outbox.countDocuments({ processed: true }),
      Outbox.countDocuments({ deadLettered: true }),
      Outbox.countDocuments({ processed: false, deadLettered: false }),
      Outbox.find({ deadLettered: true })
        .sort({ deadLetteredAt: -1 })
        .limit(10)
        .lean(),
    ]);

    res.json({
      total: totalEvents,
      processed: processedEvents,
      deadLettered: deadLetterEvents,
      pending: pendingEvents,
      recentDeadLetters: recentDeadLetters.map(e => ({
        eventId: e.eventId,
        eventType: e.eventType,
        deadLetteredAt: e.deadLetteredAt,
        deadLetterReason: e.deadLetterReason,
        lastError: e.lastError,
      })),
    });
  } catch (err) {
    logger.error('Failed to get outbox stats', { error: err.message });
    next(err);
  }
}

module.exports = {
  listDeadLetterEvents,
  getDeadLetterEventDetails,
  replayDeadLetterEvent,
  discardDeadLetterEvent,
  getOutboxStats,
};
