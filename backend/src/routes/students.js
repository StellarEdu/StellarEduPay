const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { requireAdminAuth } = require('../middleware/auth');
const { streamingCsvUpload } = require('../middleware/streamingCsvUpload');
const {
  bulkImportStudents,
  listStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
} = require('../controllers/studentController');
const config = require('../config');

// Rate limiter for bulk import operations
const bulkImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 bulk import requests per windowMs
  message: {
    error: 'Too many bulk import requests, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// JSON bulk import limit aligned with CSV_MAX_ROWS (10,000 rows).
// The global express.json parser is skipped for this path (see app.js) so this
// route-level parser is the one that actually applies.
const BULK_JSON_LIMIT = config.BULK_JSON_BODY_SIZE || '5mb';

// Bulk import: accepts CSV upload or JSON body { students: [...] }
router.post(
  '/bulk',
  requireAdminAuth,
  bulkImportLimiter,
  express.json({ limit: BULK_JSON_LIMIT }),
  streamingCsvUpload(),
  bulkImportStudents
);

router.get('/', requireAdminAuth, listStudents);
router.get('/:id', requireAdminAuth, getStudent);
router.post('/', requireAdminAuth, createStudent);
router.put('/:id', requireAdminAuth, updateStudent);
router.delete('/:id', requireAdminAuth, deleteStudent);

module.exports = router;
