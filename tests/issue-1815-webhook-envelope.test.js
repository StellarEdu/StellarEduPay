'use strict';

/**
 * Issue #1815 — webhook envelope: schema version and per-endpoint sequence.
 *
 * Every delivery declares `apiVersion`; endpoint-scoped deliveries carry a
 * monotonic `sequence` that retries reuse, so consumers can detect gaps.
 */

const fs = require('fs');
const path = require('path');
const { buildEventBody, WEBHOOK_API_VERSION } = require('../backend/src/utils/webhookEnvelope');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('buildEventBody (#1815)', () => {
  const base = { event: 'payment.confirmed', timestamp: '2026-10-18T00:00:00.000Z', data: { amount: '10' } };

  it('declares the API version on every delivery', () => {
    expect(buildEventBody(base).apiVersion).toBe(WEBHOOK_API_VERSION);
    expect(WEBHOOK_API_VERSION).toBe('2026-10-01');
  });

  it('includes the sequence when one is allocated', () => {
    expect(buildEventBody({ ...base, sequence: 42 }).sequence).toBe(42);
  });

  it('keeps event, timestamp and data unchanged', () => {
    expect(buildEventBody({ ...base, sequence: 1 })).toEqual({
      event: 'payment.confirmed',
      timestamp: '2026-10-18T00:00:00.000Z',
      apiVersion: WEBHOOK_API_VERSION,
      data: { amount: '10' },
      sequence: 1,
    });
  });

  it('omits sequence for legacy single-URL deliveries that have none', () => {
    expect(buildEventBody(base)).not.toHaveProperty('sequence');
    expect(buildEventBody({ ...base, sequence: null })).not.toHaveProperty('sequence');
  });

  it('keeps sequence 0 as a real value rather than dropping it', () => {
    expect(buildEventBody({ ...base, sequence: 0 }).sequence).toBe(0);
  });
});

describe('webhook sequencing wiring (#1815)', () => {
  const SERVICE = SRC('backend/src/services/webhookService.js');

  it('allocates the sequence atomically with $inc on the endpoint', () => {
    expect(SERVICE).toMatch(/findByIdAndUpdate\([\s\S]*\$inc: \{ eventSequence: 1 \}/);
  });

  it('allocates the sequence before the first send of each delivery', () => {
    const fire = SERVICE.slice(SERVICE.indexOf('async function fireWebhookToEndpoints'));
    expect(fire.indexOf('_nextEndpointSequence(ep._id)')).toBeLessThan(fire.indexOf('_sendToUrl({'));
  });

  it('passes the same sequence into the retry queue on failure', () => {
    expect(SERVICE).toMatch(/queueWebhookRetry\(ep\.url, event, rawPayload, result\.error, ep\.secret, deliveryId, ep\._id, schoolId, sequence\)/);
  });

  it('reuses the stored sequence when a retry is sent', () => {
    expect(SERVICE).toContain('sequence: retry.sequence ?? null');
  });

  it('builds the body through buildEventBody so the envelope is signed', () => {
    expect(SERVICE).toContain('buildEventBody({');
  });
});

describe('schema fields (#1815)', () => {
  it('endpoints store a non-negative eventSequence counter defaulting to 0', () => {
    expect(SRC('backend/src/models/webhookEndpointModel.js')).toMatch(/eventSequence: \{ type: Number, default: 0, min: 0 \}/);
  });

  it('retry records persist the sequence', () => {
    expect(SRC('backend/src/models/webhookRetryModel.js')).toMatch(/sequence: \{ type: Number, default: null \}/);
  });
});
