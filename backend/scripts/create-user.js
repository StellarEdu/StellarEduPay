#!/usr/bin/env node
'use strict';

/**
 * CLI script to create a user with a password directly (no invitation flow).
 * 
 * Usage:
 *   node scripts/create-user.js --email user@example.com --password mypassword --schoolId school-123 --roles owner,staff
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/userModel');

/**
 * One-off recovery script: reset User.tokenVersion to 0 for accounts locked out
 * by the tokenVersion mismatch bug (tokens never carried tokenVersion, so any
 * bump made every subsequent login fail).
 *
 * Usage:
 *   node scripts/reset-token-version.js --email user@example.com
 *   node scripts/reset-token-version.js --all
 */

async function resetTokenVersion() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const email = getArg('--email');
  const all = args.includes('--all');

  if (!email && !all) {
    console.error('Usage: node scripts/reset-token-version.js --email <email>');
    console.error('       node scripts/reset-token-version.js --all');
    console.error('Example: node scripts/reset-token-version.js --email owner@school.com');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/school-payment-system';

  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const filter = all ? {} : { email: email.trim().toLowerCase() };

    if (!all) {
      const existing = await User.findOne(filter);
      if (!existing) {
        console.error(`User with email ${filter.email} not found.`);
        process.exit(1);
      }
    }

    const result = await User.updateMany(filter, { $set: { tokenVersion: 0 } });

    console.log(`Reset tokenVersion to 0 for ${result.modifiedCount} user(s).`);
    if (result.matchedCount !== result.modifiedCount) {
      console.log(`  (${result.matchedCount} matched, ${result.matchedCount - result.modifiedCount} already at 0)`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error resetting tokenVersion:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const email = getArg('--email');
  const password = getArg('--password');
  const schoolId = getArg('--schoolId') || null;
  const rolesArg = getArg('--roles');

  if (!email || !password || !rolesArg) {
    console.error('Usage: node scripts/create-user.js --email <email> --password <password> --schoolId <schoolId> --roles <comma-separated-roles>');
    console.error('Example: node scripts/create-user.js --email owner@school.com --password securepass123 --schoolId school-abc --roles owner');
    process.exit(1);
  }

  const roles = rolesArg.split(',').map(r => r.trim());
  const validRoles = ['super_admin', 'owner', 'staff', 'read_only'];
  const invalidRoles = roles.filter(r => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    console.error(`Invalid roles: ${invalidRoles.join(', ')}`);
    console.error(`Valid roles: ${validRoles.join(', ')}`);
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/school-payment-system';

  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      console.error(`User with email ${normalizedEmail} already exists.`);
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = new User({
      email: normalizedEmail,
      passwordHash,
      schoolId,
      roles,
      isActive: true,
    });

    await user.save();

    console.log('User created successfully:');
    console.log(`  Email: ${user.email}`);
    console.log(`  School ID: ${user.schoolId || '(none - super-admin)'}`);
    console.log(`  Roles: ${user.roles.join(', ')}`);
    console.log(`  Active: ${user.isActive}`);

    process.exit(0);
  } catch (err) {
    console.error('Error creating user:', err.message);
    process.exit(1);
  }
}

main();

if (require.main === module) {
  resetTokenVersion();
}

module.exports = { resetTokenVersion };
