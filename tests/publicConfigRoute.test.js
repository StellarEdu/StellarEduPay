'use strict';

/**
 * Regression test for issue #1792: GET /api/public-config existed as a router
 * and controller but was never mounted, so the frontend's runtime network check
 * always got a 404 and the testnet/mainnet mismatch guard never fired.
 *
 * The full app cannot boot in every sandbox (backend config uses Joi `.secret()`,
 * which the locked joi version lacks), so this mounts the route the same way
 * app.js does, at /api/public-config, and checks the public contract.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/config', () => ({ STELLAR_NETWORK: 'testnet' }));

const publicConfigRoutes = require('../backend/src/routes/publicConfigRoutes');

function buildApp() {
  const app = express();
  app.use('/api/public-config', publicConfigRoutes);
  return app;
}

describe('Issue #1792 — GET /api/public-config', () => {
  it('returns 200 without authentication, with the runtime network', async () => {
    const res = await request(buildApp()).get('/api/public-config');

    expect(res.status).toBe(200);
    expect(res.body.stellarNetwork).toBe('testnet');
  });

  it('is cacheable for page-load traffic', async () => {
    const res = await request(buildApp()).get('/api/public-config');

    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('exposes only the public fields', async () => {
    const res = await request(buildApp()).get('/api/public-config');

    expect(Object.keys(res.body).sort()).toEqual(['apiVersion', 'stellarNetwork']);
  });
});
