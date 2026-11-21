'use strict';

const VERSION = '038_optimize_student_tenant_indexes';

const LEGACY_INDEX_KEYS = [
  { studentId: 1 },
  { feePaid: 1 },
  { studentId: 1, schoolId: 1 },
  { studentId: 1, version: 1 },
  { feePaid: 1, class: 1 },
  { totalPaid: 1 },
  { name: 'text', studentId: 'text' },
];

const LEGACY_INDEX_NAMES = new Set([
  'studentId_1',
  'feePaid_1',
  'studentId_1_schoolId_1',
  'studentId_1_version_1',
  'feePaid_1_class_1',
  'totalPaid_1',
  'name_text_studentId_text',
]);

const INDEXES = [
  [{ schoolId: 1, studentId: 1 }, { unique: true, name: 'schoolId_1_studentId_1' }],
  [{ schoolId: 1, deletedAt: 1, createdAt: -1 }, { name: 'student_list_by_school' }],
  [{ schoolId: 1, deletedAt: 1, feePaid: 1, totalPaid: 1 }, { name: 'student_payment_status_by_school' }],
  [{ schoolId: 1, deletedAt: 1, nameLower: 1 }, { name: 'student_name_prefix_by_school' }],
  [{ schoolId: 1, deletedAt: 1, studentIdLower: 1 }, { name: 'student_id_prefix_by_school' }],
  [{ schoolId: 1, deletedAt: 1, feePaid: 1, paymentDeadline: 1 }, { name: 'student_overdue_by_school' }],
  [{ schoolId: 1, deletedAt: 1, feePaid: 1, reminderOptOut: 1, parentEmail: 1 }, { name: 'student_email_reminders_by_school' }],
  [{ schoolId: 1, deletedAt: 1, feePaid: 1, reminderOptOut: 1, parentPhone: 1 }, { name: 'student_phone_reminders_by_school' }],
];

function sameKey(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function up(db) {
  const students = db.collection('students');
  const existing = await students.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });

  for (const index of existing) {
    if (
      index.name !== '_id_' &&
      (LEGACY_INDEX_NAMES.has(index.name) || LEGACY_INDEX_KEYS.some((key) => sameKey(index.key, key)))
    ) {
      await students.dropIndex(index.name);
    }
  }

  await students.updateMany(
    {},
    [{
      $set: {
        nameLower: { $toLower: { $trim: { input: { $ifNull: ['$name', ''] } } } },
        studentIdLower: { $toLower: { $trim: { input: { $ifNull: ['$studentId', ''] } } } },
      },
    }]
  );

  for (const [key, options] of INDEXES) {
    const equivalent = (await students.indexes()).find(
      (index) => index.name !== options.name && sameKey(index.key, key)
    );
    if (equivalent) await students.dropIndex(equivalent.name);
    await students.createIndex(key, options);
  }
}

async function down(db) {
  const students = db.collection('students');
  for (const [, options] of INDEXES) {
    await students.dropIndex(options.name).catch((err) => {
      if (err.code !== 26 && err.code !== 27) throw err;
    });
  }
  await students.updateMany({}, { $unset: { nameLower: '', studentIdLower: '' } });
}

module.exports = { version: VERSION, up, down };
