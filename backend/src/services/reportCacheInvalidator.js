'use strict';

const cache = require('../cache');
const logger = require('../utils/logger').child('ReportCacheInvalidator');

const CHANNEL = 'report:invalidate';

const redisEnabled = Boolean(process.env.REDIS_HOST);

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
};

let publisher = null;
let subscriber = null;

if (redisEnabled) {
  const Redis = require('ioredis');
  publisher = new Redis(redisConfig);
  subscriber = new Redis(redisConfig);

  for (const [name, conn] of [['publisher', publisher], ['subscriber', subscriber]]) {
    conn.on('error', (err) => logger.error(`Redis ${name} error`, { error: err.message }));
    conn.connect().catch((err) =>
      logger.error(`Redis ${name} connect failed`, { error: err.message })
    );
  }

  subscriber.subscribe(CHANNEL).catch((err) =>
    logger.error('Report invalidation subscribe failed', { error: err.message })
  );

  subscriber.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const { schoolId } = JSON.parse(message);
      dropSchoolReports(schoolId);
    } catch (err) {
      logger.error('Failed to handle report invalidation message', { error: err.message, message });
    }
  });
}

function dropSchoolReports(schoolId) {
  const allKeys = cache.keys();
  const reportKeys = allKeys.filter(
    (k) => k.startsWith(`report:${schoolId}:`) || k.startsWith(`dashboard:${schoolId}`)
  );
  if (reportKeys.length) {
    cache.del(reportKeys);
    logger.debug('Dropped report cache entries', { schoolId, count: reportKeys.length });
  }
}

function invalidate(schoolId) {
  if (!schoolId) return;

  dropSchoolReports(schoolId);

  if (publisher) {
    publisher
      .publish(CHANNEL, JSON.stringify({ schoolId }))
      .catch((err) =>
        logger.error('Report invalidation publish failed', { error: err.message, schoolId })
      );
  }
}

async function close() {
  try {
    if (subscriber) await subscriber.quit();
    if (publisher) await publisher.quit();
  } catch (err) {
    logger.error('Error closing report invalidation Redis connections', { error: err.message });
  }
}

module.exports = {
  invalidate,
  close,
  CHANNEL,
  _dropSchoolReports: dropSchoolReports,
  _isRedisEnabled: () => Boolean(publisher),
};