'use strict';

const School = require('../models/schoolModel');
const SystemConfig = require('../models/systemConfigModel');
const schoolCache = require('./schoolCacheInvalidator');

const SETTING_KEYS = new Set([
  'maxSyncBatchSize',
  'reminderEnabled',
  'reminderIntervalMs',
  'maintenanceMode',
  'betaFeatures',
  'acceptedAnchors',       // SEP-24 anchor list for bank/mobile-money payments (#1571)
]);

const SYSTEM_CONFIG_MAP = {
  maxSyncBatchSize: 'maxSyncBatchSize',
  reminderEnabled: 'reminderEnabled',
  reminderIntervalMs: 'reminderIntervalMs',
  maintenanceMode: 'maintenanceMode',
};

const DEFAULTS = {
  maxSyncBatchSize: 20,
  reminderEnabled: true,
  reminderIntervalMs: 86400000,
  maintenanceMode: false,
};

const VALIDATORS = {
  maxSyncBatchSize: (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
  reminderEnabled: (v) => typeof v === 'boolean',
  reminderIntervalMs: (v) => Number.isInteger(v) && v >= 60000 && v <= 604800000,
  maintenanceMode: (v) => typeof v === 'boolean',
};

function validateSetting(key, value) {
  if (!SETTING_KEYS.has(key)) {
    const err = new Error(`Unknown setting key: ${key}`);
    err.status = 400;
    throw err;
  }
  const validator = VALIDATORS[key];
  if (validator && !validator(value)) {
    const err = new Error(`Invalid value for setting: ${key}`);
    err.status = 400;
    throw err;
  }
}

async function getSchoolSetting(schoolId, key) {
  if (!SETTING_KEYS.has(key)) return undefined;

  const school = await School.findOne({ schoolId }, { settings: 1 }).lean();
  if (school && school.settings && school.settings[key] !== undefined) {
    return school.settings[key];
  }

  const systemKey = SYSTEM_CONFIG_MAP[key];
  if (systemKey) {
    const sysVal = await SystemConfig.get(systemKey);
    if (sysVal !== null && sysVal !== undefined) return sysVal;
  }

  return DEFAULTS[key];
}

async function setSchoolSetting(schoolId, key, value) {
  validateSetting(key, value);
  const updated = await School.findOneAndUpdate(
    { schoolId },
    { $set: { [`settings.${key}`]: value } },
    { new: true },
  ).lean();
  if (updated) schoolCache.invalidate(updated);
  return updated;
}

async function getSchoolSettings(schoolId) {
  const school = await School.findOne({ schoolId }, { settings: 1 }).lean();
  const schoolOverrides = school?.settings || {};
  const merged = { ...DEFAULTS };

  for (const key of Object.keys(SYSTEM_CONFIG_MAP)) {
    const sysVal = await SystemConfig.get(SYSTEM_CONFIG_MAP[key]);
    if (sysVal !== null && sysVal !== undefined) {
      merged[key] = sysVal;
    }
  }

  Object.assign(merged, schoolOverrides);
  return merged;
}

async function clearSchoolSetting(schoolId, key) {
  if (!SETTING_KEYS.has(key)) {
    const err = new Error(`Unknown setting key: ${key}`);
    err.status = 400;
    throw err;
  }
  const updated = await School.findOneAndUpdate(
    { schoolId },
    { $unset: { [`settings.${key}`]: '' } },
    { new: true },
  ).lean();
  if (updated) schoolCache.invalidate(updated);
  return updated;
}

module.exports = {
  getSchoolSetting,
  setSchoolSetting,
  getSchoolSettings,
  clearSchoolSetting,
  SETTING_KEYS,
  DEFAULTS,
  validateSetting,
};
