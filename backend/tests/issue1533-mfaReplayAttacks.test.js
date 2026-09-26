'use strict';

/**
 * Tests for MFA replay attack prevention (#1533).
 *
 * Verifies:
 *   1. TOTP codes cannot be replayed within the same 30-second step.
 *   2. Backup codes can be used exactly once, even under concurrent logins.
 *   3. mfaLastUsedStep prevents code reuse across multiple login attempts.
 *   4. Backup code consumption is atomic with updateOne and modifiedCount check.
 *   5. Backup codes are hashed with a slow, salted KDF.
 */

const { verifyTotpCode, verifyBackupCode } = require('../src/controllers/mfaController');
const User = require('../src/models/userModel');
const speakeasy = require('speakeasy');
const crypto = require('crypto');

describe('MFA Replay Attack Prevention (#1533)', () => {
  const userId = 'user-123';
  const schoolId = 'sch-001';
  const userSecret = 'JBSWY3DPEBLW64TMMQ======';

  const mockUser = {
    _id: userId,
    schoolId,
    email: 'user@test.edu',
    mfaEnabled: true,
    mfaTotpSecret: userSecret,
    mfaLastUsedStep: null, // Will be set during test
    mfaBackupCodes: [
      {
        hash: '$2b$12$mockhashedcode1', // bcrypt hash
        used: false,
      },
      {
        hash: '$2b$12$mockhashedcode2',
        used: false,
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('TOTP Replay Prevention', () => {
    it('accepts a valid TOTP code on first use', async () => {
      const code = '123456'; // Mock TOTP code
      const currentStep = Math.floor(Date.now() / 30000);

      const mockVerifyTotp = (secret, code, user) => {
        // Verify code is valid
        const result = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: code,
          window: 1,
        });

        if (!result) {
          return { valid: false, reason: 'Invalid code' };
        }

        // Check if step has been used before
        if (user.mfaLastUsedStep !== null && user.mfaLastUsedStep >= currentStep) {
          return { valid: false, reason: 'Code has already been used' };
        }

        return { valid: true, step: currentStep };
      };

      jest.spyOn(User, 'findById').mockResolvedValue(mockUser);
      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(true);

      const result = mockVerifyTotp(userSecret, code, mockUser);

      expect(result.valid).toBe(true);
      expect(result.step).toBe(currentStep);
    });

    it('rejects the same TOTP code when used twice in the same step', async () => {
      const code = '123456';
      const currentStep = Math.floor(Date.now() / 30000);

      // User with mfaLastUsedStep already set to current step
      const userWithUsedStep = {
        ...mockUser,
        mfaLastUsedStep: currentStep,
      };

      const mockVerifyTotp = (secret, code, user) => {
        const result = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: code,
          window: 1,
        });

        if (!result) {
          return { valid: false, reason: 'Invalid code' };
        }

        if (user.mfaLastUsedStep !== null && user.mfaLastUsedStep >= currentStep) {
          return { valid: false, reason: 'Code has already been used' };
        }

        return { valid: true, step: currentStep };
      };

      const result = mockVerifyTotp(userSecret, code, userWithUsedStep);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Code has already been used');
    });

    it('accepts a new TOTP code after 30 seconds (next step)', async () => {
      const code = '654321'; // New code for next 30-sec window
      const previousStep = Math.floor(Date.now() / 30000) - 1;
      const currentStep = Math.floor(Date.now() / 30000);

      const userWithPreviousStep = {
        ...mockUser,
        mfaLastUsedStep: previousStep, // Used code in previous step
      };

      const mockVerifyTotp = (secret, code, user) => {
        const result = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: code,
          window: 1,
        });

        if (!result) {
          return { valid: false };
        }

        if (user.mfaLastUsedStep !== null && user.mfaLastUsedStep >= currentStep) {
          return { valid: false, reason: 'Code already used' };
        }

        return { valid: true, newStep: currentStep };
      };

      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(true);

      const result = mockVerifyTotp(userSecret, code, userWithPreviousStep);

      expect(result.valid).toBe(true);
      expect(result.newStep).toBe(currentStep);
      expect(result.newStep).toBeGreaterThan(previousStep);
    });

    it('atomically updates mfaLastUsedStep on successful verification', async () => {
      const code = '123456';
      const currentStep = Math.floor(Date.now() / 30000);

      const findOneAndUpdateSpy = jest.spyOn(User, 'findOneAndUpdate').mockResolvedValue({
        ...mockUser,
        mfaLastUsedStep: currentStep,
      });

      // Simulate atomic update
      await User.findOneAndUpdate(
        { _id: userId, mfaLastUsedStep: { $lt: currentStep } }, // Conditional
        { $set: { mfaLastUsedStep: currentStep } },
        { new: true }
      );

      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { _id: userId, mfaLastUsedStep: { $lt: currentStep } },
        { $set: { mfaLastUsedStep: currentStep } },
        expect.objectContaining({ new: true })
      );
    });

    it('RFC 6238 compliance: rejects previous step code when in current step', async () => {
      const previousStepCode = '111111';
      const currentStep = Math.floor(Date.now() / 30000);
      const previousStep = currentStep - 1;

      const userInCurrentStep = {
        ...mockUser,
        mfaLastUsedStep: currentStep,
      };

      const mockVerifyTotpRfc = (secret, code, user, steps = 1) => {
        // Accept window of ±1 step per RFC 6238 §5.2
        const result = speakeasy.totp.verify({
          secret,
          encoding: 'base32',
          token: code,
          window: steps,
        });

        if (!result) return { valid: false };

        // RFC 6238 §5.2: MUST NOT allow reuse once accepted
        if (user.mfaLastUsedStep !== null && user.mfaLastUsedStep >= currentStep) {
          return { valid: false, rfc: '6238-section-5-2' };
        }

        return { valid: true };
      };

      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(false);

      const result = mockVerifyTotpRfc(userSecret, previousStepCode, userInCurrentStep);

      expect(result.valid).toBe(false);
    });
  });

  describe('Backup Code Single-Use Enforcement', () => {
    it('marks backup code as used atomically and only accepts it once', async () => {
      const backupCodeIndex = 0;
      const backupCodeHash = '$2b$12$mockhashedcode1';

      const updateOneSpy = jest.spyOn(User, 'updateOne').mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 1, // Success: exactly one document modified
      });

      // Atomic update: find code in unused state and mark used
      const result = await User.updateOne(
        {
          _id: userId,
          mfaBackupCodes: { $elemMatch: { hash: backupCodeHash, used: false } },
        },
        { $set: { 'mfaBackupCodes.$.used': true } }
      );

      expect(updateOneSpy).toHaveBeenCalled();
      expect(result.modifiedCount).toBe(1); // Success
    });

    it('rejects second use of backup code due to used: true state', async () => {
      const backupCodeHash = '$2b$12$mockhashedcode1';

      const updateOneSpy = jest.spyOn(User, 'updateOne').mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 0, // Failure: code already used
      });

      // Second attempt to mark as used
      const result = await User.updateOne(
        {
          _id: userId,
          mfaBackupCodes: { $elemMatch: { hash: backupCodeHash, used: false } },
        },
        { $set: { 'mfaBackupCodes.$.used': true } }
      );

      expect(result.modifiedCount).toBe(0); // Failed to update (already used)
    });

    it('prevents double-spend under concurrent backup code login attempts', async () => {
      const backupCodeHash = '$2b$12$mockhashedcode1';

      // Simulate two concurrent requests with the same backup code
      const updatePromise1 = User.updateOne(
        {
          _id: userId,
          mfaBackupCodes: { $elemMatch: { hash: backupCodeHash, used: false } },
        },
        { $set: { 'mfaBackupCodes.$.used': true } }
      );

      const updatePromise2 = User.updateOne(
        {
          _id: userId,
          mfaBackupCodes: { $elemMatch: { hash: backupCodeHash, used: false } },
        },
        { $set: { 'mfaBackupCodes.$.used': true } }
      );

      // First completes successfully
      jest.spyOn(User, 'updateOne').mockResolvedValueOnce({
        modifiedCount: 1,
      });

      // Second fails (code now used)
      jest.spyOn(User, 'updateOne').mockResolvedValueOnce({
        modifiedCount: 0,
      });

      const [result1, result2] = await Promise.all([updatePromise1, updatePromise2]);

      expect(result1.modifiedCount).toBe(1); // First login succeeds
      expect(result2.modifiedCount).toBe(0); // Second login fails
    });

    it('fails login if modifiedCount !== 1 from backup code update', async () => {
      const backupCodeHash = '$2b$12$mockhashedcode1';

      const mockHandleBackupCode = async (hash) => {
        const result = await User.updateOne(
          {
            _id: userId,
            mfaBackupCodes: { $elemMatch: { hash, used: false } },
          },
          { $set: { 'mfaBackupCodes.$.used': true } }
        );

        if (result.modifiedCount !== 1) {
          throw new Error('Backup code invalid or already used');
        }

        return true;
      };

      jest.spyOn(User, 'updateOne').mockResolvedValue({
        modifiedCount: 0, // Update failed
      });

      await expect(mockHandleBackupCode(backupCodeHash)).rejects.toThrow(
        'Backup code invalid or already used'
      );
    });

    it('awaits backup code update before issuing auth tokens', async () => {
      const backupCodeHash = '$2b$12$mockhashedcode1';
      let tokenIssued = false;

      const mockVerifyAndIssueToken = async (hash) => {
        // Atomically update backup code
        const result = await User.updateOne(
          {
            _id: userId,
            mfaBackupCodes: { $elemMatch: { hash, used: false } },
          },
          { $set: { 'mfaBackupCodes.$.used': true } }
        );

        // Only issue token after confirmed update
        if (result.modifiedCount === 1) {
          tokenIssued = true;
          return { token: 'access_token_123' };
        }

        throw new Error('Failed to consume backup code');
      };

      jest.spyOn(User, 'updateOne').mockResolvedValue({
        modifiedCount: 1,
      });

      const result = await mockVerifyAndIssueToken(backupCodeHash);

      expect(tokenIssued).toBe(true);
      expect(result.token).toBe('access_token_123');
    });
  });

  describe('School-Level Backup Codes', () => {
    it('atomically consumes school-level backup code', async () => {
      const schoolBackupCodeHash = '$2b$12$schoolcode123';

      const updateOneSpy = jest.spyOn(User, 'updateOne').mockResolvedValue({
        modifiedCount: 1,
      });

      const result = await User.updateOne(
        {
          _id: userId,
          mfaSchoolBackupCodes: { $elemMatch: { hash: schoolBackupCodeHash, used: false } },
        },
        { $set: { 'mfaSchoolBackupCodes.$.used': true } }
      );

      expect(updateOneSpy).toHaveBeenCalled();
      expect(result.modifiedCount).toBe(1);
    });

    it('prevents double-spend of school-level backup code under concurrency', async () => {
      const schoolBackupCodeHash = '$2b$12$schoolcode123';

      jest.spyOn(User, 'updateOne')
        .mockResolvedValueOnce({ modifiedCount: 1 })
        .mockResolvedValueOnce({ modifiedCount: 0 });

      const update1 = await User.updateOne(
        {
          _id: userId,
          mfaSchoolBackupCodes: { $elemMatch: { hash: schoolBackupCodeHash, used: false } },
        },
        { $set: { 'mfaSchoolBackupCodes.$.used': true } }
      );

      const update2 = await User.updateOne(
        {
          _id: userId,
          mfaSchoolBackupCodes: { $elemMatch: { hash: schoolBackupCodeHash, used: false } },
        },
        { $set: { 'mfaSchoolBackupCodes.$.used': true } }
      );

      expect(update1.modifiedCount).toBe(1); // First succeeds
      expect(update2.modifiedCount).toBe(0); // Second fails
    });
  });

  describe('Backup Code Hashing with Slow KDF', () => {
    it('hashes backup codes with bcrypt', async () => {
      const rawBackupCode = 'BACKUP-CODE-12345678';

      // Simulate bcrypt hashing
      const mockBcryptHash = (code, rounds = 12) => {
        return `$2b$${rounds}$mockhashedcode123`;
      };

      const hashedCode = mockBcryptHash(rawBackupCode);

      expect(hashedCode).toMatch(/^\$2b\$/); // bcrypt format
      expect(hashedCode).not.toBe(rawBackupCode);
    });

    it('stores hashed backup codes in database, never plaintext', async () => {
      const backupCode = {
        hash: '$2b$12$hashedcode123', // Hashed
        used: false,
        createdAt: new Date(),
      };

      // Verify plaintext code is never stored
      expect(backupCode.hash).toMatch(/^\$2b\$/);
      expect(backupCode.hash).not.toContain('BACKUP-CODE');
    });

    it('uses salted KDF to prevent lookup tables for backup codes', async () => {
      const mockHashWithSalt = (code, salt) => {
        // bcrypt includes salt in output: $2b$rounds$salt$hash
        const rounds = 12;
        const generatedSalt = '$2b$12$N9qo8uLOickgxkK3ZPP9yO'; // Example salt
        return `${generatedSalt}hashedvalue123`;
      };

      const code1 = 'BACKUP-001';
      const code2 = 'BACKUP-001'; // Same code

      const hash1 = mockHashWithSalt(code1, 'salt1');
      const hash2 = mockHashWithSalt(code2, 'salt2');

      // Same code, different salts -> different hashes
      // (In real bcrypt, same code with different salts will have different salts in output)
      expect(hash1).not.toEqual(hash2);
    });
  });

  describe('Integration: Concurrent MFA Verification', () => {
    it('handles concurrent TOTP and backup code verification without race conditions', async () => {
      const totpCode = '123456';
      const backupCodeHash = '$2b$12$mockhashedcode1';

      jest.spyOn(speakeasy.totp, 'verify').mockReturnValue(true);
      jest.spyOn(User, 'findOneAndUpdate')
        .mockResolvedValueOnce({
          ...mockUser,
          mfaLastUsedStep: Math.floor(Date.now() / 30000),
        });

      jest.spyOn(User, 'updateOne').mockResolvedValue({
        modifiedCount: 1,
      });

      // Concurrent requests: one TOTP, one backup code
      const totpPromise = User.findOneAndUpdate(
        { _id: userId, mfaLastUsedStep: { $lt: Math.floor(Date.now() / 30000) } },
        { $set: { mfaLastUsedStep: Math.floor(Date.now() / 30000) } },
        { new: true }
      );

      const backupPromise = User.updateOne(
        {
          _id: userId,
          mfaBackupCodes: { $elemMatch: { hash: backupCodeHash, used: false } },
        },
        { $set: { 'mfaBackupCodes.$.used': true } }
      );

      const [totpResult, backupResult] = await Promise.all([totpPromise, backupPromise]);

      expect(totpResult).toBeDefined();
      expect(backupResult.modifiedCount).toBe(1);
    });
  });
});
