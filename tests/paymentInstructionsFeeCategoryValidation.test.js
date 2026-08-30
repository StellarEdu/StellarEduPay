'use strict';

/**
 * #1377: the feeCategory query parameter on
 * GET /api/payments/instructions/:studentId reached the student/payment lookup
 * with no Joi validation, so a malformed value could produce unexpected query
 * behaviour and surface internal fee-structure naming in error messages.
 */

const {
  getPaymentInstructionsQuerySchema,
} = require('../backend/src/middleware/schemas/paymentQuerySchemas');

const {
  validatePaymentInstructionsQuery,
} = require('../backend/src/middleware/validate');

// === Helpers

function runMiddleware(query) {
  const req = { query };
  const captured = {};
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
  let nextCalled = false;
  validatePaymentInstructionsQuery(req, res, () => {
    nextCalled = true;
  });
  return { req, captured, nextCalled };
}

// === Tests

describe('getPaymentInstructionsQuerySchema', () => {
  test.each([
    'tuition',
    'TUITION',
    'term_2',
    'lab-fee',
    'Bus2026',
    'a'.repeat(100),
  ])('accepts %s', (feeCategory) => {
    expect(getPaymentInstructionsQuerySchema.validate({ feeCategory }).error).toBeUndefined();
  });

  test.each([
    ['a regex metacharacter payload', '.*'],
    ['a mongo operator payload', '$ne'],
    ['a json object payload', '{"$gt":""}'],
    ['whitespace', 'lab fee'],
    ['a dotted path', 'fees.category'],
    ['an empty string', ''],
    ['a value over 100 characters', 'a'.repeat(101)],
  ])('rejects %s', (_label, feeCategory) => {
    expect(getPaymentInstructionsQuerySchema.validate({ feeCategory }).error).toBeDefined();
  });

  test('feeCategory is optional', () => {
    expect(getPaymentInstructionsQuerySchema.validate({}).error).toBeUndefined();
  });

  test('leaves other query parameters alone', () => {
    const { error, value } = getPaymentInstructionsQuerySchema.validate({ asset: 'USDC:GBUQ' });
    expect(error).toBeUndefined();
    expect(value.asset).toBe('USDC:GBUQ');
  });
});

describe('validatePaymentInstructionsQuery middleware', () => {
  test('calls next for a well-formed feeCategory', () => {
    const { captured, nextCalled } = runMiddleware({ feeCategory: 'tuition' });
    expect(nextCalled).toBe(true);
    expect(captured.status).toBeUndefined();
  });

  test('calls next when feeCategory is absent', () => {
    const { nextCalled } = runMiddleware({});
    expect(nextCalled).toBe(true);
  });

  test('returns 400 VALIDATION_ERROR for a malformed feeCategory', () => {
    const { captured, nextCalled } = runMiddleware({ feeCategory: '{"$gt":""}' });
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe('VALIDATION_ERROR');
    expect(captured.body.errors[0].field).toBe('feeCategory');
  });

  test('returns 400 VALIDATION_ERROR for a feeCategory over 100 characters', () => {
    const { captured, nextCalled } = runMiddleware({ feeCategory: 'a'.repeat(101) });
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe('VALIDATION_ERROR');
  });

  test('does not echo the rejected value back to the caller', () => {
    const secret = '$where:sleep(1)';
    const { captured } = runMiddleware({ feeCategory: secret });
    expect(JSON.stringify(captured.body)).not.toContain(secret);
  });
});
