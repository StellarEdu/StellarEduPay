'use strict';

/**
 * OpenAPI 3.0 specification for StellarEduPay API
 * Issue #671: Serves at GET /api/docs.json
 */

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'StellarEduPay API',
      version: '1.0.0',
      description: 'Decentralized school fee payment system built on Stellar blockchain',
      contact: {
        name: 'StellarEduPay Support',
        url: 'https://github.com/manuelusman73-png/StellarEduPay',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: process.env.API_URL || 'http://localhost:5000/api',
        description: 'API Server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token for admin authentication',
        },
      },
      schemas: {
        Payment: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            studentId: { type: 'string' },
            txHash: { type: 'string' },
            amount: { type: 'number' },
            feeAmount: { type: 'number' },
            status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'INVALID'] },
            confirmedAt: { type: 'string', format: 'date-time' },
            feeValidationStatus: { type: 'string', enum: ['valid', 'underpaid', 'overpaid', 'partial', 'unknown'] },
          },
        },
        Student: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            studentId: { type: 'string' },
            name: { type: 'string' },
            class: { type: 'string' },
            feeAmount: { type: 'number' },
            contactEmail: { type: 'string', format: 'email' },
          },
        },
        School: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            schoolId: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            stellarAddress: { type: 'string' },
            network: { type: 'string', enum: ['testnet', 'mainnet'] },
            isActive: { type: 'boolean' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
    paths: {
      '/payments/verify/{txHash}': {
        get: {
          tags: ['Payments'],
          summary: 'Verify a payment by transaction hash',
          description:
            'Verifies a Stellar transaction hash. The hash must be a 64-character hex string; ' +
            'other values are rejected with 400. Receipt verification lives at ' +
            'GET /payments/receipts/{receiptId}/verify.',
          parameters: [
            {
              name: 'txHash',
              in: 'path',
              required: true,
              description: '64-character hex Stellar transaction hash',
              schema: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
            },
          ],
          responses: {
            200: { description: 'Transaction verification result' },
            400: { description: 'Invalid transaction hash format' },
            404: { description: 'Transaction not found' },
          },
        },
      },
      '/payments/receipts/{receiptId}/verify': {
        get: {
          tags: ['Payments'],
          summary: 'Verify a payment receipt by receipt ID',
          description:
            'Confirms that a printed or emailed receipt is genuine. Returns a minimal ' +
            'authenticity result only. This endpoint is distinct from ' +
            'GET /payments/verify/{txHash} so that receipt IDs are not shadowed by the ' +
            'transaction-hash route.',
          parameters: [
            {
              name: 'receiptId',
              in: 'path',
              required: true,
              description: 'Receipt identifier embedded in the receipt QR code',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: { description: 'Receipt authenticity result' },
            404: { description: 'Receipt not found' },
          },
        },
      },
    },
  },
  apis: [
    './backend/src/routes/*.js',
    './backend/src/controllers/*.js',
  ],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
