'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GCICZOP346CKADPWOZ6JAQ7OCGH44UELNS3GSDXFOTSZRW6OYZZ6KSY7B';
process.env.JWT_SECRET = 'test-jwt-secret-mfa';

const request = require('supertest');

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(true),
  Schema: class {
    constructor() { this.index = jest.fn(); }
  },
  model: jest.fn().mockReturnValue({}),
}));

jest.mock('../backend/src/middleware/auth', () => ({
  requireAdminAuth: (req, res, next) => next(),
}));

jest.mock('speakeasy', () => ({
  generateSecret: jest.fn().mockReturnValue({
    secret: 'JBSWY3DPEBLW64TMMQ======',
    qr_code_ascii: 'QR_CODE_ASCII',
  }),
  totp: {
    verify: jest.fn((opts) => {
      if (opts.secret === 'JBSWY3DPEBLW64TMMQ======' && opts.encoding === 'base32' && opts.token === '123456') {
        return true;
      }
      return false;
    }),
  },
}));

jest.mock('../backend/src/models/schoolModel', () => {
  const mockSchool = {
    _id: 'sch-001',
    slug: 'test-school',
    name: 'Test School',
    mfaEnabled: false,
    mfaSecret: null,
    mfaBackupCodes: [],
    save: jest.fn().mockResolvedValue(true),
  };
  return {
    findOne: jest.fn().mockResolvedValue(mockSchool),
    findOneAndUpdate: jest.fn().mockResolvedValue(mockSchool),
  };
});

jest.mock('../backend/src/models/auditLogModel', () => ({
  create: jest.fn().mockResolvedValue({ _id: 'log-001' }),
}));

const app = require('../backend/src/app');

describe('MFA TOTP Support (#673)', () => {
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
    it('should require TOTP confirmation to disable MFA', async () => {
      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({
          code: '123456',
        })
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
        .send({
          code: '999999',
        })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Login with MFA', () => {
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
      await request(app)
        .post('/api/auth/mfa/disable')
        .set('X-School-Slug', 'test-school')
        .send({
          code: '123456',
        });

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MFA_DISABLED',
          severity: 'high',
        })
      );
    });
  });

  describe('Backup codes', () => {
    it('should allow login with backup code', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123',
          mfaCode: 'BACKUP-CODE-001',
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
          mfaCode: 'BACKUP-CODE-001',
        });

      expect(School.findOneAndUpdate).toHaveBeenCalled();
    });
  });
});
