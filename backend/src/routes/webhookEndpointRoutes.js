'use strict';

const express = require('express');
const router = express.Router();
const {
  createEndpoint,
  listEndpoints,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
  rotateSecret,
  sendTestEvent,
} = require('../controllers/webhookEndpointsController');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');
const { resolveSchool } = require('../middleware/resolveSchool');

// All routes require a valid school-scoped JWT and a validated school context.
// The tenant is derived only from resolveSchool, never from a client-supplied header.
router.use(requireSchoolAuth());
router.use(resolveSchool);

// Read access: owners and staff may list/get endpoints and send test events.
router.get('/',      requireSchoolAuth(['owner', 'staff']), listEndpoints);
router.get('/:id',   requireSchoolAuth(['owner', 'staff']), getEndpoint);
router.post('/:id/test', requireSchoolAuth(['owner', 'staff']), auditContext, sendTestEvent);

// Write access: only owners may change outbound webhook configuration.
router.post('/',     requireSchoolAuth(['owner']), auditContext, createEndpoint);
router.put('/:id',   requireSchoolAuth(['owner']), auditContext, updateEndpoint);
router.delete('/:id', requireSchoolAuth(['owner']), auditContext, deleteEndpoint);
router.post('/:id/rotate-secret', requireSchoolAuth(['owner']), auditContext, rotateSecret);

module.exports = router;