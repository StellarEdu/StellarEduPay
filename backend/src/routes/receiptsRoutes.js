'use strict';

const express = require('express');
const router = express.Router();
const { getReceipt } = require('../controllers/receiptsController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireSchoolAuth } = require('../middleware/auth');
const { validateTxHashParam } = require('../middleware/validate');

// Payment receipts contain full financial details (amount, asset, student).
// Viewing is allowed for owner, staff and read_only; re-issue actions are
// restricted to owner.
const requireReceiptViewRole = requireSchoolAuth(['owner', 'staff', 'read_only']);

router.use(resolveSchool);
router.get('/:txHash', requireReceiptViewRole, validateTxHashParam, getReceipt);

module.exports = router;