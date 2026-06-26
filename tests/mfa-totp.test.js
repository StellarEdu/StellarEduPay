'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.JWT_SECRET = 'test-jwt-secret-mfa';

const crypto = require('crypto');
const request = require('supertest');

// ── Helpers to build test fixtures ───────────────────────────────────────────

function getMfaEncryptionKey() {
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update('stellaredupay-mfa-secret-v1')
    .digest();
}

function encryptForTest(plaintext) {
  const key = getMfaEncryptionKey();
  // Use a fixed IV for deterministic test fixtures (not for production use)
  const iv = Buffer.alloc(12, 0);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

const TOTP_SECRET = 'JBSWY3DPEBLW64TMMQ======';
const ENCRYPTED_TOTP_SECRET = encryptForTest(TOTP_SECRET);
const BACKUP_CODE = 'BACKUP-CODE-001';
const BACKUP_CODE_HASH = crypto.createHash('sha256').update(BACKUP_CODE).digest('hex');

// ── Mongoose stub ─────────────────────────────────────────────────────────────

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

// ── Auth middleware bypass ────────────────────────────────────────────────────

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
  requireSchoolAuth: () => (req, res, next) => {
    req.user = { userId: 'user-001', schoolId: 'sch-001', roles: ['owner'] };
    next();
  },
}));

// ── Speakeasy mock ────────────────────────────────────────────────────────────

jest.mock('speakeasy', () => ({
  generateSecret: jest.fn().mockReturnValue({
    // Real speakeasy uses `base32`; controller accepts both for compat
    base32: 'JBSWY3DPEBLW64TMMQ======',
    otpauth_url: 'otpauth://totp/StellarEduPay%20(Test%20School)?secret=JBSWY3DPEBLW64TMMQ%3D%3D%3D%3D%3D%3D&issuer=StellarEduPay',
  }),
  totp: {
    verify: jest.fn((opts) => {
      return opts.secret === 'JBSWY3DPEBLW64TMMQ======' &&
             opts.encoding === 'base32' &&
             opts.token === '123456';
    }),
  },
}));

// ── bcryptjs mock ─────────────────────────────────────────────────────────────

jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  hash: jest.fn().mockResolvedValue('$2a$10$mockedhash'),
  genSalt: jest.fn().mockResolvedValue('$2a$10$salt'),
}));

// ── userModel mock ────────────────────────────────────────────────────────────

const mockUserBase = {
  _id: 'user-001',
  email: 'admin@test.com',
  passwordHash: '$2a$10$mockedhash',
  schoolId: 'sch-001',
  roles: ['owner'],
  isActive: true,
  mfaEnabled: false,
  mfaSecret: null,
  mfaBackupCodes: [],
  save: jest.fn().mockResolvedValue(true),
  toString: () => 'user-001',
};

jest.mock('../backend/src/models/userModel', () => ({
  findOne: jest.fn().mockResolvedValue({ ...mockUserBase }),
  findById: jest.fn().mockResolvedValue({ ...mockUserBase, save: jest.fn().mockResolvedValue(true) }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({ ...mockUserBase }),
}));

// ── School model mock ─────────────────────────────────────────────────────────

const mockSchool = {
  _id: 'sch-001',
  schoolId: 'sch-001',
  slug: 'test-school',
  name: 'Test School',
  mfaEnabled: false,
  mfaSecret: null,
  mfaBackupCodes: [],
  save: jest.fn().mockResolvedValue(true),
};

jest.mock('../backend/src/models/schoolModel', () => {
  const m = {
    findOne: jest.fn().mockResolvedValue(mockSchool),
    findOneAndUpdate: jest.fn().mockResolvedValue(mockSchool),
  };
  return m;
});

// ── Audit log mock ────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/auditLogModel', () => ({
  create: jest.fn().mockResolvedValue({ _id: 'log-001' }),
}));

const app = require('../backend/src/app');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MFA TOTP Support (#673)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset school mock to default (mfaEnabled: false)
    const School = require('../backend/src/models/schoolModel');
    School.findOne.mockResolvedValue({ ...mockSchool, save: jest.fn().mockResolvedValue(true) });
    School.findOneAndUpdate.mockResolvedValue({ ...mockSchool });
  });

  describe('POST /api/auth/mfa/setup', () => {
    it('should generate TOTP secret and QR code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/setup')
        .set('X-School-Slug', 'test-school')
        .expect(200);

      expect(res.body).toHaveProperty('secret');
      expect(res.body).toHaveProperty('qrCode');
      expect(res.body).toHaveProperty('backupCodes');
      expect(Array.isArray(res.body.backupCodes)).toBe(true);
      expect(res.body.backupCodes.length).toBeGreaterThan(0);
    });

    it('should generate unique backup codes', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/setup')
        .set('X-School-Slug', 'test-school')
        .expect(200);

      const codes = res.body.backupCodes;
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });
  });

  describe('POST /api/auth/mfa/verify', () => {
    it('should enable MFA with valid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          secret: 'JBSWY3DPEBLW64TMMQ======',
          code: '123456',
        })
        .expect(200);

      expect(res.body).toHaveProperty('message');
      expect(res.body.message).toMatch(/MFA enabled/i);
    });

    it('should reject invalid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          secret: 'JBSWY3DPEBLW64TMMQ======',
          code: '999999',
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });

    it('should reject missing code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          secret: 'JBSWY3DPEBLW64TMMQ======',
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST /api/auth/mfa/disable', () => {
    beforeEach(() => {
      const School = require('../backend/src/models/schoolModel');
      School.findOne.mockResolvedValue({
        ...mockSchool,
        mfaEnabled: true,
        mfaSecret: ENCRYPTED_TOTP_SECRET,
        save: jest.fn().mockResolvedValue(true),
      });
    });

    it('should require TOTP confirmation to disable MFA', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({ code: '123456' })
        .expect(200);

      expect(res.body).toHaveProperty('message');
      expect(res.body.message).toMatch(/MFA disabled/i);
    });

    it('should reject disable without TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({})
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });

    it('should reject disable with invalid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({ code: '999999' })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Login with MFA', () => {
    beforeEach(() => {
      const School = require('../backend/src/models/schoolModel');
      // Simulate a school that has MFA enabled
      School.findOne.mockResolvedValue({
        ...mockSchool,
        mfaEnabled: true,
        mfaSecret: ENCRYPTED_TOTP_SECRET,
        mfaBackupCodes: [{ hash: BACKUP_CODE_HASH, used: false }],
        save: jest.fn().mockResolvedValue(true),
      });
      School.findOneAndUpdate.mockResolvedValue({ ...mockSchool });
    });

    it('should require TOTP code when MFA is enabled', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
        })
        .expect(200);

      expect(res.body).toHaveProperty('requiresMfa');
      expect(res.body.requiresMfa).toBe(true);
    });

    it('should accept valid TOTP code during login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
          mfaCode: '123456',
        })
        .expect(200);

      expect(res.body).toHaveProperty('token');
    });

    it('should reject invalid TOTP code during login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
          mfaCode: '999999',
        })
        .expect(401);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('MFA audit logging', () => {
    it('should log MFA setup as high-severity audit event', async () => {
      const AuditLog = require('../backend/src/models/auditLogModel');
      const School = require('../backend/src/models/schoolModel');
      School.findOne.mockResolvedValue({
        ...mockSchool,
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: [],
        save: jest.fn().mockResolvedValue(true),
      });

      await request(app)
        .post('/api/auth/mfa/verify')
        .set('X-School-Slug', 'test-school')
        .send({
          secret: 'JBSWY3DPEBLW64TMMQ======',
          code: '123456',
        });

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MFA_ENABLED',
          severity: 'high',
        })
      );
    });

    it('should log MFA disable as high-severity audit event', async () => {
      const AuditLog = require('../backend/src/models/auditLogModel');
      const School = require('../backend/src/models/schoolModel');
      School.findOne.mockResolvedValue({
        ...mockSchool,
        mfaEnabled: true,
        mfaSecret: ENCRYPTED_TOTP_SECRET,
        save: jest.fn().mockResolvedValue(true),
      });

      await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({ code: '123456' });

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MFA_DISABLED',
          severity: 'high',
        })
      );
    });
  });

  describe('Backup codes', () => {
    beforeEach(() => {
      const School = require('../backend/src/models/schoolModel');
      School.findOne.mockResolvedValue({
        ...mockSchool,
        mfaEnabled: true,
        mfaSecret: ENCRYPTED_TOTP_SECRET,
        mfaBackupCodes: [{ hash: BACKUP_CODE_HASH, used: false }],
        save: jest.fn().mockResolvedValue(true),
      });
      School.findOneAndUpdate.mockResolvedValue({ ...mockSchool });
    });

    it('should allow login with backup code', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
          mfaCode: BACKUP_CODE,
        })
        .expect(200);

      expect(res.body).toHaveProperty('token');
    });

    it('should mark backup code as used after login', async () => {
      const School = require('../backend/src/models/schoolModel');
      await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
          mfaCode: BACKUP_CODE,
        });

      expect(School.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  // ── User-level MFA enrollment ─────────────────────────────────────────────

  describe('User-level MFA enrollment', () => {
    describe('POST /api/auth/mfa/user/setup', () => {
      it('should generate TOTP secret, QR code, and backup codes for the authenticated user', async () => {
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          save: jest.fn().mockResolvedValue(true),
        });

        const res = await request(app)
          .post('/api/auth/mfa/user/setup')
          .expect(200);

        expect(res.body).toHaveProperty('secret');
        expect(res.body).toHaveProperty('qrCode');
        expect(res.body).toHaveProperty('backupCodes');
        expect(Array.isArray(res.body.backupCodes)).toBe(true);
        expect(res.body.backupCodes.length).toBeGreaterThan(0);
      });

      it('should generate unique backup codes', async () => {
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          save: jest.fn().mockResolvedValue(true),
        });

        const res = await request(app)
          .post('/api/auth/mfa/user/setup')
          .expect(200);

        const codes = res.body.backupCodes;
        expect(new Set(codes).size).toBe(codes.length);
      });
    });

    describe('POST /api/auth/mfa/user/verify', () => {
      it('should enable user MFA with a valid TOTP code', async () => {
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          mfaSecret: null,
          save: jest.fn().mockResolvedValue(true),
        });

        const res = await request(app)
          .post('/api/auth/mfa/user/verify')
          .send({ secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' })
          .expect(200);

        expect(res.body.message).toMatch(/MFA enabled/i);
      });

      it('should reject an invalid TOTP code', async () => {
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          mfaSecret: null,
          save: jest.fn().mockResolvedValue(true),
        });

        const res = await request(app)
          .post('/api/auth/mfa/user/verify')
          .send({ secret: 'JBSWY3DPEBLW64TMMQ======', code: '999999' })
          .expect(400);

        expect(res.body).toHaveProperty('error');
      });

      it('should reject a missing TOTP code', async () => {
        const res = await request(app)
          .post('/api/auth/mfa/user/verify')
          .send({ secret: 'JBSWY3DPEBLW64TMMQ======' })
          .expect(400);

        expect(res.body.code).toBe('MISSING_MFA_CODE');
      });

      it('should emit USER_MFA_ENABLED as a high-severity audit event', async () => {
        const AuditLog = require('../backend/src/models/auditLogModel');
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          mfaSecret: null,
          save: jest.fn().mockResolvedValue(true),
        });

        await request(app)
          .post('/api/auth/mfa/user/verify')
          .send({ secret: 'JBSWY3DPEBLW64TMMQ======', code: '123456' });

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'USER_MFA_ENABLED', severity: 'high' })
        );
      });
    });

    describe('POST /api/auth/mfa/user/disable', () => {
      beforeEach(() => {
        const User = require('../backend/src/models/userModel');
        User.findById.mockResolvedValue({
          ...mockUserBase,
          mfaEnabled: true,
          mfaSecret: ENCRYPTED_TOTP_SECRET,
          save: jest.fn().mockResolvedValue(true),
        });
      });

      it('should disable user MFA with a valid TOTP code', async () => {
        const res = await request(app)
          .post('/api/auth/mfa/user/disable')
          .send({ code: '123456' })
          .expect(200);

        expect(res.body.message).toMatch(/MFA disabled/i);
      });

      it('should reject disable without a TOTP code', async () => {
        const res = await request(app)
          .post('/api/auth/mfa/user/disable')
          .send({})
          .expect(400);

        expect(res.body.code).toBe('MISSING_MFA_CODE');
      });

      it('should reject disable with an invalid TOTP code', async () => {
        const res = await request(app)
          .post('/api/auth/mfa/user/disable')
          .send({ code: '999999' })
          .expect(400);

        expect(res.body.code).toBe('INVALID_MFA_CODE');
      });

      it('should emit USER_MFA_DISABLED as a high-severity audit event', async () => {
        const AuditLog = require('../backend/src/models/auditLogModel');

        await request(app)
          .post('/api/auth/mfa/user/disable')
          .send({ code: '123456' });

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'USER_MFA_DISABLED', severity: 'high' })
        );
      });
    });
  });

  // ── Login with user-level MFA ─────────────────────────────────────────────
  // User-level MFA takes priority over school-level MFA.

  describe('Login with user-level MFA', () => {
    beforeEach(() => {
      const User = require('../backend/src/models/userModel');
      User.findOne.mockResolvedValue({
        ...mockUserBase,
        mfaEnabled: true,
        mfaSecret: ENCRYPTED_TOTP_SECRET,
        mfaBackupCodes: [{ hash: BACKUP_CODE_HASH, used: false }],
      });
      // School has MFA disabled — user-level must still be enforced
      const School = require('../backend/src/models/schoolModel');
      School.findOne.mockResolvedValue({ ...mockSchool, mfaEnabled: false });
    });

    it('should prompt for TOTP when the user has MFA enrolled', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'password123' })
        .expect(200);

      expect(res.body.requiresMfa).toBe(true);
    });

    it('should complete login with a valid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'password123', mfaCode: '123456' })
        .expect(200);

      expect(res.body).toHaveProperty('token');
    });

    it('should reject login with an invalid TOTP code', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'password123', mfaCode: '999999' })
        .expect(401);

      expect(res.body.code).toBe('INVALID_MFA_CODE');
    });

    it('should allow login with a backup code', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'password123', mfaCode: BACKUP_CODE })
        .expect(200);

      expect(res.body).toHaveProperty('token');
    });

    it('should mark the user backup code as used after login', async () => {
      const User = require('../backend/src/models/userModel');

      await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'password123', mfaCode: BACKUP_CODE });

      expect(User.findByIdAndUpdate).toHaveBeenCalled();
    });
  });
});
