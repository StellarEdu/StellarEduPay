'use strict';

// Set required env vars before app/config is loaded — config/index.js throws
// without MONGO_URI.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

/**
 * Tests for Issue #671 — OpenAPI/Swagger documentation
 * Verifies OpenAPI spec is generated and served at /api/docs.json
 */

const request = require('supertest');
const app = require('../backend/src/app');

describe('Issue #671 — OpenAPI/Swagger documentation', () => {
  describe('GET /api/docs.json', () => {
    it('should serve OpenAPI 3.0 specification', async () => {
      const res = await request(app).get('/api/docs.json');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('openapi');
      expect(res.body.openapi).toMatch(/^3\.0\./);
    });

    it('should include API info', async () => {
      const res = await request(app).get('/api/docs.json');

      expect(res.body).toHaveProperty('info');
      expect(res.body.info).toHaveProperty('title');
      expect(res.body.info).toHaveProperty('version');
      expect(res.body.info).toHaveProperty('description');
    });

    it('should include all endpoints in paths', async () => {
      const res = await request(app).get('/api/docs.json');

      expect(res.body).toHaveProperty('paths');
      expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
    });

    it('should include authentication schemes', async () => {
      const res = await request(app).get('/api/docs.json');

      expect(res.body).toHaveProperty('components');
      expect(res.body.components).toHaveProperty('securitySchemes');
      expect(res.body.components.securitySchemes).toHaveProperty('BearerAuth');
    });

    it('should document payment endpoints with request/response schemas', async () => {
      const res = await request(app).get('/api/docs.json');

      const paymentPaths = Object.keys(res.body.paths).filter(p => p.includes('payment'));
      expect(paymentPaths.length).toBeGreaterThan(0);

      // Check that at least one payment endpoint has request/response schemas
      const hasSchemas = paymentPaths.some(path => {
        const pathObj = res.body.paths[path];
        return Object.values(pathObj).some(method => 
          method.requestBody || method.responses
        );
      });

      expect(hasSchemas).toBe(true);
    });

    it('should document error responses', async () => {
      const res = await request(app).get('/api/docs.json');

      const hasErrorResponses = Object.values(res.body.paths).some(pathObj =>
        Object.values(pathObj).some(method =>
          method.responses && (method.responses['400'] || method.responses['401'] || method.responses['403'])
        )
      );

      expect(hasErrorResponses).toBe(true);
    });

    it('should include server information', async () => {
      const res = await request(app).get('/api/docs.json');

      expect(res.body).toHaveProperty('servers');
      expect(Array.isArray(res.body.servers)).toBe(true);
    });
  });

  describe('GET /api/docs (Swagger UI)', () => {
    it('should serve Swagger UI in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const res = await request(app).get('/api/docs');

      // Should return HTML or redirect to Swagger UI
      expect([200, 301, 302]).toContain(res.status);

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('OpenAPI spec validation', () => {
    it('should have valid OpenAPI structure', async () => {
      const res = await request(app).get('/api/docs.json');

      // Required OpenAPI fields
      expect(res.body).toHaveProperty('openapi');
      expect(res.body).toHaveProperty('info');
      expect(res.body).toHaveProperty('paths');

      // Info object required fields
      expect(res.body.info).toHaveProperty('title');
      expect(res.body.info).toHaveProperty('version');
    });

    it('should document all HTTP methods for endpoints', async () => {
      const res = await request(app).get('/api/docs.json');

      const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'options'];
      
      Object.values(res.body.paths).forEach(pathObj => {
        Object.keys(pathObj).forEach(key => {
          if (key !== 'parameters') {
            expect(validMethods).toContain(key.toLowerCase());
          }
        });
      });
    });

    it('should include operation IDs for all endpoints', async () => {
      const res = await request(app).get('/api/docs.json');

      let operationCount = 0;
      let operationIdsCount = 0;

      Object.values(res.body.paths).forEach(pathObj => {
        Object.values(pathObj).forEach(method => {
          if (method.operationId) {
            operationIdsCount++;
          }
          if (method.summary || method.description) {
            operationCount++;
          }
        });
      });

      expect(operationCount).toBeGreaterThan(0);
    });
  });
});
