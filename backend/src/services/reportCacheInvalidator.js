'use strict';

const cache = require('../cache');
const logger = require('../utils/logger').child('ReportCacheInvalidator');
const { getRedisClient, getRedisSubscriber } = require('../config/redisClient');

const CHANNEL = 'report:invalidate';

const redisEnabled = Boolean(process.env.REDIS_HOST);

const publisher = redisEnabled ? getRedisClient() : null;
const subscriber = redisEnabled ? getRedisSubscriber() : null;

if (subscriber) {
  subscriber.on('message', onMessage);
  subscriber.subscribe(CHANNEL).catch((err) =>
    logger.error('Report invalidation subscribe failed', { error: err.message })
  );
}

function onMessage(channel, message) {
  if (channel !== CHANNEL) return;
  try {
    const { schoolId } = JSON.parse(message);
    dropSchoolReports(schoolId);
  } catch (err) {
    logger.error('Failed to handle report invalidation message', { error: err.message, message });
  }
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
  if (!subscriber) return;
  subscriber.removeListener('message', onMessage);
  try {
    await subscriber.unsubscribe(CHANNEL);
  } catch (err) {
    logger.error('Error unsubscribing report invalidation listener', { error: err.message });
  }
}

module.exports = {
  invalidate,
  close,
  CHANNEL,
  _dropSchoolReports: dropSchoolReports,
  _isRedisEnabled: () => Boolean(publisher),
};