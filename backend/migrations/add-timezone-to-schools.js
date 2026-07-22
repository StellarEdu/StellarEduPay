'use strict';

const mongoose = require('mongoose');
const School = require('../src/models/schoolModel');

async function up() {
  await School.updateMany(
    { timezone: { $exists: false } },
    { $set: { timezone: 'UTC' } }
  );
  console.log('Migration complete: timezone field added to all schools');
}

async function down() {
  // up() only added timezone:'UTC' where the field was missing. Scope the
  // reversal to that same value so a school whose timezone was legitimately
  // changed to something else keeps it instead of being stripped.
  await School.updateMany({ timezone: 'UTC' }, { $unset: { timezone: '' } });
}

module.exports = { up, down };
