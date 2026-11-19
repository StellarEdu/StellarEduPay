'use strict';

const { listAuthIpBlocks, clearAuthIpBlocksForIp } = require('../services/authIpBlockService');

// hashIp() output: 16 lowercase hex characters.
const IP_HASH_PATTERN = /^[0-9a-f]{16}$/;

/**
 * GET /api/admin/ip-blocks — active authentication blocks (#1950).
 * Entries carry hashed IPs only.
 */
async function listIpBlocks(req, res) {
  const blocks = await listAuthIpBlocks();
  return res.json({ blocks });
}

/**
 * POST /api/admin/ip-blocks/:ipHash/clear — lift every active block for one hashed IP.
 * Use the ipHash values returned by GET /api/admin/ip-blocks.
 */
async function clearIpBlock(req, res) {
  const { ipHash } = req.params;
  if (!IP_HASH_PATTERN.test(ipHash)) {
    return res.status(400).json({ error: 'ipHash must be 16 hex characters.', code: 'VALIDATION_ERROR' });
  }

  const cleared = await clearAuthIpBlocksForIp(ipHash);
  if (cleared === 0) {
    return res.status(404).json({ error: 'No active block for this IP.', code: 'NOT_FOUND' });
  }

  return res.json({ ipHash, cleared });
}

module.exports = { listIpBlocks, clearIpBlock };
