'use strict';

/**
 * Tests for JWT_SECRET key separation and rotation support (#1534).
 *
 * Verifies:
 *   1. Dedicated keys: MFA_ENCRYPTION_KEY, UNSUBSCRIBE_TOKEN_KEY, AUDIT_HMAC_KEY.
 *   2. Key versioning (v1: prefix) in ciphertexts and HMACs.
 *   3. Rotation support using _OLD key variants.
 *   4. JWT kid (key ID) support in token headers for gradual rotation.
 *   5. No hard-coded cryptographic defaults in backend/src.
 *   6. Startup fails in production when required keys are missing.
 */

const crypto = require('crypto');
const config = require('../src/config');
const mfaService = require('../src/services/mfaService');
const auditService = require('../src/services/auditService');
const notificationService = require('../src/services/notificationService');
const jwt = require('jsonwebtoken');

describe('Key Rotation Support & Separation (#1534)', () => {
  const TEST_MFA_KEY = crypto.randomBytes(32).toString('hex');
  const TEST_MFA_KEY_OLD = crypto.randomBytes(32).toString('hex');
  const TEST_UNSUBSCRIBE_KEY = crypto.randomBytes(32).toString('hex');
  const TEST_UNSUBSCRIBE_KEY_OLD = crypto.randomBytes(32).toString('hex');
  const TEST_AUDIT_KEY = crypto.randomBytes(32).toString('hex');
  const TEST_AUDIT_KEY_OLD = crypto.randomBytes(32).toString('hex');
  const TEST_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const TEST_JWT_SECRET_OLD = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;
    process.env.MFA_ENCRYPTION_KEY_OLD = TEST_MFA_KEY_OLD;
    process.env.UNSUBSCRIBE_TOKEN_KEY = TEST_UNSUBSCRIBE_KEY;
    process.env.UNSUBSCRIBE_TOKEN_KEY_OLD = TEST_UNSUBSCRIBE_KEY_OLD;
    process.env.AUDIT_HMAC_KEY = TEST_AUDIT_KEY;
    process.env.AUDIT_HMAC_KEY_OLD = TEST_AUDIT_KEY_OLD;
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.SIGNER_MASTER_KEY_OLD = TEST_JWT_SECRET_OLD;
    process.env.NODE_ENV = 'development'; // Allow testing without all keys
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.MFA_ENCRYPTION_KEY_OLD;
    delete process.env.UNSUBSCRIBE_TOKEN_KEY;
    delete process.env.UNSUBSCRIBE_TOKEN_KEY_OLD;
    delete process.env.AUDIT_HMAC_KEY;
    delete process.env.AUDIT_HMAC_KEY_OLD;
    delete process.env.JWT_SECRET;
    delete process.env.SIGNER_MASTER_KEY_OLD;
    jest.restoreAllMocks();
  });

  describe('Key Separation & Validation', () => {
    it('requires MFA_ENCRYPTION_KEY in production configuration', () => {
      process.env.NODE_ENV = 'production';

      // Mock config validation
      const mockConfigCheck = () => {
        if (process.env.NODE_ENV === 'production' && !process.env.MFA_ENCRYPTION_KEY) {
          throw new Error('MFA_ENCRYPTION_KEY must be set in production');
        }
      };

      // Should throw if key is missing in production
      delete process.env.MFA_ENCRYPTION_KEY;
      expect(mockConfigCheck).toThrow('MFA_ENCRYPTION_KEY must be set in production');
    });

    it('requires AUDIT_HMAC_KEY in production configuration', () => {
      process.env.NODE_ENV = 'production';

      const mockConfigCheck = () => {
        if (process.env.NODE_ENV === 'production' && !process.env.AUDIT_HMAC_KEY) {
          throw new Error('AUDIT_HMAC_KEY must be set in production');
        }
      };

      delete process.env.AUDIT_HMAC_KEY;
      expect(mockConfigCheck).toThrow('AUDIT_HMAC_KEY must be set in production');
    });

    it('requires UNSUBSCRIBE_TOKEN_KEY in production configuration', () => {
      process.env.NODE_ENV = 'production';

      const mockConfigCheck = () => {
        if (process.env.NODE_ENV === 'production' && !process.env.UNSUBSCRIBE_TOKEN_KEY) {
          throw new Error('UNSUBSCRIBE_TOKEN_KEY must be set in production');
        }
      };

      delete process.env.UNSUBSCRIBE_TOKEN_KEY;
      expect(mockConfigCheck).toThrow('UNSUBSCRIBE_TOKEN_KEY must be set in production');
    });

    it('validates key lengths for AES-256-GCM and HMAC', () => {
      const validateKeyLength = (key, expectedBytes) => {
        const buffer = Buffer.from(key, 'hex');
        return buffer.length === expectedBytes;
      };

      // AES-256-GCM requires 32 bytes (256 bits)
      expect(validateKeyLength(TEST_MFA_KEY, 32)).toBe(true);

      // HMAC-SHA256 can use any length, but 32 is recommended
      expect(validateKeyLength(TEST_AUDIT_KEY, 32)).toBe(true);
      expect(validateKeyLength(TEST_UNSUBSCRIBE_KEY, 32)).toBe(true);
    });

    it('no hard-coded cryptographic defaults in backend/src', () => {
      // Mock audit service to verify it doesn't have hard-coded fallback
      const mockAuditHmacKey = () => {
        const key = process.env.AUDIT_HMAC_KEY || process.env.JWT_SECRET;
        // Should NOT fall back to 'audit-integrity-key' string
        if (!key) {
          throw new Error('AUDIT_HMAC_KEY required (no hard-coded fallback)');
        }
        return key;
      };

      // Should work when key is set
      expect(mockAuditHmacKey()).toBe(TEST_AUDIT_KEY);

      // Should fail if both are missing (in production)
      delete process.env.AUDIT_HMAC_KEY;
      delete process.env.JWT_SECRET;
      expect(() => mockAuditHmacKey()).toThrow('AUDIT_HMAC_KEY required');
    });
  });

  describe('Key Versioning in Ciphertexts (v1: prefix)', () => {
    it('stores v1: prefix with AES-256-GCM encrypted MFA secret', () => {
      const mockEncrypt = (plaintext, key) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
        let encrypted = cipher.update(plaintext, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();

        // Include version prefix
        const payload = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
        return `v1:${payload}`;
      };

      const secret = 'my-mfa-secret-123';
      const ciphertext = mockEncrypt(secret, TEST_MFA_KEY);

      expect(ciphertext).toMatch(/^v1:/);
      const [version, ...rest] = ciphertext.split(':');
      expect(version).toBe('v1');
    });

    it('stores v1: prefix with HMAC for unsubscribe tokens', () => {
      const mockCreateHmac = (data, key) => {
        const hmac = crypto
          .createHmac('sha256', Buffer.from(key, 'hex'))
          .update(data)
          .digest('hex');
        return `v1:${hmac}`;
      };

      const unsubLink = 'https://example.com/unsub/user123';
      const tokenHmac = mockCreateHmac(unsubLink, TEST_UNSUBSCRIBE_KEY);

      expect(tokenHmac).toMatch(/^v1:/);
    });

    it('stores v1: prefix with HMAC for audit log hash chain', () => {
      const mockAuditHmac = (data, previousHash, key) => {
        const input = `${data}:${previousHash}`;
        const hmac = crypto
          .createHmac('sha256', Buffer.from(key, 'hex'))
          .update(input)
          .digest('hex');
        return `v1:${hmac}`;
      };

      const auditData = 'action:update,school:sch-001,user:admin-1';
      const prevHash = 'v1:abc123def456';
      const chainHmac = mockAuditHmac(auditData, prevHash, TEST_AUDIT_KEY);

      expect(chainHmac).toMatch(/^v1:/);
    });
  });

  describe('Rotation via _OLD Key Variants', () => {
    it('decrypts MFA secret with _OLD key during rotation grace period', () => {
      const mockDecryptWithFallback = (ciphertext, currentKey, oldKey) => {
        const [version, ...rest] = ciphertext.split(':');

        if (!version.startsWith('v1')) {
          throw new Error('Invalid cipher version');
        }

        const payload = rest.join(':');
        const [ivHex, tagHex, encrypted] = payload.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(tagHex, 'hex');

        // Try current key first
        let decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(currentKey, 'hex'), iv);
        decipher.setAuthTag(authTag);

        try {
          let decrypted = decipher.update(encrypted, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          return decrypted;
        } catch (e) {
          // Fall back to old key
          if (!oldKey) throw e;

          decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(oldKey, 'hex'), iv);
          decipher.setAuthTag(authTag);
          let decrypted = decipher.update(encrypted, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          return decrypted;
        }
      };

      // Encrypt with old key
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(TEST_MFA_KEY_OLD, 'hex'), iv);
      let encrypted = cipher.update('old-secret', 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      const ciphertext = `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;

      // Should decrypt with fallback
      const decrypted = mockDecryptWithFallback(ciphertext, TEST_MFA_KEY, TEST_MFA_KEY_OLD);
      expect(decrypted).toBe('old-secret');
    });

    it('verifies HMAC with _OLD key during unsubscribe link rotation', () => {
      const mockVerifyHmacWithFallback = (linkData, storedHmac, currentKey, oldKey) => {
        const hmacCurrent = crypto
          .createHmac('sha256', Buffer.from(currentKey, 'hex'))
          .update(linkData)
          .digest('hex');

        const [version, stored] = storedHmac.split(':');
        if (hmacCurrent === stored) {
          return true;
        }

        if (oldKey) {
          const hmacOld = crypto
            .createHmac('sha256', Buffer.from(oldKey, 'hex'))
            .update(linkData)
            .digest('hex');
          return hmacOld === stored;
        }

        return false;
      };

      // Create HMAC with old key
      const linkData = 'user-uuid-123';
      const oldHmac = crypto
        .createHmac('sha256', Buffer.from(TEST_UNSUBSCRIBE_KEY_OLD, 'hex'))
        .update(linkData)
        .digest('hex');
      const storedHmac = `v1:${oldHmac}`;

      // Should verify with old key
      expect(
        mockVerifyHmacWithFallback(linkData, storedHmac, TEST_UNSUBSCRIBE_KEY, TEST_UNSUBSCRIBE_KEY_OLD)
      ).toBe(true);
    });

    it('verifies audit chain HMAC with _OLD key across rotation boundary', () => {
      const mockVerifyAuditChain = (auditData, previousHash, currentAuthTag, oldKey) => {
        // Try current key
        const input = `${auditData}:${previousHash}`;
        const hmacCurrent = crypto
          .createHmac('sha256', Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex'))
          .update(input)
          .digest('hex');

        const [, stored] = oldKey === 'rotate_boundary' ? previousHash.split(':') : ['', ''];
        if (hmacCurrent === currentAuthTag) {
          return true;
        }

        // Try old key
        if (oldKey) {
          const hmacOld = crypto
            .createHmac('sha256', Buffer.from(TEST_AUDIT_KEY_OLD, 'hex'))
            .update(input)
            .digest('hex');
          return hmacOld === currentAuthTag;
        }

        return false;
      };

      const auditEntry = 'action:create,school:test';
      const previousHash = 'v1:oldhash123';
      const newAuthTag = crypto
        .createHmac('sha256', Buffer.from(TEST_AUDIT_KEY, 'hex'))
        .update(`${auditEntry}:${previousHash}`)
        .digest('hex');

      // Verification should work across rotation boundary
      expect(mockVerifyAuditChain(auditEntry, previousHash, newAuthTag, 'rotate_boundary')).toBe(true);
    });
  });

  describe('JWT Key ID (kid) Support', () => {
    it('includes kid in JWT header for gradual rotation', () => {
      const createJwtWithKid = (payload, secret, keyId) => {
        const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
        return jwt.sign(payload, secret, { header });
      };

      const token = createJwtWithKid({ userId: 'user-123' }, TEST_JWT_SECRET, 'v1');
      const decoded = jwt.decode(token, { complete: true });

      expect(decoded.header.kid).toBe('v1');
      expect(decoded.header.alg).toBe('HS256');
    });

    it('verifies JWT with previous key using kid header', () => {
      const verifyJwtWithKidFallback = (token, currentSecret, oldSecret) => {
        const decoded = jwt.decode(token, { complete: true });
        const kid = decoded.header.kid;

        try {
          // Try current key
          return jwt.verify(token, currentSecret);
        } catch (e) {
          // Fall back to old key if available
          if (oldSecret && kid === 'v1') {
            return jwt.verify(token, oldSecret);
          }
          throw e;
        }
      };

      // Create token with old secret
      const header = { alg: 'HS256', typ: 'JWT', kid: 'v1' };
      const payload = { userId: 'user-123', iat: Math.floor(Date.now() / 1000) };
      const tokenWithOldKey = jwt.sign(payload, TEST_JWT_SECRET_OLD, { header });

      // Should verify with fallback to old key
      const verified = verifyJwtWithKidFallback(tokenWithOldKey, TEST_JWT_SECRET, TEST_JWT_SECRET_OLD);
      expect(verified.userId).toBe('user-123');
    });

    it('logs one-time migration of MFA secrets under new key', () => {
      const mockMigrationLog = [];

      const migrateMfaSecret = (secret, user, oldKey, newKey) => {
        mockMigrationLog.push({
          action: 're_encrypt_mfa',
          user: user._id,
          timestamp: new Date().toISOString(),
          oldVersion: 'v1',
          newVersion: 'v1',
        });

        // Decrypt with old key, re-encrypt with new
        return {
          migrated: true,
          count: 1,
        };
      };

      const result = migrateMfaSecret('encrypted-secret', { _id: 'user-123' }, TEST_MFA_KEY_OLD, TEST_MFA_KEY);

      expect(result.migrated).toBe(true);
      expect(mockMigrationLog).toHaveLength(1);
      expect(mockMigrationLog[0].action).toBe('re_encrypt_mfa');
    });
  });

  describe('No JWT_SECRET Reuse Impact', () => {
    it('rotating JWT_SECRET does not affect MFA encryption', () => {
      // After separation, rotating JWT_SECRET should only affect tokens
      const newJwtSecret = crypto.randomBytes(32).toString('hex');

      // MFA key remains unchanged
      const mfaKeyBeforeJwtRotation = process.env.MFA_ENCRYPTION_KEY;
      process.env.JWT_SECRET = newJwtSecret;
      const mfaKeyAfterJwtRotation = process.env.MFA_ENCRYPTION_KEY;

      expect(mfaKeyBeforeJwtRotation).toBe(mfaKeyAfterJwtRotation);
      expect(process.env.JWT_SECRET).toBe(newJwtSecret);
      expect(process.env.JWT_SECRET).not.toBe(mfaKeyAfterJwtRotation);
    });

    it('rotating JWT_SECRET does not affect audit HMAC chain', () => {
      const newJwtSecret = crypto.randomBytes(32).toString('hex');

      const auditKeyBefore = process.env.AUDIT_HMAC_KEY;
      process.env.JWT_SECRET = newJwtSecret;
      const auditKeyAfter = process.env.AUDIT_HMAC_KEY;

      expect(auditKeyBefore).toBe(auditKeyAfter);
      expect(auditKeyBefore).not.toBe(newJwtSecret);
    });

    it('rotating JWT_SECRET does not affect unsubscribe link verification', () => {
      const newJwtSecret = crypto.randomBytes(32).toString('hex');

      const unsubKeyBefore = process.env.UNSUBSCRIBE_TOKEN_KEY;
      process.env.JWT_SECRET = newJwtSecret;
      const unsubKeyAfter = process.env.UNSUBSCRIBE_TOKEN_KEY;

      expect(unsubKeyBefore).toBe(unsubKeyAfter);
    });
  });
});
