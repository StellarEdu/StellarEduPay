'use strict';

const { toStroops } = require('./stellarAmount');

function toStroopString(value) {
  if (value === null || value === undefined || value === '') return null;
  return toStroops(value).toString();
}

function syncStroopUpdate(update, mappings) {
  if (!update || typeof update !== 'object') return update;
  const set = update.$set || (update.$set = {});
  for (const [source, target] of mappings) {
    if (Object.prototype.hasOwnProperty.call(set, source)) {
      set[target] = toStroopString(set[source]);
    }
  }
  return update;
}

function stroopsExpression(stroopField, legacyField) {
  return {
    $toDecimal: {
      $ifNull: [`$${stroopField}`, { $toString: `$${legacyField}` }],
    },
  };
}

function amountExpression(stroopField, legacyField) {
  return { $divide: [stroopsExpression(stroopField, legacyField), 10000000] };
}

module.exports = { toStroopString, syncStroopUpdate, stroopsExpression, amountExpression };
***
