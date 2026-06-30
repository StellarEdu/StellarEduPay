'use strict';

const Dispute = require('../models/disputeModel');
const Payment = require('../models/paymentModel');

async function flagDispute(req, res, next) {
  try {
    const { schoolId } = req;
    const { txHash, studentId, raisedBy, reason, txReference, evidence } = req.body;
    if (!txHash || !studentId || !raisedBy || !reason) {
      return res.status(400).json({ error: 'txHash, studentId, raisedBy, and reason are all required.', code: 'VALIDATION_ERROR' });
    }
    
    // Validate field lengths
    const raisedByTrimmed = raisedBy.trim();
    const reasonTrimmed = reason.trim();
    
    if (raisedByTrimmed.length > 200) {
      return res.status(400).json({ error: 'raisedBy must not exceed 200 characters.', code: 'VALIDATION_ERROR' });
    }
    if (reasonTrimmed.length > 1000) {
      return res.status(400).json({ error: 'reason must not exceed 1000 characters.', code: 'VALIDATION_ERROR' });
    }
    
    const payment = await Payment.findOne({ txHash, schoolId });
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found for this school.', code: 'NOT_FOUND' });
    }
    const existing = await Dispute.findOne({ schoolId, txHash, status: { $in: ['open', 'under_review'] } });
    if (existing) {
      return res.status(409).json({ error: 'An active dispute already exists for this payment.', code: 'DISPUTE_ALREADY_EXISTS', disputeId: existing._id });
    }

    // Validate evidence array if provided
    if (evidence && !Array.isArray(evidence)) {
      return res.status(400).json({ error: 'evidence must be an array.', code: 'VALIDATION_ERROR' });
    }

    const dispute = await Dispute.create({
      schoolId,
      txHash,
      studentId,
      raisedBy: raisedByTrimmed,
      reason: reasonTrimmed,
      txReference: txReference ? txReference.trim() : undefined,
      evidence: evidence || [],
      status: 'open',
    });
    res.status(201).json(dispute);
  } catch (err) { next(err); }
}

async function getDisputes(req, res, next) {
  try {
    const { schoolId } = req;
    const { status, studentId, escalationLevel, slaBreached, sort, page = 1, limit = 50 } = req.query;
    const filter = { schoolId };
    if (status) filter.status = status;
    if (studentId) filter.studentId = studentId;
    if (escalationLevel) filter.escalationLevel = parseInt(escalationLevel, 10);
    if (slaBreached === 'true') filter.slaBreachedAt = { $ne: null };

    const sortOption = sort === 'sla' ? { slaDeadline: 1 } : { createdAt: -1 };
    const pageNum  = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * pageSize;
    const [disputes, total] = await Promise.all([
      Dispute.find(filter).sort(sortOption).skip(skip).limit(pageSize).lean(),
      Dispute.countDocuments(filter),
    ]);
    res.json({ disputes, pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) { next(err); }
}

async function getDisputeById(req, res, next) {
  try {
    const dispute = await Dispute.findOne({ _id: req.params.id, schoolId: req.schoolId }).lean();
    if (!dispute) return res.status(404).json({ error: 'Dispute not found.', code: 'NOT_FOUND' });
    res.json(dispute);
  } catch (err) { next(err); }
}

async function resolveDispute(req, res, next) {
  try {
    const { schoolId, user } = req;
    const { resolutionNote, status, assignedTo, evidence } = req.body;
    
    // Extract admin identifier from authenticated user (JWT payload)
    const resolvedBy = user?.email || user?.id || user?.sub || 'admin';
    
    if (!resolutionNote) {
      return res.status(400).json({ error: 'resolutionNote is required.', code: 'VALIDATION_ERROR' });
    }
    
    // Validate field lengths
    const resolutionNoteTrimmed = resolutionNote.trim();
    
    if (resolutionNoteTrimmed.length > 2000) {
      return res.status(400).json({ error: 'resolutionNote must not exceed 2000 characters.', code: 'VALIDATION_ERROR' });
    }

    const ALLOWED = ['resolved', 'rejected', 'under_review'];
    const newStatus = status && ALLOWED.includes(status) ? status : 'resolved';
    
    const update = {
      $set: {
        status: newStatus,
        resolvedBy,
        resolutionNote: resolutionNoteTrimmed,
        resolvedAt: ['resolved', 'rejected'].includes(newStatus) ? new Date() : null,
        lastActivityAt: new Date(),
      },
    };

    // Update assignedTo if provided
    if (assignedTo) {
      update.$set.assignedTo = assignedTo.trim();
    }

    // Push new evidence if provided
    if (evidence && Array.isArray(evidence) && evidence.length > 0) {
      update.$push = { evidence: { $each: evidence } };
    }

    const dispute = await Dispute.findOneAndUpdate(
      { _id: req.params.id, schoolId, status: { $in: ['open', 'under_review'] } },
      update,
      { new: true }
    );
    if (!dispute) return res.status(404).json({ error: 'Dispute not found or already closed.', code: 'NOT_FOUND' });
    res.json(dispute);
  } catch (err) { next(err); }
}

/**
 * POST /api/disputes/:id/evidence
 * Add supporting evidence to an active dispute.
 */
async function addEvidence(req, res, next) {
  try {
    const { schoolId } = req;
    const { evidence } = req.body;

    if (!evidence || !Array.isArray(evidence) || evidence.length === 0) {
      return res.status(400).json({ error: 'evidence array is required.', code: 'VALIDATION_ERROR' });
    }

    // Validate each evidence item
    for (const item of evidence) {
      if (!item.type || !item.url) {
        return res.status(400).json({
          error: 'Each evidence item must have a type and url.',
          code: 'VALIDATION_ERROR',
        });
      }
      if (!['screenshot', 'tx_reference', 'document', 'other'].includes(item.type)) {
        return res.status(400).json({
          error: `Invalid evidence type: ${item.type}. Must be one of: screenshot, tx_reference, document, other`,
          code: 'VALIDATION_ERROR',
        });
      }
    }

    const dispute = await Dispute.findOneAndUpdate(
      { _id: req.params.id, schoolId, status: { $in: ['open', 'under_review'] } },
      {
        $push: { evidence: { $each: evidence } },
        $set: { lastActivityAt: new Date() },
      },
      { new: true }
    );

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found or already closed.', code: 'NOT_FOUND' });
    }

    res.json(dispute);
  } catch (err) { next(err); }
}

module.exports = { flagDispute, getDisputes, getDisputeById, resolveDispute, addEvidence };
