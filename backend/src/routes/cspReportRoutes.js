'use strict';

const express = require('express');
const logger = require('../utils/logger').child('CSPReport');

const router = express.Router();

router.post('/', (req, res) => {
  const report = req.body;

  if (!report || typeof report !== 'object') {
    return res.status(400).json({ error: 'Invalid CSP report' });
  }

  const { 'csp-report': cspReport } = report;

  if (!cspReport) {
    return res.status(400).json({ error: 'Missing csp-report field' });
  }

  const {
    'document-uri': documentUri,
    'violated-directive': violatedDirective,
    'effective-directive': effectiveDirective,
    'original-policy': originalPolicy,
    'blocked-uri': blockedUri,
    'source-file': sourceFile,
    'line-number': lineNumber,
    'column-number': columnNumber,
    disposition,
  } = cspReport;

  logger.warn('CSP violation detected', {
    documentUri,
    violatedDirective,
    effectiveDirective,
    blockedUri,
    sourceFile,
    lineNumber,
    columnNumber,
    disposition,
    originalPolicy: originalPolicy?.substring(0, 100),
  });

  res.status(204).send();
});

module.exports = router;
