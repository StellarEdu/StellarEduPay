'use strict';

const logger = require('../utils/logger').child('ErrorHandler');

const ERROR_STATUS_MAP = {
  TX_FAILED: 400, MISSING_MEMO: 400, INVALID_DESTINATION: 400, UNSUPPORTED_ASSET: 400,
  VALIDATION_ERROR: 400, UNDERPAID: 400, MISSING_SCHOOL_CONTEXT: 400,
  MISSING_IDEMPOTENCY_KEY: 400, INVALID_AMOUNT: 400, AMOUNT_TOO_LOW: 400,
  AMOUNT_TOO_HIGH: 400, INVALID_HASH_FORMAT: 400,
  INVALID_TRANSITION: 400,
  NOT_FOUND: 404, SCHOOL_NOT_FOUND: 404, STUDENT_NOT_FOUND: 404, PAYMENT_NOT_FOUND: 404,
  DUPLICATE_TX: 409, DUPLICATE_SCHOOL: 409, DUPLICATE_STUDENT: 409, DUPLICATE_IDEMPOTENCY_KEY: 409,
  STELLAR_NETWORK_ERROR: 502, HORIZON_ERROR: 502,
  REQUEST_TIMEOUT: 503, SERVICE_UNAVAILABLE: 503, HORIZON_UNAVAILABLE: 503,
};

function errorResponse(message, code = 'INTERNAL_ERROR', details = null) {
  const r = { success: false, error: { message, code } };
  if (details) r.error.details = details;
  return r;
}

function successResponse(data, message = null, meta = {}) {
  const r = { success: true, data };
  if (message) r.message = message;
  if (Object.keys(meta).length > 0) r.meta = meta;
  return r;
}

function globalErrorHandler(err, req, res, next) {
  const statusCode = ERROR_STATUS_MAP[err.code] || err.status || err.statusCode || 500;
  const logCtx = { code: err.code, message: err.message, status: statusCode, path: req.path, method: req.method, requestId: req.requestId, schoolId: req.schoolId, stack: err.stack };
  statusCode >= 500 ? logger.error('Server error', logCtx) : logger.warn('Client error', logCtx);

  // In production, never expose internal error messages or stack traces for 5xx errors.
  const isProduction = process.env.NODE_ENV === 'production';
  const clientMessage = (isProduction && statusCode >= 500)
    ? 'An internal server error occurred.'
    : err.message;

  const body = errorResponse(clientMessage, err.code || 'INTERNAL_ERROR', err.details || null);
  if (process.env.NODE_ENV === 'development' && err.stack) body.error.stack = err.stack;
  res.status(statusCode).json(body);
}

function notFoundHandler(req, res) {
  res.status(404).json(errorResponse(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { successResponse, errorResponse, globalErrorHandler, notFoundHandler, asyncHandler };
