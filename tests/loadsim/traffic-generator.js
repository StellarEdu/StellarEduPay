#!/usr/bin/env node
'use strict';
/**
 * Testnet payment traffic generator for issue #1825.
 *
 * Required: LOAD_TEST_SOURCE_SECRET_KEYS and LOAD_TEST_DESTINATION_ADDRESSES.
 * Optional: LOAD_TEST_SCHOOL_IDS, LOAD_TEST_HORIZON_URL,
 * LOAD_TEST_PAYMENTS_PER_MINUTE, LOAD_TEST_DURATION_SECONDS,
 * LOAD_TEST_MANIFEST, LOAD_TEST_NETWORK.
 *
 * The generator never runs against mainnet by default. Set
 * LOAD_TEST_ALLOW_MAINNET=true only for an explicitly approved environment.
 */
const fs = require('fs');
const path = require('path');
const StellarSdk = require('../backend/node_modules/@stellar/stellar-sdk');
const { Horizon, Networks, Asset, Keypair, Operation, TransactionBuilder } = StellarSdk;

const network = process.env.LOAD_TEST_NETWORK || 'testnet';
if (network === 'mainnet' && process.env.LOAD_TEST_ALLOW_MAINNET !== 'true') {
  throw new Error('Refusing mainnet traffic. Set LOAD_TEST_ALLOW_MAINNET=true explicitly.');
}
const horizonUrl = process.env.LOAD_TEST_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const sourceKeys = (process.env.LOAD_TEST_SOURCE_SECRET_KEYS || '').split(',').map(value => value.trim()).filter(Boolean);
const destinations = (process.env.LOAD_TEST_DESTINATION_ADDRESSES || '').split(',').map(value => value.trim()).filter(Boolean);
const schoolIds = (process.env.LOAD_TEST_SCHOOL_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
const paymentsPerMinute = Math.max(1, parseInt(process.env.LOAD_TEST_PAYMENTS_PER_MINUTE || '60', 10));
const durationSeconds = Math.max(1, parseInt(process.env.LOAD_TEST_DURATION_SECONDS || '60', 10));
const amount = process.env.LOAD_TEST_AMOUNT || '1';
const manifestPath = path.resolve(process.env.LOAD_TEST_MANIFEST || 'load-test-payment-manifest.json');
const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
if (!sourceKeys.length || !destinations.length) {
  throw new Error('LOAD_TEST_SOURCE_SECRET_KEYS and LOAD_TEST_DESTINATION_ADDRESSES are required');
}
const server = new Horizon.Server(horizonUrl);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function categoryFor(sequence) {
  const bucket = sequence % 100;
  if (bucket < 90) return 'valid';
  if (bucket < 95) return 'typo';
  if (bucket < 98) return 'no-memo';
  return 'path-payment';
}
function memoFor(category, studentNumber) {
  if (category === 'no-memo') return null;
  if (category === 'typo') return `STU${String(studentNumber).padStart(6, '0')}-TYPO`;
  return `STU${String(studentNumber).padStart(6, '0')}`;
}
function pathAsset() {
  const code = process.env.LOAD_TEST_PATH_ASSET_CODE;
  const issuer = process.env.LOAD_TEST_PATH_ASSET_ISSUER;
  return code && issuer ? new Asset(code, issuer) : null;
}
async function submitPayment({ source, destination, category, studentNumber }) {
  const account = await server.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: process.env.LOAD_TEST_FEE_STROOPS || '100',
    networkPassphrase,
  });
  const asset = pathAsset();
  if (category === 'path-payment' && asset) {
    builder.addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: amount,
      destination,
      destAsset: asset,
      destMin: '0.000001',
      path: [],
    }));
  } else {
    builder.addOperation(Operation.payment({ destination, asset: Asset.native(), amount }));
  }
  const memo = memoFor(category, studentNumber);
  if (memo) builder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
  const response = await server.submitTransaction(builder.setTimeout(120).build().sign(source));
  let ledgerClosedAt = new Date().toISOString();
  try {
    const transaction = await server.transactions().transaction(response.hash).call();
    ledgerClosedAt = transaction.created_at || ledgerClosedAt;
  } catch (_) {
    // Horizon may not expose the transaction immediately; the submitted time is
    // retained so the k6 report still records this sample.
  }
  return {
    txHash: response.hash,
    category,
    schoolId: schoolIds[studentNumber % Math.max(1, schoolIds.length)] || '',
    studentId: memoFor(category, studentNumber),
    submittedAt: new Date().toISOString(),
    ledgerClosedAt,
  };
}
async function main() {
  const manifest = [];
  fs.writeFileSync(manifestPath, '[]\n');
  const intervalMs = 60000 / paymentsPerMinute;
  const endAt = Date.now() + durationSeconds * 1000;
  let sequence = 0;
  while (Date.now() < endAt) {
    const source = Keypair.fromSecret(sourceKeys[sequence % sourceKeys.length]);
    const destination = destinations[sequence % destinations.length];
    const category = categoryFor(sequence);
    try {
      const item = await submitPayment({ source, destination, category, studentNumber: sequence + 1 });
      manifest.push(item);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(JSON.stringify(item));
    } catch (error) {
      console.error(JSON.stringify({ category, error: error.message }));
    }
    sequence += 1;
    await sleep(intervalMs);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifest.length} transactions to ${manifestPath}`);
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
