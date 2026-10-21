const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_VARS = ['MONGO_URI', 'JWT_SECRET', 'RECEIPT_SIGNATURE_SECRET'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Please set them in your environment or .env file.'
    );
  }

  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }
}

validateEnv();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  receiptSignatureSecret: process.env.RECEIPT_SIGNATURE_SECRET,
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
};

module.exports = config;
