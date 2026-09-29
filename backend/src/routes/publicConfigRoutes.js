'use strict';

const express = require('express');
const router = express.Router();
const { getPublicConfig } = require('../controllers/publicConfigController');

// GET /api/public-config — unauthenticated; exposes only non-sensitive
// runtime values (stellarNetwork, apiVersion) so the frontend can be
// configured at runtime rather than baked in at build time (issue #1583).
router.get('/', getPublicConfig);

module.exports = router;
