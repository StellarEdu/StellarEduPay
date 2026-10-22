'use strict';

const EmailDelivery = require('../models/emailDeliveryModel');
const Student = require('../models/studentModel');
const logger = require('../utils/logger').child('EmailDeliveryService');

async function createEmailDelivery(record) {
  const emailDelivery = await EmailDelivery.create(record);
  if (record.schoolId && record.studentId) {
    await updateStudentDeliveryStatus(record.schoolId, record.studentId, record.status, record.sentAt || new Date());
  }
  return emailDelivery;
}

async function updateEmailDeliveryStatus(selector, status, updateFields = {}) {
  const filter = selector.recordId
    ? { _id: selector.recordId }
    : { provider: selector.provider, providerMessageId: selector.providerMessageId };

  const query = EmailDelivery.findOneAndUpdate(
    filter,
    { $set: { status, ...updateFields } },
    { new: true }
  );

  // The recordId branch is a direct _id lookup on a known tenant document, so
  // bypassing tenant scope is safe and expected (the document's own schoolId is
  // not in the filter, but the _id uniquely identifies it).
  //
  // The non-recordId branch identifies records by (provider, providerMessageId) —
  // a provider-assigned identifier that is NOT a tenant-scoped field. These
  // identifiers arrive from external webhook callbacks where the school is unknown
  // at the time of the lookup. Bypass is intentional and correct here; the unique
  // sparse index on (provider, providerMessageId) ensures we always hit exactly
  // one document regardless of schoolId.
  const record = await query.bypassTenantScope();
  if (record && record.schoolId && record.studentId) {
    const timestamp = updateFields.deliveredAt || updateFields.openedAt || updateFields.bouncedAt || updateFields.complaintAt || record.sentAt || new Date();
    await updateStudentDeliveryStatus(record.schoolId, record.studentId, status, timestamp);
  }
  return record;
}

async function updateStudentDeliveryStatus(schoolId, studentId, status, at) {
  if (!schoolId || !studentId) return;
  await Student.findOneAndUpdate(
    { schoolId, studentId },
    {
      $set: {
        lastEmailDeliveryStatus: status,
        lastEmailDeliveryAt: at ? new Date(at) : new Date(),
      },
    }
  );
}

async function handleEmailProviderEvent(event) {
  const {
    provider = 'generic',
    providerMessageId,
    studentId,
    schoolId,
    eventType,
    timestamp,
    reason,
    payload = null,
  } = event;

  if (!providerMessageId || !eventType) {
    throw new Error('providerMessageId and eventType are required');
  }

  const statusMap = {
    delivered: 'delivered',
    opened: 'opened',
    bounced: 'bounced',
    complaint: 'complaint',
    failed: 'failed',
  };

  const status = statusMap[eventType] || eventType;
  const updateFields = { reason: reason || null, payload: payload || event };

  if (timestamp) {
    const epoch = Number(timestamp);
    updateFields.deliveredAt = status === 'delivered' ? new Date(timestamp) : undefined;
    updateFields.openedAt = status === 'opened' ? new Date(timestamp) : undefined;
    updateFields.bouncedAt = status === 'bounced' ? new Date(timestamp) : undefined;
    updateFields.complaintAt = status === 'complaint' ? new Date(timestamp) : undefined;
  }

  const record = await EmailDelivery.findOne({ provider, providerMessageId }).bypassTenantScope();
  if (record) {
    const updates = { ...updateFields, status };
    if (status === 'delivered' && !record.sentAt) updates.sentAt = record.sentAt || new Date();
    const updated = await EmailDelivery.findOneAndUpdate(
      { _id: record._id, schoolId: record.schoolId },
      { $set: updates },
      { new: true }
    ).bypassTenantScope();
    if (shouldSuppress(status) && record.schoolId && record.studentId) {
      await suppressStudentEmail(record.schoolId, record.studentId, status, reason);
    }
    return updated;
  }

  const created = await EmailDelivery.create({
    provider,
    providerMessageId,
    type: event.type || 'unknown',
    schoolId: schoolId || null,
    studentId: studentId || null,
    status,
    reason: reason || null,
    payload: payload || event,
    sentAt: status === 'sent' ? new Date(timestamp || Date.now()) : null,
    deliveredAt: status === 'delivered' ? new Date(timestamp || Date.now()) : null,
    openedAt: status === 'opened' ? new Date(timestamp || Date.now()) : null,
    bouncedAt: status === 'bounced' ? new Date(timestamp || Date.now()) : null,
    complaintAt: status === 'complaint' ? new Date(timestamp || Date.now()) : null,
  });

  if (shouldSuppress(status) && schoolId && studentId) {
    await suppressStudentEmail(schoolId, studentId, status, reason);
  }

  return created;
}

function shouldSuppress(status) {
  return status === 'bounced' || status === 'complaint';
}

async function suppressStudentEmail(schoolId, studentId, status, reason) {
  await Student.findOneAndUpdate(
    { schoolId, studentId },
    {
      $set: {
        parentEmailSuppressed: true,
        parentEmailSuppressionReason: reason || status,
        parentEmailSuppressedAt: new Date(),
        lastEmailDeliveryStatus: status,
        lastEmailDeliveryAt: new Date(),
      },
    }
  );
}

module.exports = {
  createEmailDelivery,
  updateEmailDeliveryStatus,
  handleEmailProviderEvent,
};
