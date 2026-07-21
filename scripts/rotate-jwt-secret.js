#!/usr/bin/env node
'use strict';

/**
 * Automates JWT_SECRET rotation against the Kubernetes deployment described in
 * deploy/k8s/backend-deployment.yaml: generate a new secret, patch the
 * Kubernetes Secret, and roll the deployment so the new value takes effect —
 * one atomic sequence instead of a hand-run checklist.
 *
 * There is no dual-secret verification support in the app (see
 * backend/src/middleware/auth.js) — JWT_SECRET is a single value used to both
 * sign and verify. Rotating it is therefore a hard cutover:
 *   - Every live session/access token is invalidated immediately (expected —
 *     this is the point when rotating after a suspected credential leak).
 *   - Stored MFA secrets, which are AES-encrypted with a key derived from
 *     JWT_SECRET (backend/src/controllers/mfaController.js), become
 *     undecryptable. Enrolled users must re-enroll MFA after rotation.
 *   - Audit-log entry HMACs (backend/src/services/auditService.js) fall back
 *     to JWT_SECRET when AUDIT_HMAC_KEY is unset. Set AUDIT_HMAC_KEY
 *     independently *before* ever rotating JWT_SECRET if audit-trail
 *     verification across the rotation boundary matters.
 *   - Outstanding unsubscribe links (backend/src/utils/unsubscribeToken.js)
 *     stop validating; low-stakes, they're regenerated on the next email.
 *
 * Usage:
 *   node scripts/rotate-jwt-secret.js --confirm [--secret-name stellaredupay]
 *                                     [--deployment backend] [--namespace ns]
 *
 * --confirm is required and is the "review/approve" gate called for in
 * docs/operator-runbooks.md — it means the operator has read the warning
 * above and accepts the fallout.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SECRET_BYTES = 48; // 384 bits, well above config/index.js's 32-char minimum

function generateSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('base64');
}

function parseArgs(argv) {
  const args = { secretName: 'stellaredupay', deployment: 'backend', namespace: null, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--confirm':
        args.confirm = true;
        break;
      case '--secret-name':
        args.secretName = argv[++i];
        break;
      case '--deployment':
        args.deployment = argv[++i];
        break;
      case '--namespace':
        args.namespace = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/**
 * Runs the rotation. `exec` is injected so the sequencing logic can be unit
 * tested without invoking a real kubectl/cluster.
 */
function rotate({ secretName, deployment, namespace, newSecret, exec, log }) {
  const ns = namespace ? ['-n', namespace] : [];
  const steps = [];

  // 1. Provider-side secret rotation: patch the Secret with the new value.
  //    A single stringData key means there is no dual-read window — the old
  //    value is gone from the Secret object the instant this patch applies.
  steps.push({
    name: 'patch-secret',
    args: [...ns, 'patch', 'secret', secretName, '--type=merge', '-p', JSON.stringify({ stringData: { JWT_SECRET: newSecret } })],
  });

  // 2. Redeploy so running pods pick up the new value (env vars from a
  //    secretKeyRef are not live-reloaded into an already-running container).
  steps.push({ name: 'rollout-restart', args: [...ns, 'rollout', 'restart', `deployment/${deployment}`] });
  steps.push({ name: 'rollout-status', args: [...ns, 'rollout', 'status', `deployment/${deployment}`, '--timeout=300s'] });

  for (const step of steps) {
    log(`Running: kubectl ${step.args.join(' ')}`);
    exec('kubectl', step.args);
  }

  log(`Old JWT_SECRET is revoked as of the patch above (single-value Secret, no grace window).`);
  log('Verify: confirm /health is green and a fresh login issues a working token, then record the rotation time and operator per docs/operator-runbooks.md.');

  return { rotatedAt: new Date().toISOString(), secretName, deployment, namespace };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.confirm) {
    console.error(
      'Refusing to run without --confirm.\n\n' +
        'Rotating JWT_SECRET invalidates every live session immediately and permanently breaks\n' +
        'decryption of already-stored MFA secrets (users must re-enroll). Read the header comment\n' +
        'in this script, then re-run with --confirm once you accept that fallout.'
    );
    process.exit(1);
  }

  const newSecret = generateSecret();
  const result = rotate({
    secretName: args.secretName,
    deployment: args.deployment,
    namespace: args.namespace,
    newSecret,
    exec: (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit' }),
    log: (msg) => console.log(msg),
  });

  console.log(`\nRotation complete at ${result.rotatedAt}.`);
}

if (require.main === module) {
  main();
}

module.exports = { generateSecret, parseArgs, rotate };
