'use strict';

/**
 * Structured Logger Utility
 *
 * Provides consistent logging with levels, timestamps, and context.
 * Supports runtime log level changes via setLevel() — no server restart needed.
 *
 * File transports use DailyRotateFile (winston-daily-rotate-file):
 *   - logs/combined-%DATE%.log  — all levels
 *   - logs/error-%DATE%.log     — errors only
 * Rotation is controlled by LOG_MAX_SIZE (default: 100m) and
 * LOG_MAX_FILES (default: 14d) environment variables.
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const { redactPii, stripQueryString } = require('./piiRedaction');

const path = require('path');

const _fileTransports = process.env.LOG_TO_FILE === 'true' ? [
  new winston.transports.DailyRotateFile({
    filename:    path.join(process.env.LOG_DIR || 'logs', 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize:     process.env.LOG_MAX_SIZE  || '100m',
    maxFiles:    process.env.LOG_MAX_FILES || '14d',
  }),
  new winston.transports.DailyRotateFile({
    filename:    path.join(process.env.LOG_DIR || 'logs', 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level:       'error',
    maxSize:     process.env.LOG_MAX_SIZE  || '100m',
    maxFiles:    process.env.LOG_MAX_FILES || '14d',
  }),
] : [];

// Winston instance used solely for file rotation; console output is handled
// by the existing structured logger below so the log format stays unchanged.
const _winstonLogger = _fileTransports.length > 0 ? winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: _fileTransports,
}) : null;

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const VALID_LEVELS = Object.keys(LOG_LEVELS);

// Mutable runtime level — starts from env var, can be changed via setLevel()
let _currentLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
if (!VALID_LEVELS.includes(_currentLevel)) {
  _currentLevel = 'INFO';
}

/**
 * Set the log level at runtime. Takes effect immediately for all subsequent calls.
 * @param {string} level - One of 'debug' | 'info' | 'warn' | 'error' (case-insensitive)
 * @throws {Error} if level is invalid
 */
function setLevel(level) {
  const upper = (level || '').toUpperCase();
  if (!VALID_LEVELS.includes(upper)) {
    throw new Error(`Invalid log level "${level}". Must be one of: ${VALID_LEVELS.join(', ').toLowerCase()}`);
  }
  _currentLevel = upper;
}

/**
 * Get the current log level.
 * @returns {string} current level in lowercase
 */
function getLevel() {
  return _currentLevel.toLowerCase();
}

function shouldLog(level) {
  return LOG_LEVELS[level] <= LOG_LEVELS[_currentLevel];
}

function formatMessage(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const formattedArgs = args.map(arg => {
    if (arg instanceof Error) {
      return { message: arg.message, stack: arg.stack, ...arg };
    }
    return arg;
  });

  // Apply PII redaction to all log arguments at info level and above
  const redactedArgs = level !== 'DEBUG' 
    ? formattedArgs.map(redactPii)
    : formattedArgs;

  return {
    timestamp,
    level,
    message,
    args: redactedArgs.length > 0 ? redactedArgs : undefined,
    pid: process.pid,
  };
}

const logger = {
  error(message, ...args) {
    if (shouldLog('ERROR')) {
      const entry = formatMessage('ERROR', message, ...args);
      console.error(JSON.stringify(entry));
      if (_winstonLogger) _winstonLogger.error(message, entry);
    }
  },

  warn(message, ...args) {
    if (shouldLog('WARN')) {
      const entry = formatMessage('WARN', message, ...args);
      console.warn(JSON.stringify(entry));
      if (_winstonLogger) _winstonLogger.warn(message, entry);
    }
  },

  info(message, ...args) {
    if (shouldLog('INFO')) {
      const entry = formatMessage('INFO', message, ...args);
      console.log(JSON.stringify(entry));
      if (_winstonLogger) _winstonLogger.info(message, entry);
    }
  },

  debug(message, ...args) {
    if (shouldLog('DEBUG')) {
      const entry = formatMessage('DEBUG', message, ...args);
      console.log(JSON.stringify(entry));
      if (_winstonLogger) _winstonLogger.debug(message, entry);
    }
  },

  /**
   * Create a child logger with additional context prefix.
   */
  child(context) {
    return {
      error: (message, ...args) => logger.error(`[${context}] ${message}`, ...args),
      warn:  (message, ...args) => logger.warn(`[${context}] ${message}`, ...args),
      info:  (message, ...args) => logger.info(`[${context}] ${message}`, ...args),
      debug: (message, ...args) => logger.debug(`[${context}] ${message}`, ...args),
    };
  },

  setLevel,
  getLevel,
};

const { redactConfig } = require('./redactConfig');

module.exports = logger;
module.exports.logger = logger;
module.exports.setLevel = setLevel;
module.exports.getLevel = getLevel;
module.exports.redactConfig = redactConfig;
