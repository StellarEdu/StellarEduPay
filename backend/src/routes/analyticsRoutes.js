'use strict';

const express = require('express');
const router = express.Router();
const {
  getPaymentVolumeTrend,
  getClassPaymentCompletion,
  getTopUnpaidCohorts,
  getPaymentAnalyticsSummary,
} = require('../controllers/analyticsController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireSchoolAuth } = require('../middleware/auth');

// Authenticate and bind the token to the requested tenant before resolving
// school state, so anonymous callers cannot probe school existence or status.
router.use(requireSchoolAuth(['owner', 'staff', 'read_only']));
router.use(resolveSchool);

router.get('/summary', getPaymentAnalyticsSummary);
router.get('/volume-trend', getPaymentVolumeTrend);
router.get('/class-completion', getClassPaymentCompletion);
router.get('/unpaid-cohorts', getTopUnpaidCohorts);

module.exports = router;
