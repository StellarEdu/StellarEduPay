'use strict';

const OutboxEvent = require('../models/OutboxEvent');
const logger = require('../utils/logger');
const { createScheduledJob } = require('../utils/scheduledJob');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Dispatches pending outbox events to their handlers.
 *
 * The interval loop is wrapped in createScheduledJob so a slow dispatch
 * (large backlog, slow downstream) can never overlap with the next tick.
 * Records are also claimed atomically before processing so correctness does
 * not depend on the re-entrancy guard alone.
 */
class OutboxDispatcher {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    this.handlers = options.handlers || new Map();
    this.job = null;
  }

  registerHandler(eventType, handler) {
    this.handlers.set(eventType, handler);
  }

  async dispatchBatch() {
    const now = new Date();
    const events = await OutboxEvent.find({
      status: 'pending',
      nextAttemptAt: { $lte: now },
    })
      .sort({ createdAt: 1 })
      .limit(this.batchSize);

    for (const event of events) {
      // Atomically claim the event so concurrent dispatchers (or a retried
      // tick) cannot process the same record twice.
      const claimed = await OutboxEvent.findOneAndUpdate(
        { _id: event._id, status: 'pending' },
        { $set: { status: 'processing', processingAt: new Date() } },
        { new: true }
      );

      if (!claimed) {
        continue;
      }

      await this.processEvent(claimed);
    }

    return events.length;
  }

  async processEvent(event) {
    const handler = this.handlers.get(event.type);

    if (!handler) {
      logger.warn(`[outboxDispatcher] No handler registered for event type: ${event.type}`);
      await this.markFailed(event, new Error(`No handler for event type: ${event.type}`));
      return;
    }

    try {
      await handler(event.payload, event);
      await OutboxEvent.updateOne(
        { _id: event._id },
        { $set: { status: 'completed', processedAt: new Date() } }
      );
    } catch (error) {
      logger.error(`[outboxDispatcher] Failed to process event ${event._id}: ${error.message}`);
      await this.markFailed(event, error);
    }
  }

  async markFailed(event, error) {
    const attempts = (event.attempts || 0) + 1;
    const exhausted = attempts >= this.maxAttempts;
    const backoffMs = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);

    await OutboxEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: exhausted ? 'failed' : 'pending',
          attempts,
          lastError: error.message,
          nextAttemptAt: exhausted ? event.nextAttemptAt : new Date(Date.now() + backoffMs),
        },
      }
    );
  }

  start() {
    if (this.job) {
      return this.job;
    }

    this.job = createScheduledJob({
      name: 'outboxDispatcher',
      intervalMs: this.intervalMs,
      run: () => this.dispatchBatch(),
    });

    this.job.start();
    return this.job;
  }

  async stop() {
    if (!this.job) {
      return;
    }

    await this.job.stop();
    this.job = null;
  }
}

module.exports = OutboxDispatcher;
