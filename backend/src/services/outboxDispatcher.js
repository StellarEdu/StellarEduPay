'use strict';

/**
 * outboxDispatcher.js — reliable transactional outbox dispatcher (issue #1646)
 *
 * Problems in the old dispatcher that this rewrite fixes:
 *
 *   1. No claim/lease step — every replica read the same unprocessed events and
 *      delivered them to all listeners, causing duplicate webhooks, emails, etc.
 *
 *   2. No overlap guard — if a dispatch batch took longer than the poll interval
 *      (slow webhook / SMTP) the next tick re-read the same still-unprocessed
 *      events and emitted them again.
 *
 *   3. Per-event retry without per-listener tracking — a single failing listener
 *      caused all listeners (including successful ones) to be re-invoked on
 *      every retry, creating duplicate side-effects for the successful ones.
 *
 *   4. No backoff — retries happened on the very next tick, burning through the
 *      max-retry budget in ~15 s and dead-lettering the event prematurely.
 *
 * Solutions implemented here:
 *
 *   A. Atomic MongoDB claim
 *      findOneAndUpdate with a predicate on { status: 'pending', nextAttemptAt,
 *      lockedUntil } so only one dispatcher (on any replica, on any tick) can
 *      hold a given event at a time.
 *
 *   B. Re-entrancy guard via setTimeout chaining (never overlapping ticks)
 *      The next poll is scheduled only after the current batch fully resolves.
 *      Combined with (A) this gives two independent layers of protection against
 *      duplicate delivery within and across replicas.
 *
 *   C. Per-listener delivery tracking (deliveredTo[])
 *      After each listener succeeds its name is appended to deliveredTo. On any
 *      retry only listeners NOT in deliveredTo are called. A listener that
 *      already succeeded is never invoked twice for the same event.
 *
 *   D. Exponential backoff (nextAttemptAt)
 *      nextAttemptAt = now + min(BASE_BACKOFF_MS * 2^retryCount, MAX_BACKOFF_MS)
 *      so a repeatedly failing listener is retried with increasing delays rather
 *      than hammering the downstream at maximum frequency.
 *
 *   E. Stale-lease recovery
 *      Events whose status is 'processing' but whose lockedUntil is in the past
 *      are reset to 'pending' so they can be reclaimed after a crash or timeout.
 */

const os = require('os');
const Outbox = require('../models/outboxModel');
const paymentEvents = require('../events/paymentEvents');
const logger = require('../utils/logger');
const { withSpan, withExtractedContext } = require('../tracing');

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS  = parseInt(process.env.OUTBOX_INTERVAL_MS,  10) || 5_000;
const DEFAULT_BATCH_SIZE   = parseInt(process.env.OUTBOX_BATCH_SIZE,   10) || 50;
const DEFAULT_MAX_RETRIES  = parseInt(process.env.OUTBOX_MAX_RETRIES,  10) || 10;
// Lease duration must comfortably exceed the worst-case dispatch time for a
// single batch (slow webhook receivers + SMTP latency). 30 s is a safe default.
const LEASE_DURATION_MS    = parseInt(process.env.OUTBOX_LEASE_MS,     10) || 30_000;
// Backoff: 1 s, 2 s, 4 s, 8 s … capped at 10 min.
const BASE_BACKOFF_MS      = parseInt(process.env.OUTBOX_BASE_BACKOFF_MS, 10) || 1_000;
const MAX_BACKOFF_MS       = parseInt(process.env.OUTBOX_MAX_BACKOFF_MS,  10) || 600_000;

// Unique per-process identifier used in lockedBy. Helps operators pinpoint
// which replica holds (or held) a given lease during debugging.
const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

// ── Internal state ────────────────────────────────────────────────────────────

let _running      = false;
let _timer        = null;
let _stopResolve  = null;   // resolves the Promise returned by stopOutboxDispatcher()

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute next attempt timestamp using truncated exponential backoff.
 * retryCount = 0  →  1 s
 * retryCount = 1  →  2 s
 * retryCount = 5  →  32 s
 * retryCount = 10 →  ~17 min (capped at MAX_BACKOFF_MS)
 */
function nextAttemptDate(retryCount) {
  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
  return new Date(Date.now() + backoffMs);
}

/**
 * Resolve the names of all listeners registered on paymentEvents for a given
 * eventType. Each listener's `.name` property is used as the stable identity
 * stored in deliveredTo[]. Anonymous listeners fall back to their positional
 * index so they are still distinguishable.
 */
function listenerNames(eventType) {
  return paymentEvents.rawListeners(eventType).map((fn, idx) => fn.name || `listener_${idx}`);
}

// ── Stale-lease recovery ──────────────────────────────────────────────────────

/**
 * Reset any events stuck in 'processing' with an expired lease back to
 * 'pending' so they can be reclaimed.  This handles crashes mid-dispatch and
 * dispatchers that exceeded their lease window.
 */
async function recoverStaleLeases() {
  const now = new Date();
  const result = await Outbox.updateMany(
    { status: 'processing', lockedUntil: { $lt: now } },
    {
      $set: {
        status: 'pending',
        lockedUntil: new Date(0),
        lockedBy: null,
      },
    }
  );
  if (result.modifiedCount > 0) {
    logger.warn('[outboxDispatcher] Recovered stale leases', { count: result.modifiedCount });
  }
}

// ── Core dispatch logic ───────────────────────────────────────────────────────

/**
 * Attempt to atomically claim one pending event.
 * Returns the claimed document, or null if no eligible event exists.
 */
async function claimNextEvent() {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

  return Outbox.findOneAndUpdate(
    {
      status: 'pending',
      nextAttemptAt: { $lte: now },
      lockedUntil:   { $lt: now },
    },
    {
      $set: {
        status:      'processing',
        lockedUntil: leaseExpiry,
        lockedBy:    INSTANCE_ID,
      },
    },
    {
      new: true,
      sort: { createdAt: 1 },  // oldest-first FIFO ordering
    }
  );
}

/**
 * Dispatch a single claimed event to all listeners that have not yet
 * received it. Updates deliveredTo[] incrementally on success.
 *
 * On full success:  status → 'completed', processedAt set.
 * On partial fail:  status → 'pending', nextAttemptAt backed off, retryCount++.
 * On budget exhaust: status → 'dead_letter'.
 */
async function dispatchEvent(event, maxRetries) {
  const allListeners  = paymentEvents.rawListeners(event.eventType);
  const allNames      = listenerNames(event.eventType);

  if (allListeners.length === 0) {
    logger.warn('[outboxDispatcher] No listeners for event type — dead-lettering', {
      eventId:   event.eventId,
      eventType: event.eventType,
    });
    await Outbox.updateOne(
      { _id: event._id },
      {
        $set: {
          status:           'dead_letter',
          deadLetteredAt:   new Date(),
          deadLetterReason: `No listeners registered for event type: ${event.eventType}`,
          lockedUntil:      new Date(0),
          lockedBy:         null,
        },
      }
    );
    return;
  }

  // Identify which listeners still need delivery (skip already-successful ones).
  const alreadyDelivered = new Set(event.deliveredTo || []);
  const pendingListeners = allListeners
    .map((fn, idx) => ({ fn, name: allNames[idx] }))
    .filter(({ name }) => !alreadyDelivered.has(name));

  if (pendingListeners.length === 0) {
    // All listeners already delivered — mark complete (edge case after crash
    // recovery where deliveredTo is complete but status wasn't updated).
    await Outbox.updateOne(
      { _id: event._id },
      {
        $set: {
          status:      'completed',
          processedAt: new Date(),
          lockedUntil: new Date(0),
          lockedBy:    null,
        },
      }
    );
    return;
  }

  // Invoke each pending listener independently.  We do NOT use asyncEmit here
  // so we can track per-listener outcomes and update deliveredTo atomically as
  // each listener succeeds (rather than all-or-nothing).
  const failedListeners = [];
  let lastError = null;

  for (const { fn, name } of pendingListeners) {
    try {
      // #1636: continue the trace of the transaction that wrote the event.
      await withExtractedContext(event.traceContext, () => withSpan(`outbox.dispatch ${event.eventType}`, {
        'outbox.event_id': String(event._id),
        'outbox.event_type': event.eventType,
        'outbox.attempt': (event.retryCount || 0) + 1,
        'outbox.listener': name,
      }, async () => {
        const result = fn(event.payload, event);
        if (result != null && typeof result.then === 'function') {
          await result;
        }
      }));
      // Success — record delivery immediately so a crash here still preserves
      // the fact that this listener succeeded (next retry skips it).
      await Outbox.updateOne(
        { _id: event._id },
        { $addToSet: { deliveredTo: name } }
      );
      logger.debug('[outboxDispatcher] Listener delivered', {
        eventId:   event.eventId,
        eventType: event.eventType,
        listener:  name,
      });
    } catch (err) {
      failedListeners.push(name);
      lastError = err.message;
      logger.error('[outboxDispatcher] Listener failed', {
        eventId:   event.eventId,
        eventType: event.eventType,
        listener:  name,
        error:     err.message,
      });
    }
  }

  if (failedListeners.length === 0) {
    // All listeners succeeded.
    await Outbox.updateOne(
      { _id: event._id },
      {
        $set: {
          status:      'completed',
          processedAt: new Date(),
          lockedUntil: new Date(0),
          lockedBy:    null,
        },
      }
    );
    logger.info('[outboxDispatcher] Event delivered to all listeners', {
      eventId:   event.eventId,
      eventType: event.eventType,
    });
    return;
  }

  // Some listeners failed — decide whether to retry or dead-letter.
  const newRetryCount = (event.retryCount || 0) + 1;
  const exhausted = newRetryCount >= maxRetries;

  if (exhausted) {
    await Outbox.updateOne(
      { _id: event._id },
      {
        $set: {
          status:           'dead_letter',
          deadLetteredAt:   new Date(),
          deadLetterReason: `Exhausted ${maxRetries} retries. Last error: ${lastError}`,
          retryCount:       newRetryCount,
          lastError,
          lockedUntil:      new Date(0),
          lockedBy:         null,
        },
      }
    );
    logger.error('[outboxDispatcher] Event dead-lettered after exhausting retries', {
      eventId:        event.eventId,
      eventType:      event.eventType,
      retryCount:     newRetryCount,
      failedListeners,
    });
  } else {
    await Outbox.updateOne(
      { _id: event._id },
      {
        $set: {
          status:        'pending',
          nextAttemptAt: nextAttemptDate(newRetryCount),
          retryCount:    newRetryCount,
          lastError,
          lockedUntil:   new Date(0),
          lockedBy:      null,
        },
      }
    );
    logger.warn('[outboxDispatcher] Event rescheduled for retry', {
      eventId:        event.eventId,
      eventType:      event.eventType,
      retryCount:     newRetryCount,
      failedListeners,
      nextAttemptAt:  nextAttemptDate(newRetryCount),
    });
  }
}

/**
 * Process one full batch: recover stale leases, then claim-and-dispatch events
 * up to BATCH_SIZE.  Claims are issued sequentially (one at a time) rather than
 * pre-fetching a list, so each claim is an independent atomic operation that
 * cannot race with another replica's concurrent batch.
 */
async function dispatchBatch(batchSize, maxRetries) {
  await recoverStaleLeases();

  let processed = 0;

  for (let i = 0; i < batchSize; i++) {
    const event = await claimNextEvent();
    if (!event) break;  // no more eligible events this tick

    await dispatchEvent(event, maxRetries);
    processed++;
  }

  if (processed > 0) {
    logger.debug('[outboxDispatcher] Batch complete', { processed });
  }

  return processed;
}

// ── Scheduler (re-entrancy guard via setTimeout chaining) ─────────────────────

/**
 * Schedule the next tick only after the current one completes.  This is the
 * re-entrancy guard: because we only call setTimeout *after* dispatchBatch
 * resolves, a slow batch (slow webhook, SMTP, heavy backlog) can never overlap
 * with the next tick on the same replica.  Combined with atomic claiming this
 * gives two independent layers of protection against duplicate delivery.
 */
function scheduleTick(intervalMs, batchSize, maxRetries) {
  if (!_running) {
    // Dispatcher was stopped while a batch was in flight — resolve the stop
    // promise and exit without scheduling another tick.
    if (_stopResolve) {
      _stopResolve();
      _stopResolve = null;
    }
    return;
  }

  _timer = setTimeout(async () => {
    try {
      await dispatchBatch(batchSize, maxRetries);
    } catch (err) {
      // Log but do not crash the process — the scheduler itself continues.
      logger.error('[outboxDispatcher] Unexpected error in batch', { error: err.message });
    } finally {
      scheduleTick(intervalMs, batchSize, maxRetries);
    }
  }, intervalMs);

  // Allow Node.js to exit cleanly even if the timer is still pending.
  if (_timer.unref) _timer.unref();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the outbox dispatcher.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function startOutboxDispatcher({
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize  = DEFAULT_BATCH_SIZE,
  maxRetries = DEFAULT_MAX_RETRIES,
} = {}) {
  if (_running) {
    logger.warn('[outboxDispatcher] Already running — ignoring duplicate start()');
    return;
  }

  _running = true;
  logger.info('[outboxDispatcher] Starting', { intervalMs, batchSize, maxRetries, instanceId: INSTANCE_ID });
  scheduleTick(intervalMs, batchSize, maxRetries);
}

/**
 * Stop the outbox dispatcher gracefully.
 * Returns a Promise that resolves once the in-flight batch (if any) finishes.
 */
function stopOutboxDispatcher() {
  if (!_running) return Promise.resolve();

  _running = false;

  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    logger.info('[outboxDispatcher] Stopped (no batch in flight)');
    return Promise.resolve();
  }

  // A batch is currently in flight — resolve when scheduleTick() next runs
  // and notices _running === false.
  logger.info('[outboxDispatcher] Stopping — waiting for in-flight batch');
  return new Promise((resolve) => {
    _stopResolve = resolve;
  });
}

// ── Exported internals (for unit testing only) ────────────────────────────────

module.exports = {
  startOutboxDispatcher,
  stopOutboxDispatcher,
  // Exported for unit tests
  _dispatchBatch:    dispatchBatch,
  _dispatchEvent:    dispatchEvent,
  _claimNextEvent:   claimNextEvent,
  _recoverStaleLeases: recoverStaleLeases,
  _nextAttemptDate:  nextAttemptDate,
  _listenerNames:    listenerNames,
};
