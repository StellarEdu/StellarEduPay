'use strict';

const express = require('express');
const router = express.Router();
const {
  createEndpoint,
  listEndpoints,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
  sendTestEvent,
} = require('../controllers/webhookEndpointsController');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All routes require a valid school-scoped JWT
router.use(requireSchoolAuth());

router.post('/',     auditContext, createEndpoint);
router.get('/',      listEndpoints);
router.get('/:id',   getEndpoint);
router.put('/:id',   auditContext, updateEndpoint);
router.delete('/:id', auditContext, deleteEndpoint);
router.post('/:id/test', auditContext, sendTestEvent);

module.exports = router;
