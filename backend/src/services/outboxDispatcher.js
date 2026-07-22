'use strict';

const Outbox = require('../models/outboxModel');
const paymentEvents = require('../events/paymentEvents');
const logger = require('../utils/logger').child('OutboxDispatcher');

const BATCH_SIZE = 100;
const DISPATCH_INTERVAL_MS = parseInt(process.env.OUTBOX_DISPATCH_INTERVAL_MS, 10) || 5000;
let _dispatchTimer = null;

async function dispatchOutboxEvents() {
  try {
    const batch = await Outbox.find({ processed: false }).limit(BATCH_SIZE).sort({ createdAt: 1 });

    for (const event of batch) {
      try {
        paymentEvents.emit(event.eventType, event.payload);
        await Outbox.findByIdAndUpdate(event._id, {
          processed: true,
          processedAt: new Date(),
        });
      } catch (err) {
        const retryCount = (event.retryCount || 0) + 1;
        const maxRetries = 3;

        if (retryCount >= maxRetries) {
          logger.error('Outbox event exceeded max retries', {
            eventId: event.eventId,
            eventType: event.eventType,
            error: err.message,
          });
          await Outbox.findByIdAndUpdate(event._id, {
            retryCount,
            lastError: err.message,
          });
        } else {
          await Outbox.findByIdAndUpdate(event._id, {
            retryCount,
            lastError: err.message,
          });
        }
      }
    }

    if (batch.length > 0) {
      logger.debug('Dispatched outbox events', { count: batch.length });
    }
  } catch (err) {
    logger.error('Outbox dispatch error', { error: err.message });
  }
}

function startOutboxDispatcher() {
  if (_dispatchTimer) return;
  // dispatchOutboxEvents already catches everything it awaits internally, but
  // passing an async function straight to setInterval is a structural trap:
  // Node never observes the returned promise, so any *future* change that adds
  // an await outside its try/catch would silently become an unhandled
  // rejection — and, per docs/error-handling.md, that crashes the whole
  // multi-tenant process over a background job affecting a single school's
  // event. This terminal .catch() is the boundary that makes that impossible
  // regardless of what dispatchOutboxEvents does internally.
  _dispatchTimer = setInterval(() => {
    dispatchOutboxEvents().catch((err) => {
      logger.error('Outbox dispatch tick failed unexpectedly', { error: err.message, stack: err.stack });
    });
  }, DISPATCH_INTERVAL_MS);
  if (_dispatchTimer.unref) _dispatchTimer.unref();
  logger.info('Outbox dispatcher started');
}

function stopOutboxDispatcher() {
  if (_dispatchTimer) {
    clearInterval(_dispatchTimer);
    _dispatchTimer = null;
    logger.info('Outbox dispatcher stopped');
  }
}

module.exports = {
  dispatchOutboxEvents,
  startOutboxDispatcher,
  stopOutboxDispatcher,
};
