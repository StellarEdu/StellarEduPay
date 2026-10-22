'use strict';

/**
 * Covers the metrics added to close the payment-processing alerting gap:
 * MongoDB connection health. Alert rules in monitoring/alerts/ read these
 * directly, so a silent regression here means those alerts go blind.
 */

const mongoose = require('mongoose');

const {
  mongoConnectionState,
  mongoConnectionErrorsTotal,
} = require('../src/metrics');

async function gaugeValue(gauge) {
  const result = await gauge.get();
  return result.values[0] ? result.values[0].value : undefined;
}

beforeEach(() => {
  mongoConnectionErrorsTotal.reset();
});

describe('mongodb_connection_state', () => {
  test('reflects the live mongoose readyState', async () => {
    mongoose.connection.readyState = 1;
    expect(await gaugeValue(mongoConnectionState)).toBe(1);

    mongoose.connection.readyState = 0;
    expect(await gaugeValue(mongoConnectionState)).toBe(0);
  });
});

describe('mongodb_connection_errors_total', () => {
  test('increments when the driver emits an error event', async () => {
    const database = require('../src/config/database');
    database.setupConnectionEventHandlers();
    mongoose.connection.emit('error', new Error('simulated connection error'));
    expect(await gaugeValue(mongoConnectionErrorsTotal)).toBe(1);
  });
});
