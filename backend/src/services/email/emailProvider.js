'use strict';

/**
 * Email provider factory (Issue #80).
 *
 * Selects a pluggable provider implementing the interface:
 *   { name, send(message) -> { messageId }, verify() -> { ok, error? } }
 *
 * Selection order:
 *   1. EMAIL_PROVIDER env (smtp | ses | sendgrid | console)
 *   2. fall back to 'smtp' when SMTP_HOST/USER/PASS are configured
 *   3. otherwise 'console' (logs instead of sending — safe default for dev)
 */

const config = require('../../config');
const logger = require('../../utils/logger').child('EmailProvider');

const PROVIDERS = {
  console: require('./providers/consoleProvider'),
  smtp: require('./providers/smtpProvider'),
  ses: require('./providers/sesProvider'),
  sendgrid: require('./providers/sendgridProvider'),
};

let _selected = null;

function resolveProviderName() {
  const explicit = (process.env.EMAIL_PROVIDER || config.EMAIL_PROVIDER || '').toLowerCase();
  if (explicit) {
    if (!PROVIDERS[explicit]) {
      logger.warn(`Unknown EMAIL_PROVIDER "${explicit}" — falling back to console`);
      return 'console';
    }
    return explicit;
  }
  if (config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS) return 'smtp';
  return 'console';
}

function getProvider() {
  if (_selected) return _selected;
  const name = resolveProviderName();
  _selected = PROVIDERS[name];
  logger.info(`Email provider selected: ${name}`);
  return _selected;
}

/** Reset cached selection (tests / config reloads). */
function _reset() {
  _selected = null;
  for (const p of Object.values(PROVIDERS)) {
    if (typeof p._reset === 'function') p._reset();
  }
}

module.exports = { getProvider, resolveProviderName, _reset, PROVIDERS };
