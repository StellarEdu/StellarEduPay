'use strict';
const logger = require('../utils/logger').child('AlertService');
const client = require('prom-client');
const adminAlertCounter = new client.Counter({name:'admin_alerts_total', help:'Total number of admin alerts triggered'});
async function sendAdminAlert(message, details = {}) {
  adminAlertCounter.inc();
  logger.error(`[ALERT] ${message}`, details);
}
module.exports = { sendAdminAlert };
