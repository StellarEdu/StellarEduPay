'use strict';

/**
 * OpenAPI specification for StellarEduPay API
 * Issue #671: Serves at GET /api/docs.json
 */

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

// Issue #1632: backend/openapi.json is the single source of truth for the HTTP
// contract. It is generated from the routers by scripts/openapi/generate.js and
// CI fails when it drifts (undocumented routes, stale paths, frontend/docs
// calls to paths that do not exist). Hand-written summaries, request bodies and
// responses live in that file; @swagger JSDoc blocks in the routers are merged
// on top for the few endpoints that still carry them.
const contract = require('../../openapi.json');

const options = {
  definition: {
    ...contract,
    servers: [
      {
        url: process.env.API_ORIGIN || 'http://localhost:5000',
        description: 'API Server',
      },
    ],
  },
  // Absolute so annotations are found regardless of the process CWD (the
  // relative './backend/src/...' globs only matched from the repo root).
  apis: [path.join(__dirname, '../routes/*.js')],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
