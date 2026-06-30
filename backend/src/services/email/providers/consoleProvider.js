'use strict';

/**
 * Console/no-op email provider.
 *
 * Default provider for development and any environment without email
 * infrastructure: it logs the message that *would* be sent instead of dropping
 * it silently, so reminder/receipt emails remain visible in logs.
 */

const logger = require('../../../utils/logger').child('EmailProvider:console');

module.exports = {
  name: 'console',

  async send(message) {
    logger.info('Email (console provider — not actually sent)', {
      to: message.to,
      subject: message.subject,
      category: message.category,
    });
    return { messageId: `console-${process.pid}-${message.to}-${message.subject}` };
  },

  async verify() {
    return { ok: true };
  },
};
