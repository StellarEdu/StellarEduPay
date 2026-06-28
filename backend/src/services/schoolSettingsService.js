'use strict';

const School = require('../models/schoolModel');
const SystemConfig = require('../models/systemConfigModel');

const SETTING_KEYS = new Set([
  'maxSyncBatchSize',
  'reminderEnabled',
  'reminderIntervalMs',
  'maintenanceMode',
  'betaFeatures',
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
  betaFeatures: [],
};

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
  if (!SETTING_KEYS.has(key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  return School.findOneAndUpdate(
    { schoolId },
    { $set: { [`settings.${key}`]: value } },
    { new: true },
  ).lean();
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
    throw new Error(`Unknown setting key: ${key}`);
  }
  return School.findOneAndUpdate(
    { schoolId },
    { $unset: { [`settings.${key}`]: '' } },
    { new: true },
  ).lean();
}

module.exports = {
  getSchoolSetting,
  setSchoolSetting,
  getSchoolSettings,
  clearSchoolSetting,
  SETTING_KEYS,
};
