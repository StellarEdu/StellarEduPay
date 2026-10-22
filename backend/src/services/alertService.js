'use strict';
const logger = require('../utils/logger').child('AlertService');
const { sendAdminAlertTotal } = require('../metrics');
async function sendAdminAlert(message, details = {}) {
  sendAdminAlertTotal.inc();
  logger.error(`[ALERT] ${message}`, details);
}
module.exports = { sendAdminAlert };
