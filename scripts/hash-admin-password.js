#!/usr/bin/env node
'use strict';

/**
 * Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 *   node scripts/hash-admin-password.js
 *
 * The script reads the password interactively (no shell history leak) and
 * prints the hash to stdout.  Copy it into your .env as ADMIN_PASSWORD_HASH
 * and remove the ADMIN_PASSWORD entry.
 */

const bcrypt = require('bcryptjs');
const { validatePasswordPolicy } = require('../backend/src/utils/passwordPolicy');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Suppress echo while typing
const hidden = process.stdin.isTTY;
if (hidden) {
  rl.stdoutMuted = true;
  rl._writeToOutput = (s) => {
    if (rl.stdoutMuted) process.stdout.write('*');
    else rl.output.write(s);
  };
}

rl.question('Enter the admin password to hash: ', async (password) => {
  if (hidden) process.stdout.write('\n');
  rl.close();

  // Same policy as every other password entrypoint (#1948). The admin account
  // has no email/username context here, so only the generic rules apply.
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    console.error(`Error: ${policy.message}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  console.log('\nAdd this to your .env:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('\nRemove the ADMIN_PASSWORD entry once you have verified login works.');
});
