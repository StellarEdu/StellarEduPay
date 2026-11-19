'use strict';

// Issue #1830 — the shared error-code catalog must cover every backend error
// code and have an English message for each. The checker is the source of truth.

const path = require('path');
const { execFileSync } = require('child_process');

describe('shared error-code catalog (issue #1830)', () => {
  it('passes scripts/check-error-catalog.js', () => {
    const script = path.resolve(__dirname, '..', 'scripts', 'check-error-catalog.js');
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(output).toMatch(/Error catalog OK/);
  });
});
