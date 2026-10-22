'use strict';

/**
 * Issue #1818 — per-school ingest start point.
 *
 * A school's wallet only ingests transactions dated at or after
 * `ingestStartsAt`, so a busy pre-existing wallet does not replay its history.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.POLL_INTERVAL_MS = '30000';

const fs = require('fs');
const path = require('path');

const { isBeforeIngestStart } = require('../backend/src/utils/ingestWindow');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('isBeforeIngestStart (#1818)', () => {
  const START = '2026-06-01T00:00:00.000Z';
  const school = { ingestStartsAt: new Date(START) };

  it('skips a transaction created before the ingest start', () => {
    expect(isBeforeIngestStart({ created_at: '2026-05-31T23:59:59Z' }, school)).toBe(true);
  });

  it('keeps a transaction created exactly at the ingest start', () => {
    expect(isBeforeIngestStart({ created_at: START }, school)).toBe(false);
  });

  it('keeps a transaction created after the ingest start', () => {
    expect(isBeforeIngestStart({ created_at: '2026-06-02T10:00:00Z' }, school)).toBe(false);
  });

  it('applies no lower bound when the school has no ingestStartsAt (legacy schools)', () => {
    expect(isBeforeIngestStart({ created_at: '2001-01-01T00:00:00Z' }, { ingestStartsAt: null })).toBe(false);
  });

  it('does not skip when the transaction has no usable timestamp', () => {
    expect(isBeforeIngestStart({}, school)).toBe(false);
    expect(isBeforeIngestStart({ created_at: 'not-a-date' }, school)).toBe(false);
  });

  it('accepts an ingestStartsAt stored as an ISO string', () => {
    const iso = { ingestStartsAt: START };
    expect(isBeforeIngestStart({ created_at: '2026-05-01T00:00:00Z' }, iso)).toBe(true);
  });
});

describe('ingest start is set when a school is created or its wallet rotated (#1818)', () => {
  const CONTROLLER = SRC('backend/src/controllers/schoolController.js');

  it('createSchool sets ingestStartsAt to the current time', () => {
    expect(CONTROLLER).toMatch(/ingestStartsAt: new Date\(\)/);
  });

  it('rotateStellarAddress resets ingestStartsAt alongside the cursor', () => {
    const rotate = CONTROLLER.slice(CONTROLLER.indexOf('async function rotateStellarAddress'));
    const cursorIdx = rotate.indexOf('school.syncCursor = null');
    const ingestIdx = rotate.indexOf('school.ingestStartsAt = new Date()');
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeGreaterThan(cursorIdx);
  });

  it('the School schema declares ingestStartsAt as a nullable Date', () => {
    expect(SRC('backend/src/models/schoolModel.js')).toMatch(/ingestStartsAt:\s*\{ type: Date, default: null \}/);
  });
});

describe('poller applies the ingest filter before processing (#1818)', () => {
  const POLLER = SRC('backend/src/services/transactionPollingService.js');

  it('checks isBeforeIngestStart before calling processTransaction in the page loop', () => {
    const loop = POLLER.slice(POLLER.indexOf('for (const tx of records)'));
    expect(loop.indexOf('isBeforeIngestStart(tx, school)')).toBeLessThan(
      loop.indexOf('processTransaction(tx, school, fencingToken)'),
    );
  });
});
