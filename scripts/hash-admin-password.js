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

  if (!password || password.length < 12) {
    console.error('Error: password must be at least 12 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  console.log('\nAdd this to your .env:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('\nRemove the ADMIN_PASSWORD entry once you have verified login works.');
});
