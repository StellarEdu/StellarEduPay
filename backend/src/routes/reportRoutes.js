'use strict';

const express = require('express');
const router = express.Router();
const { getReport, getDashboard, getReportJob, downloadReportJob } = require('../controllers/reportController');
const { resolveSchool } = require('../middleware/schoolContext');
const { validate } = require('../middleware/validate');
const { reportQuerySchema } = require('../middleware/schemas/reportSchemas');

router.use(resolveSchool);

router.get('/dashboard', getDashboard);
router.get('/jobs/:jobId', validate(reportQuerySchema, 'query'), getReportJob);
router.get('/jobs/:jobId/download', validate(reportQuerySchema, 'query'), downloadReportJob);
router.get('/', validate(reportQuerySchema, 'query'), getReport);

module.exports = router;
