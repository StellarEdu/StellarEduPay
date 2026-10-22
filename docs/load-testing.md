# Staging load and soak testing

Issue #1825 adds a repeatable staging harness under `tests/loadsim/`. It is intentionally separate from the analytical Horizon poll model: this harness exercises a running stack and records end-to-end HTTP and payment-processing behavior.

## Scale seed

`SEED_SCHOOL_COUNT` and `SEED_STUDENTS_PER_SCHOOL` extend `scripts/seed-demo.js` for idempotent multi-school staging data. The default single-school demo remains unchanged. A representative term-start scale is:

```bash
SEED_SCHOOL_COUNT=200 \
SEED_STUDENTS_PER_SCHOOL=500 \
SEED_CLEAN=true \
MONGO_URI="$STAGING_MONGO_URI" \
node scripts/seed-demo.js
```

The seed only deletes generated school IDs when `SEED_CLEAN=true`. Use a disposable staging database or a dedicated `SEED_SCHOOL_ID_PREFIX`.

## Testnet traffic

`tests/loadsim/traffic-generator.js` submits testnet payments from explicitly supplied funded source accounts. It is fail-closed for mainnet unless `LOAD_TEST_ALLOW_MAINNET=true` is deliberately set. The generated mix is:

- 90% valid student memos;
- 5% typo memos;
- 3% missing memos;
- 2% path-payment attempts when `LOAD_TEST_PATH_ASSET_CODE` and `LOAD_TEST_PATH_ASSET_ISSUER` are configured.

Required traffic variables are `LOAD_TEST_SOURCE_SECRET_KEYS` and `LOAD_TEST_DESTINATION_ADDRESSES`. Keep those values in the staging secret store; never commit them or print them in CI logs. The generator writes a transaction manifest containing hashes, categories, school IDs, submission times, and ledger timestamps.

## k6 scenarios

`tests/loadsim/k6/load-test.js` runs:

- parent payment instructions plus verification;
- admin dashboard and report reads;
- bulk student import;
- reminder preview and optional trigger;
- configurable SSE payment-event fan-out;
- a 24-hour dashboard/report soak.

Mutating reminder calls are disabled unless `RUN_MUTATING_SCENARIOS=true`. Use `tests/loadsim/run-load-test.sh` for local or staging execution. It can seed the database with `LOAD_TEST_SEED=true`, start the traffic generator with `LOAD_TEST_START_TRAFFIC=true`, and writes results to `LOAD_TEST_OUTPUT_DIR`.

## SLOs and regression behavior

The harness fails when:

- payment detection p95 exceeds 30 seconds (`DETECTION_SLO_MS` can override this);
- API read p95 exceeds 300 ms (`API_READ_SLO_MS` can override this);
- HTTP error rate exceeds 1%;
- lost-payment rate exceeds 0.1%.

The summary classifies generated transactions as recorded, expected unmatched, or lost. A transaction that returns a client-side unmatched response is not counted as lost; transport and server failures are. To compare with a previous run, set `BASELINE_P95_MS` in the workflow and use the resulting `load-test-summary.json` as the review artifact. The scheduled workflow treats a p95 regression above 20% as a failure through its baseline threshold.

## Scheduled workflow

`.github/workflows/load-test.yml` runs weekly against the configured staging URL. It is gated by the `RUN_STAGING_LOAD_TESTS` repository variable and requires staging secrets for the URL, auth token, MongoDB seed connection, funded test accounts, destinations, and school IDs. It uploads the k6 summary, payment manifest, traffic log, and load-test summary as artifacts even when the run fails.

Do not point this workflow at production. Rotate funded testnet keys and staging tokens after use.
