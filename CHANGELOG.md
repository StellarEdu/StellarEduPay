# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0](https://github.com/StellarEdu/StellarEduPay/compare/v1.0.0...v2.0.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **auth:** POST /api/auth/mfa/{setup,verify,disable} and POST /api/auth/mfa/backup-codes/regenerate now return 404. Use the per-user endpoints under /api/auth/mfa/user/*.

### Added

* add AUDIT_TARGET_TYPES constant and enum +3 more ([ed9a64e](https://github.com/StellarEdu/StellarEduPay/commit/ed9a64edc9e578cc21c740418b8b06691280310e))
* add idempotent plan allocation service +1 more ([3840100](https://github.com/StellarEdu/StellarEduPay/commit/3840100566df03b901f3e7cd1b16fb3975399f42))
* add topology spread constraints to deployments +3 more ([a9bc1f7](https://github.com/StellarEdu/StellarEduPay/commit/a9bc1f7369dc539e67999f7e250d16a80d084a4c))
* **admin:** operations overview endpoint for payment detection health ([9d51a8b](https://github.com/StellarEdu/StellarEduPay/commit/9d51a8bd2a6ce7d042a1b0d4426a37d04b1305dc)), closes [#1817](https://github.com/StellarEdu/StellarEduPay/issues/1817)
* **audit:** add AUDIT_TARGET_TYPES constant and enum ([6137202](https://github.com/StellarEdu/StellarEduPay/commit/613720230b3922aa40e43799ee0e17c82b7a0106)), closes [#1999](https://github.com/StellarEdu/StellarEduPay/issues/1999)
* **auth:** one password policy for change, set, reset and admin hashing ([#1948](https://github.com/StellarEdu/StellarEduPay/issues/1948)) ([c639599](https://github.com/StellarEdu/StellarEduPay/commit/c6395996f87227d84de3127118464c4978ccd708))
* **auth:** require a TOTP factor for the env super-admin login ([#1947](https://github.com/StellarEdu/StellarEduPay/issues/1947)) ([95ff5bf](https://github.com/StellarEdu/StellarEduPay/commit/95ff5bfecd36c8046ec77e376e652f2e3a198f2a))
* **config:** support &lt;SECRET&gt;_FILE for every sensitive setting ([#1829](https://github.com/StellarEdu/StellarEduPay/issues/1829)) ([de5be0b](https://github.com/StellarEdu/StellarEduPay/commit/de5be0b3e65299499401b64757e2cf4cd795d7f6))
* consolidate webhooks and email provider callbacks, add dispute notifications ([6a3df60](https://github.com/StellarEdu/StellarEduPay/commit/6a3df60b6d7deeed5384333702da661fc3082afa)), closes [#1638](https://github.com/StellarEdu/StellarEduPay/issues/1638) [#1639](https://github.com/StellarEdu/StellarEduPay/issues/1639) [#1640](https://github.com/StellarEdu/StellarEduPay/issues/1640) [#1641](https://github.com/StellarEdu/StellarEduPay/issues/1641)
* **deploy:** run migrations in a Job, schema-check in pods ([eb77fd9](https://github.com/StellarEdu/StellarEduPay/commit/eb77fd9e624b1536ee8400a61a261b98726529b5)), closes [#2007](https://github.com/StellarEdu/StellarEduPay/issues/2007)
* **errors:** shared error-code catalog with English and French messages ([#1830](https://github.com/StellarEdu/StellarEduPay/issues/1830)) ([56709f4](https://github.com/StellarEdu/StellarEduPay/commit/56709f4b06a6a35a42149afb3fe6f73193c2f139))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Payments admin screen with suspicious-payment review ([3a2fb48](https://github.com/StellarEdu/StellarEduPay/commit/3a2fb485e46fcd2820d477c0a0a7a8a0ec45267f))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Reminders admin screen ([8a47246](https://github.com/StellarEdu/StellarEduPay/commit/8a472466a1d51ac6c048366d5b57bc2d3fbe537f))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) role-based permissions and API client for admin screens ([6af4ace](https://github.com/StellarEdu/StellarEduPay/commit/6af4ace28f9cc6d1991c092e7d79ff4c9c333e29))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) role-gate refund approval, fix refunds badge, document admin UI ([a4684a3](https://github.com/StellarEdu/StellarEduPay/commit/a4684a30ee77b2425df5bf80e7a22684d2937496))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Security admin screen (sessions and MFA) ([3098b57](https://github.com/StellarEdu/StellarEduPay/commit/3098b575897f9f8ca4a2c3c512f91318e4350374))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Settings & users admin screen ([fd7079f](https://github.com/StellarEdu/StellarEduPay/commit/fd7079f4c180cc89a330e0f80f0f92489371866d))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Students admin screen ([0062de7](https://github.com/StellarEdu/StellarEduPay/commit/0062de710577ba48e3ed5b774757f01daa85cf3e))
* **i18n:** report and enforce translation coverage in CI ([3bf358a](https://github.com/StellarEdu/StellarEduPay/commit/3bf358ac6756decd153e60096d3ea22d7f84411e)), closes [#1793](https://github.com/StellarEdu/StellarEduPay/issues/1793)
* **i18n:** translate parent-facing namespaces and enforce 100% coverage ([#2024](https://github.com/StellarEdu/StellarEduPay/issues/2024)) ([dfc5ec2](https://github.com/StellarEdu/StellarEduPay/commit/dfc5ec2a0581b8b61139812c4b05838acf8e7462))
* **i18n:** translate password and source-validation pages ([#2025](https://github.com/StellarEdu/StellarEduPay/issues/2025)) ([69d3f8e](https://github.com/StellarEdu/StellarEduPay/commit/69d3f8e56abd180154dfd88471a033b6b4824436))
* impemented_logger_Writes_Rotating_files ([ed10e7c](https://github.com/StellarEdu/StellarEduPay/commit/ed10e7c8067349582981f4a9b48093bf499d0804))
* **ingestion:** add INGESTION_MODE setting for Horizon ingestion ([d0d543b](https://github.com/StellarEdu/StellarEduPay/commit/d0d543b6f87d2120926ab9c822c3940d7f3b95d9)), closes [#1989](https://github.com/StellarEdu/StellarEduPay/issues/1989)
* **k8s:** add topology spread constraints to deployments ([a99b093](https://github.com/StellarEdu/StellarEduPay/commit/a99b093e86607933fd7e023ab9a83d9513fe0ba1)), closes [#2009](https://github.com/StellarEdu/StellarEduPay/issues/2009)
* **monitoring:** add Alertmanager routing, Watchdog, and Kubernetes alert rules ([#2018](https://github.com/StellarEdu/StellarEduPay/issues/2018)) ([4926063](https://github.com/StellarEdu/StellarEduPay/commit/4926063d53d29c1b81db3a03efdc9cfbc77f5ad3))
* **monitoring:** add Alertmanager service and receiver routing ([#2018](https://github.com/StellarEdu/StellarEduPay/issues/2018)) ([6eae911](https://github.com/StellarEdu/StellarEduPay/commit/6eae9116b149510655c3e9e152b1502b743d529e))
* **monitoring:** add always-firing Watchdog alert ([#2018](https://github.com/StellarEdu/StellarEduPay/issues/2018)) ([6941ba0](https://github.com/StellarEdu/StellarEduPay/commit/6941ba052a7c6ca342b37b5bdfc2dfc6f531ea2e))
* **monitoring:** generate PrometheusRule CRDs for Kubernetes ([#2018](https://github.com/StellarEdu/StellarEduPay/issues/2018)) ([01a9058](https://github.com/StellarEdu/StellarEduPay/commit/01a9058230d854f6ff8c29dc8914a5700d83ed8a))
* **monitoring:** send Prometheus alerts to Alertmanager ([#2018](https://github.com/StellarEdu/StellarEduPay/issues/2018)) ([48ab1bf](https://github.com/StellarEdu/StellarEduPay/commit/48ab1bf74f08ad3885739d6c2d25ebb4eaf3d264))
* **pay-links:** issue, use and revoke signed student pay links ([#1937](https://github.com/StellarEdu/StellarEduPay/issues/1937)) ([dac08df](https://github.com/StellarEdu/StellarEduPay/commit/dac08df91596b9ad033c7e989627f1a1226e33a7))
* **payment-plans:** add idempotent plan allocation service ([d27c9ab](https://github.com/StellarEdu/StellarEduPay/commit/d27c9ab322175f818a440363f514fb6d31875383)), closes [#1984](https://github.com/StellarEdu/StellarEduPay/issues/1984)
* **payments:** add PARTIALLY_REFUNDED status ([98b9798](https://github.com/StellarEdu/StellarEduPay/commit/98b9798ba5065f2a73b974aa93eab30982c369fe)), closes [#1982](https://github.com/StellarEdu/StellarEduPay/issues/1982)
* **payments:** add per-school accepted asset resolver ([90c135d](https://github.com/StellarEdu/StellarEduPay/commit/90c135d61df2e5ea159df43b0b10d08f92e3ef86)), closes [#1993](https://github.com/StellarEdu/StellarEduPay/issues/1993)
* **payments:** ingestStartsAt bounds history ingestion per school wallet ([7744e81](https://github.com/StellarEdu/StellarEduPay/commit/7744e8134aed3a611338f2b4648aef2bd3c87853)), closes [#1818](https://github.com/StellarEdu/StellarEduPay/issues/1818)
* **payments:** signed per-student pay link tokens ([c818284](https://github.com/StellarEdu/StellarEduPay/commit/c818284e4f5b3c0ddc20d34873c0adc9c87a19ec))
* **pay:** wallet payment request builder and network gating ([5a5b6ed](https://github.com/StellarEdu/StellarEduPay/commit/5a5b6edb2231e9df04547b3ce5eb28989a5d5dc8))
* **privacy:** anonymize remaining student PII fields ([1c578cb](https://github.com/StellarEdu/StellarEduPay/commit/1c578cbb313bf7e0fcd0cc8c3b71dc177a30d04b)), closes [#2004](https://github.com/StellarEdu/StellarEduPay/issues/2004)
* **rate-limit:** key global limiter by user ID, anon by IP ([25b7ee9](https://github.com/StellarEdu/StellarEduPay/commit/25b7ee9fc85c0f725ca99055858cc966376cfd41)), closes [#2012](https://github.com/StellarEdu/StellarEduPay/issues/2012)
* **refunds:** add reject, send-and-complete and timeline to refunds page ([#2027](https://github.com/StellarEdu/StellarEduPay/issues/2027)) ([62c7a39](https://github.com/StellarEdu/StellarEduPay/commit/62c7a3952bd3146e237a02cbf721dbfadb19bb09))
* **refunds:** verify refund tx on Horizon ([2b350a2](https://github.com/StellarEdu/StellarEduPay/commit/2b350a2425372232c9d4679ebf2c1c5d0f6accb1)), closes [#1981](https://github.com/StellarEdu/StellarEduPay/issues/1981)
* release process, coverage ratchet, OpenTelemetry tracing and parent portal ([9ff7adf](https://github.com/StellarEdu/StellarEduPay/commit/9ff7adfc76893aca2079bd8b88aab1e470743852)), closes [#1634](https://github.com/StellarEdu/StellarEduPay/issues/1634) [#1635](https://github.com/StellarEdu/StellarEduPay/issues/1635) [#1636](https://github.com/StellarEdu/StellarEduPay/issues/1636) [#1637](https://github.com/StellarEdu/StellarEduPay/issues/1637)
* release process, coverage ratchet, OpenTelemetry tracing and parent portal ([#1634](https://github.com/StellarEdu/StellarEduPay/issues/1634) [#1635](https://github.com/StellarEdu/StellarEduPay/issues/1635) [#1636](https://github.com/StellarEdu/StellarEduPay/issues/1636) [#1637](https://github.com/StellarEdu/StellarEduPay/issues/1637)) ([76c34bb](https://github.com/StellarEdu/StellarEduPay/commit/76c34bbea31cf8894db9e92d9bd5c7287adbad6b))
* **schools:** wallet readiness evaluator for school Stellar accounts ([29a942f](https://github.com/StellarEdu/StellarEduPay/commit/29a942f3a2b36bdb0ca7ee27d4f949f2dbd42848))
* **students:** dry-run bulk import preview and CSV template ([ca57d8c](https://github.com/StellarEdu/StellarEduPay/commit/ca57d8cd76d61bc4c71f44a617250065f7c156e4)), closes [#1816](https://github.com/StellarEdu/StellarEduPay/issues/1816)
* **wallets:** run wallet readiness on create, update and rotate ([#1938](https://github.com/StellarEdu/StellarEduPay/issues/1938)) ([ffa3c52](https://github.com/StellarEdu/StellarEduPay/commit/ffa3c526e36e0464bb3cffd79311dd7824a10499))
* **webhooks:** apiVersion and per-endpoint sequence on event deliveries ([7f30cfe](https://github.com/StellarEdu/StellarEduPay/commit/7f30cfef3b5d26d0f02005f8c97e62187aa8a3f2)), closes [#1815](https://github.com/StellarEdu/StellarEduPay/issues/1815)


### Fixed

* [#1497](https://github.com/StellarEdu/StellarEduPay/issues/1497) [#1630](https://github.com/StellarEdu/StellarEduPay/issues/1630) [#1632](https://github.com/StellarEdu/StellarEduPay/issues/1632) [#1633](https://github.com/StellarEdu/StellarEduPay/issues/1633) — webhook IP pinning, secure backups, OpenAPI contract, docs cleanup ([0f65ecf](https://github.com/StellarEdu/StellarEduPay/commit/0f65ecfd82a987c2409ca520dbe6eaa4e9f829e7))
* [#1497](https://github.com/StellarEdu/StellarEduPay/issues/1497) [#1630](https://github.com/StellarEdu/StellarEduPay/issues/1630) [#1632](https://github.com/StellarEdu/StellarEduPay/issues/1632) [#1633](https://github.com/StellarEdu/StellarEduPay/issues/1633) webhook IP pinning, secure backups, OpenAPI contract, docs cleanup ([024e162](https://github.com/StellarEdu/StellarEduPay/commit/024e162f93a4c9abcbdef4637a2c353a43e358f7))
* [#1557](https://github.com/StellarEdu/StellarEduPay/issues/1557) Path payments (path_payment_strict_send / strict_receive) to ([27fe934](https://github.com/StellarEdu/StellarEduPay/commit/27fe934373f2cbf46bcbdba29b3ad98eeef21bf6))
* [#1558](https://github.com/StellarEdu/StellarEduPay/issues/1558) Only the first payment operation in a transaction is credited ([3c89250](https://github.com/StellarEdu/StellarEduPay/commit/3c8925074f844723143ba5f76df8affc631a1523))
* [#1559](https://github.com/StellarEdu/StellarEduPay/issues/1559) Monetary amounts are stored and aggregated as IEEE-754 double ([02e7cb2](https://github.com/StellarEdu/StellarEduPay/commit/02e7cb27cc713fccb35279ef859b9f7bf2438da6))
* [#1560](https://github.com/StellarEdu/StellarEduPay/issues/1560) Payments carry three overlapping state fields (status, confir ([c0bc44d](https://github.com/StellarEdu/StellarEduPay/commit/c0bc44da307d78a7dd0e4132b1a4f6ad6574966b))
* [#1561](https://github.com/StellarEdu/StellarEduPay/issues/1561) POST /api/payments/submit accepts arbitrary XDR from anonymou ([ab0e00a](https://github.com/StellarEdu/StellarEduPay/commit/ab0e00a0cf3d3c7886ce5ecc51d992970f8649f7))
* [#1562](https://github.com/StellarEdu/StellarEduPay/issues/1562) submitTransaction marks payments FAILED on ambiguous Horizon ([d4203cf](https://github.com/StellarEdu/StellarEduPay/commit/d4203cf77b40d70bce4d418ad4468d1ff6672e45))
* [#1563](https://github.com/StellarEdu/StellarEduPay/issues/1563) Upgrade @stellar/stellar-sdk from 12.3.0 to a current major r ([2015315](https://github.com/StellarEdu/StellarEduPay/commit/20153150a959761bf33af1d8564abf4904d7b86e))
* [#1568](https://github.com/StellarEdu/StellarEduPay/issues/1568) Payment-plan installments are marked paid by hand and are not ([9394730](https://github.com/StellarEdu/StellarEduPay/commit/9394730b4fae4289c7dab207e8ed2aa4f0cdd15c))
* [#1591](https://github.com/StellarEdu/StellarEduPay/issues/1591) Add automated accessibility checks and fix WCAG issues on the ([f25df1d](https://github.com/StellarEdu/StellarEduPay/commit/f25df1d86332a88a5bd23ee2072eb643d80f3930))
* [#1592](https://github.com/StellarEdu/StellarEduPay/issues/1592) /api/retry-queue routes are registered after the 404 handler ([c529c72](https://github.com/StellarEdu/StellarEduPay/commit/c529c72bb8a1d1757f5352b5bf5971ec8a92c17b))
* [#1593](https://github.com/StellarEdu/StellarEduPay/issues/1593) Backup heartbeat route is never mounted, so backup_last_succe ([aec7313](https://github.com/StellarEdu/StellarEduPay/commit/aec73134abe590997b2e0929874b4cc00e3625af))
* [#1597](https://github.com/StellarEdu/StellarEduPay/issues/1597) Global limit of 100 requests/minute per IP is hard-coded and ([884c6fa](https://github.com/StellarEdu/StellarEduPay/commit/884c6fa121f676bd72d0769c16f1ae0cfbc61342))
* [#1601](https://github.com/StellarEdu/StellarEduPay/issues/1601) ~200 environment variables are read directly from process.env ([a1afe41](https://github.com/StellarEdu/StellarEduPay/commit/a1afe419b9f3cff2cc2846ba51be6af84e4e58d2))
* [#1602](https://github.com/StellarEdu/StellarEduPay/issues/1602) Per-school settings maxSyncBatchSize and reminderIntervalMs a ([7073c35](https://github.com/StellarEdu/StellarEduPay/commit/7073c354516386ac1270ab1ec5126d9d604fa308))
* [#1603](https://github.com/StellarEdu/StellarEduPay/issues/1603) SMS/WhatsApp notification service (Twilio) is implemented but ([f79f8db](https://github.com/StellarEdu/StellarEduPay/commit/f79f8dbc1ec1ecb0f6c9f9020dd35e7626fe6a1c))
* [#1604](https://github.com/StellarEdu/StellarEduPay/issues/1604) Remove unused multer (known CVEs) and replace unmaintained sp ([bea26f8](https://github.com/StellarEdu/StellarEduPay/commit/bea26f8581be6857c0a25e9283c99822af83b3fe))
* [#1605](https://github.com/StellarEdu/StellarEduPay/issues/1605) Node.js 20 reached end of life in April 2026 — upgrade runtim ([f494827](https://github.com/StellarEdu/StellarEduPay/commit/f4948277aaabc35f79493472cc7bf6aa06314ab1))
* [#1606](https://github.com/StellarEdu/StellarEduPay/issues/1606) Migrate the backend from Express 4 to Express 5 ([b3b0219](https://github.com/StellarEdu/StellarEduPay/commit/b3b0219c5e26f10cf003164249937a8b16a616d9))
* [#1607](https://github.com/StellarEdu/StellarEduPay/issues/1607) Daily schedulers use setInterval, so any restart or leader ch ([060a3f4](https://github.com/StellarEdu/StellarEduPay/commit/060a3f47ab214f248ec959adf623930cc31c4f32))
* [#1608](https://github.com/StellarEdu/StellarEduPay/issues/1608) Interval-based background jobs have no re-entrancy guard, so ([8a02033](https://github.com/StellarEdu/StellarEduPay/commit/8a02033540e1eca5e9286097aa7c567c2dbed0c2))
* [#1609](https://github.com/StellarEdu/StellarEduPay/issues/1609) Audit logs are hard-deleted by a TTL index after 730 days, co ([4931199](https://github.com/StellarEdu/StellarEduPay/commit/49311998ca43ac0990be8d8a421c4af5b39c7d41))
* [#1610](https://github.com/StellarEdu/StellarEduPay/issues/1610) Concurrent audit writes fork the per-school hash chain, makin ([c36b7ef](https://github.com/StellarEdu/StellarEduPay/commit/c36b7ef96aa2cd5c7661be99953973d37310fc8e))
* [#1611](https://github.com/StellarEdu/StellarEduPay/issues/1611) Student CSV export ignores backpressure, can crash after head ([3376c62](https://github.com/StellarEdu/StellarEduPay/commit/3376c629e7298c4905e820e5c819519e5de533ab))
* [#1612](https://github.com/StellarEdu/StellarEduPay/issues/1612) JSON bulk student import is capped at roughly 100 students by ([f117766](https://github.com/StellarEdu/StellarEduPay/commit/f117766a45713a0ed6e14e4132ff78386a2050ce))
* [#1723](https://github.com/StellarEdu/StellarEduPay/issues/1723) restore truncated paymentRoutes.js tail ([e9263c5](https://github.com/StellarEdu/StellarEduPay/commit/e9263c5f151fcfd8b0f77e5ad8f272bc7a9e6ceb))
* [#1723](https://github.com/StellarEdu/StellarEduPay/issues/1723) restore truncated paymentRoutes.js tail ([9e19d72](https://github.com/StellarEdu/StellarEduPay/commit/9e19d724f158273756ce74d01612971859ee86e3))
* [#1723](https://github.com/StellarEdu/StellarEduPay/issues/1723) routes/paymentRoutes.js is truncated mid-statement (SyntaxErr ([deb2f64](https://github.com/StellarEdu/StellarEduPay/commit/deb2f649c0a2c65ff6682b3d3f7fcbc0264c82f5))
* [#1725](https://github.com/StellarEdu/StellarEduPay/issues/1725) RECEIPT_SIGNATURE_SECRET is now a required boot variable but ([84c4f0a](https://github.com/StellarEdu/StellarEduPay/commit/84c4f0ac305fe1fd09abcc95d827d4801517bbcc))
* [#1726](https://github.com/StellarEdu/StellarEduPay/issues/1726) Kubernetes migrate initContainer only receives MONGO_URI and ([9d1b607](https://github.com/StellarEdu/StellarEduPay/commit/9d1b607f2990405d053a29baaf4e12eafd1db6c9))
* [#1727](https://github.com/StellarEdu/StellarEduPay/issues/1727) frontend/package-lock.json was not regenerated after the Next ([88e9f77](https://github.com/StellarEdu/StellarEduPay/commit/88e9f77332c5fea550c4e7e653d48f22bd0bd2b8))
* [#1729](https://github.com/StellarEdu/StellarEduPay/issues/1729) main has been red for weeks and PRs are merged with failing c ([9f152c0](https://github.com/StellarEdu/StellarEduPay/commit/9f152c066dea411a3b2aa766d29e9345220290a8))
* [#1741](https://github.com/StellarEdu/StellarEduPay/issues/1741) Harden JWT handling — pin the algorithm, add iss/aud/jti, and ([bc64d26](https://github.com/StellarEdu/StellarEduPay/commit/bc64d262a7b1355ccbb8776c335cda3a4d7f0628))
* [#1742](https://github.com/StellarEdu/StellarEduPay/issues/1742) Global `mongoose.set('sanitizeFilter', true)` rewrites every ([d2ba18b](https://github.com/StellarEdu/StellarEduPay/commit/d2ba18bc469d364bc5f83de4a5ec90952c41f369))
* [#1751](https://github.com/StellarEdu/StellarEduPay/issues/1751) A student's "amount paid" is computed by six different algori ([e1a89a9](https://github.com/StellarEdu/StellarEduPay/commit/e1a89a96fded9c2058a07432f62d377b013884f0))
* [#1752](https://github.com/StellarEdu/StellarEduPay/issues/1752) Manual credit adjustments are wiped the next time the poller, ([14675b8](https://github.com/StellarEdu/StellarEduPay/commit/14675b82858ef3e7671119b0c1099670d4eb2a58))
* [#1755](https://github.com/StellarEdu/StellarEduPay/issues/1755) The poller records suspicious payments as status FAILED — rea ([e7eaa4c](https://github.com/StellarEdu/StellarEduPay/commit/e7eaa4c65cf7d0042b98e623d05b23649c96001c))
* [#1756](https://github.com/StellarEdu/StellarEduPay/issues/1756) Poller still passes asset?.code (always undefined) to payment ([3e2cddb](https://github.com/StellarEdu/StellarEduPay/commit/3e2cddbf0b5de6c5e494a18201fa0f306f02ede3))
* [#1757](https://github.com/StellarEdu/StellarEduPay/issues/1757) Incoming amounts are parsed three different ways (parseFloat, ([bb3008e](https://github.com/StellarEdu/StellarEduPay/commit/bb3008e1afb2657eb745b9358b4692dff3d4eebd))
* [#1758](https://github.com/StellarEdu/StellarEduPay/issues/1758) Fee local-currency equivalents always assume the fee is in XL ([fa9993d](https://github.com/StellarEdu/StellarEduPay/commit/fa9993d35980f23c171cfc31ec5f13e50d45e507))
* **#1727:** regenerate frontend lockfile for Next 15 / React 19 / ESL… ([d1dff29](https://github.com/StellarEdu/StellarEduPay/commit/d1dff29fc332fe97684652317b35ba2ca823fa7a))
* **#1727:** regenerate frontend lockfile for Next 15 / React 19 / ESLint 9 ([fd41f6a](https://github.com/StellarEdu/StellarEduPay/commit/fd41f6a71bc91a0f3837267aa05de0ca829d8497))
* **#1743:** replace findById* with findOne({ _id, schoolId }) on all … ([3dae82f](https://github.com/StellarEdu/StellarEduPay/commit/3dae82f03aa0f89a01c272c04a38b24f3f58b495))
* **#1743:** replace findById* with findOne({ _id, schoolId }) on all tenant-scoped models ([31d4559](https://github.com/StellarEdu/StellarEduPay/commit/31d4559535d29e059b2d254e9a3abedf549927a7))
* **#1747:** wire in path payments, report cache invalidation; add knip to CI ([f85d783](https://github.com/StellarEdu/StellarEduPay/commit/f85d783d95d79181ace708e948ff4dc559f39d56))
* **#1751:** unify student balance computation across all pipelines ([b5b8687](https://github.com/StellarEdu/StellarEduPay/commit/b5b86876732ac1de4680712923514aab3a99104d))
* **#1751:** unify student balance computation across all pipelines ([34c7bec](https://github.com/StellarEdu/StellarEduPay/commit/34c7becb463ec80572d6319cb893dc9be59291b1))
* **#1799:** keep retired wallet addresses draining after rotation ([389b3e6](https://github.com/StellarEdu/StellarEduPay/commit/389b3e66cd80f2894fc59f6751b8dc466b37eabe))
* **#1800:** audit every super-admin cross-tenant school access ([de85efc](https://github.com/StellarEdu/StellarEduPay/commit/de85efc81029149dbc7615fdc0d2b541d2682a5a))
* **#1801:** enforce student quota atomically and apply limit changes at once ([3793baa](https://github.com/StellarEdu/StellarEduPay/commit/3793baaa006fe8c43d386a13d62dd25f1d09cdde))
* **#1921:** one token/session store interface, Redis-backed in production ([156a401](https://github.com/StellarEdu/StellarEduPay/commit/156a401ab52be9c0e63ed28ed52ec5e09e0e4423)), closes [#1921](https://github.com/StellarEdu/StellarEduPay/issues/1921)
* **#1922:** unblock backend boot and document required CI checks ([c535f60](https://github.com/StellarEdu/StellarEduPay/commit/c535f606cadef57d7e682b91de8600079f7a9673)), closes [#1922](https://github.com/StellarEdu/StellarEduPay/issues/1922)
* **#1923:** make the k8s-ingress-tls job check the ingress ([3db65a3](https://github.com/StellarEdu/StellarEduPay/commit/3db65a35617e30dfb832b2bc5c576faa749299a3)), closes [#1923](https://github.com/StellarEdu/StellarEduPay/issues/1923)
* **#1924:** run the smoke job on Node 24 with installed deps and CI secrets ([d604838](https://github.com/StellarEdu/StellarEduPay/commit/d60483813224a7864d88cf953d2fe80f670ceb23)), closes [#1924](https://github.com/StellarEdu/StellarEduPay/issues/1924)
* **#1929:** ship OpenTelemetry SDK and redact span exports ([72ffc87](https://github.com/StellarEdu/StellarEduPay/commit/72ffc87db1d22cf6e858d28e866efe9a2a609f72))
* **#1930:** install production deps in the image and add .dockerignore ([64406a0](https://github.com/StellarEdu/StellarEduPay/commit/64406a096e066ad7e880097d1ced51f6d8f9ed29))
* **#1931:** make the Docker HEALTHCHECK probe the real /health/live URL ([831a7e5](https://github.com/StellarEdu/StellarEduPay/commit/831a7e5ae9c008d3c448a1f51ea386a0729143cd))
* **#1932:** point backend start/dev at src/app.js and fix app boot ([082b4c1](https://github.com/StellarEdu/StellarEduPay/commit/082b4c1af4752593846d0aeab1d10e4c1da01b4e))
* **a11y:** make payment and verify flow accessible ([#1832](https://github.com/StellarEdu/StellarEduPay/issues/1832)) ([ae4c5a8](https://github.com/StellarEdu/StellarEduPay/commit/ae4c5a8dbd78f69833316d50a136e59d2890827a))
* **academic-periods:** batch rollover writes to stay within transaction limits ([0f078f0](https://github.com/StellarEdu/StellarEduPay/commit/0f078f013c68c2fff83a41d10565fcf528001a87)), closes [#1784](https://github.com/StellarEdu/StellarEduPay/issues/1784)
* **academic-periods:** keep StudentPeriodFee.totalPaid in step with payments ([2cd3ee1](https://github.com/StellarEdu/StellarEduPay/commit/2cd3ee1f40aa0ed4ec3dabf1eae7748c25623239)), closes [#1785](https://github.com/StellarEdu/StellarEduPay/issues/1785)
* align Node.js runtime to v24 across all environments ([#1735](https://github.com/StellarEdu/StellarEduPay/issues/1735)) ([752e6b0](https://github.com/StellarEdu/StellarEduPay/commit/752e6b0361ca09f688c24111ef7cb27849da01f0))
* align Node.js runtime to v24 across all environments ([#1735](https://github.com/StellarEdu/StellarEduPay/issues/1735)) ([4075841](https://github.com/StellarEdu/StellarEduPay/commit/40758410e1c3606515ea72cc95bcfa8a7ee9c38b))
* **analytics:** authorize school roles ([f872ac7](https://github.com/StellarEdu/StellarEduPay/commit/f872ac764742a96c4aee7dff65715de95839e38e))
* **analytics:** authorize school roles ([e4804fa](https://github.com/StellarEdu/StellarEduPay/commit/e4804fab5d24f997c2500cea1df5488bc846afd5))
* **anchor:** validate SEP-10 challenges against the anchor's SIGNING_KEY before signing ([#1952](https://github.com/StellarEdu/StellarEduPay/issues/1952)) ([39ad069](https://github.com/StellarEdu/StellarEduPay/commit/39ad0693b2e97e3fe9ea0b4aa9115b5ff9b5b961))
* **api:** [#1787](https://github.com/StellarEdu/StellarEduPay/issues/1787) let staff correct parent email and phone on update ([9cab182](https://github.com/StellarEdu/StellarEduPay/commit/9cab1829007a13a81927b76e0fd16f4d5e0fd3fe))
* **api:** let school staff read students and mount balance route ([#2026](https://github.com/StellarEdu/StellarEduPay/issues/2026)) ([77598ed](https://github.com/StellarEdu/StellarEduPay/commit/77598ed2b229e0af86535f6bccc807a7664550ce))
* **app:** remove duplicate internalRoutes require and /api/internal mount ([#1919](https://github.com/StellarEdu/StellarEduPay/issues/1919)) ([d61e9a7](https://github.com/StellarEdu/StellarEduPay/commit/d61e9a71f5f6236bfa0795ceb90ae6c61c235007))
* **audit:** [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) add auditContext to routes + logAudit to all mutati… ([a10790f](https://github.com/StellarEdu/StellarEduPay/commit/a10790f68e7f8b355a2f670a96517f7e7c45c723))
* **audit:** add seq/severity and unique schoolId+seq index ([d871380](https://github.com/StellarEdu/StellarEduPay/commit/d871380cd8a13dfdddac089ff6dad3997a2e0c74)), closes [#2000](https://github.com/StellarEdu/StellarEduPay/issues/2000)
* **auth:** bind access tokens to their session so revocation takes effect ([#1940](https://github.com/StellarEdu/StellarEduPay/issues/1940)) ([83c087a](https://github.com/StellarEdu/StellarEduPay/commit/83c087a48283380934c85c6d4264672513d5025d))
* **auth:** bind tenant and verify tokens through tokenService only ([#1941](https://github.com/StellarEdu/StellarEduPay/issues/1941)) ([8eae18f](https://github.com/StellarEdu/StellarEduPay/commit/8eae18f7af3711265429e45367c4a8bfcad1836d))
* **auth:** block brute-force per credential, not per IP; make blocks observable ([#1950](https://github.com/StellarEdu/StellarEduPay/issues/1950)) ([034b6d4](https://github.com/StellarEdu/StellarEduPay/commit/034b6d457d0eaa02a50e8094ae67a9788cb401ae))
* **auth:** consume MFA backup codes atomically at login ([#1943](https://github.com/StellarEdu/StellarEduPay/issues/1943)) ([16676e6](https://github.com/StellarEdu/StellarEduPay/commit/16676e6873a26ff60086c3b0f5ef6ae755951270))
* **auth:** enforce MFA enrolment on restricted tokens ([#1942](https://github.com/StellarEdu/StellarEduPay/issues/1942)) ([98833ab](https://github.com/StellarEdu/StellarEduPay/commit/98833ab29538877b420f0b76c7b6653feae15c46))
* **auth:** issue access tokens the middleware accepts ([#1939](https://github.com/StellarEdu/StellarEduPay/issues/1939)) ([9e8be90](https://github.com/StellarEdu/StellarEduPay/commit/9e8be906f748c8fe8265f35f63750d4d426c8dd3))
* **auth:** limit second-factor attempts and throttle session endpoints ([#1945](https://github.com/StellarEdu/StellarEduPay/issues/1945)) ([6269d97](https://github.com/StellarEdu/StellarEduPay/commit/6269d971a3cedc156f89f920771958f91f3837e8))
* **auth:** remove the school-level MFA API ([#1946](https://github.com/StellarEdu/StellarEduPay/issues/1946)) ([70d4770](https://github.com/StellarEdu/StellarEduPay/commit/70d477011ae82c51f5d53823892de2e7fc12e02e))
* **auth:** resolve REQUIRE_MFA enrolment loop ([#1739](https://github.com/StellarEdu/StellarEduPay/issues/1739)) ([3e44457](https://github.com/StellarEdu/StellarEduPay/commit/3e444574ced9c1947ad4e267d6777c5ee107104a))
* **auth:** resolve REQUIRE_MFA enrolment loop ([#1739](https://github.com/StellarEdu/StellarEduPay/issues/1739)) ([b156442](https://github.com/StellarEdu/StellarEduPay/commit/b156442a7cdd93422c1503aec2e95aa1aef78313))
* **auth:** stop unauthenticated callers writing audit rows into tenants and leaking raw IPs ([#1949](https://github.com/StellarEdu/StellarEduPay/issues/1949)) ([fcb2c10](https://github.com/StellarEdu/StellarEduPay/commit/fcb2c10f5ef48b4d28d34b919c9bbf485d5d6842))
* **backend:** add missing ttl helper and repoint unresolved requires ([#1920](https://github.com/StellarEdu/StellarEduPay/issues/1920)) ([d78d95e](https://github.com/StellarEdu/StellarEduPay/commit/d78d95e16fa7e1463b63e4a4c952ba70a2b70b86))
* **backend:** declare every package the backend requires ([#1928](https://github.com/StellarEdu/StellarEduPay/issues/1928)) ([8df6223](https://github.com/StellarEdu/StellarEduPay/commit/8df6223bb33ea7920cb290fc9e8b1b73f864ffd0))
* **backend:** mount GET /api/public-config ([eac5b06](https://github.com/StellarEdu/StellarEduPay/commit/eac5b0699bbea9df5000757792103031006a9dcb)), closes [#1792](https://github.com/StellarEdu/StellarEduPay/issues/1792)
* **backend:** point entrypoints at existing src/app.js ([#1932](https://github.com/StellarEdu/StellarEduPay/issues/1932)) ([08b780b](https://github.com/StellarEdu/StellarEduPay/commit/08b780b300178c542e81f22652b8ca560c256d49))
* **backend:** point entrypoints at existing src/app.js ([#1932](https://github.com/StellarEdu/StellarEduPay/issues/1932)) ([3135107](https://github.com/StellarEdu/StellarEduPay/commit/3135107165c1df9d092be2ffc1b18030d6ed06be))
* **backend:** remove duplicate internalRoutes; resolve secrets files first ([88b2766](https://github.com/StellarEdu/StellarEduPay/commit/88b27666e864739ed43c510548ff4099746da113))
* **backend:** restore missing ttl util and auth middleware User import ([0dceb57](https://github.com/StellarEdu/StellarEduPay/commit/0dceb57969c56ccbc63116e490c5eba5f6cc3270))
* **backend:** restore modules that stopped the backend loading ([#1928](https://github.com/StellarEdu/StellarEduPay/issues/1928)) ([419d896](https://github.com/StellarEdu/StellarEduPay/commit/419d8967698688cd2225e9c68c9d96115e272de8))
* **backend:** restore truncated modules and missing handler references ([#1918](https://github.com/StellarEdu/StellarEduPay/issues/1918)) ([31fab4b](https://github.com/StellarEdu/StellarEduPay/commit/31fab4bff4c95edc8dcdd1d24f16fbdc6b832951))
* **backend:** unblock app boot and declare speakeasy dependency ([49f2efa](https://github.com/StellarEdu/StellarEduPay/commit/49f2efa08cfbc7b06922e837b529974afc013eb5))
* **backend:** unblock module loading for auth middleware and app boot ([f6f1482](https://github.com/StellarEdu/StellarEduPay/commit/f6f148250f93a126834c22bc1ed0639c954ac168))
* bypass tenant scope and batch expired intents +3 more ([f6d4d81](https://github.com/StellarEdu/StellarEduPay/commit/f6d4d8100db040d1d968ee29eadace2f277d6193))
* **ci:** align root Babel packages to major 7 so `npm ci` resolves ([46dd6a9](https://github.com/StellarEdu/StellarEduPay/commit/46dd6a903e3b8ccd2955306e9e161a43811ee13e))
* **ci:** make backup restore test install deps and fail loudly ([#1926](https://github.com/StellarEdu/StellarEduPay/issues/1926)) ([8ec2ab8](https://github.com/StellarEdu/StellarEduPay/commit/8ec2ab880fae5a094fa3abd4cfe9c6cb17fa4d45))
* **ci:** publish images under lowercase GHCR owner ([#1925](https://github.com/StellarEdu/StellarEduPay/issues/1925)) ([ebb48ee](https://github.com/StellarEdu/StellarEduPay/commit/ebb48ee3f2400bba92eab34cf6364d4ce8a6ab28))
* claim reminder slot via status state machine +2 more ([df7a85a](https://github.com/StellarEdu/StellarEduPay/commit/df7a85a11759c2086f4cfe45fe6ef99eb988e61a))
* consolidate ad-hoc migrations into versioned runner ([#1631](https://github.com/StellarEdu/StellarEduPay/issues/1631)) ([a42fcce](https://github.com/StellarEdu/StellarEduPay/commit/a42fcce060d5ebeba6b323b7bb4f913ad5a929dc))
* **currency:** secure CoinGecko API plans ([ae8ab93](https://github.com/StellarEdu/StellarEduPay/commit/ae8ab9389cd43e0a360183fc5e668373c55c6566))
* **currency:** secure CoinGecko API plans ([f93aed4](https://github.com/StellarEdu/StellarEduPay/commit/f93aed41e2c06616f87a26896f4aa0b0f921c4d1))
* **deploy:** use canonical ghcr.io/stellaredu images everywhere ([#1927](https://github.com/StellarEdu/StellarEduPay/issues/1927)) ([e3c8113](https://github.com/StellarEdu/StellarEduPay/commit/e3c811337f4d767d48f2ae932a4ce201963b79d8))
* **deps:** resolve high/critical advisories and resync lockfiles ([#1828](https://github.com/StellarEdu/StellarEduPay/issues/1828)) ([6ebcc0c](https://github.com/StellarEdu/StellarEduPay/commit/6ebcc0c6a41d5ce8d781b072957f906b19a45305))
* **disputes:** import requireSchoolAuth and bind disputes to the payment's student ([805c1f9](https://github.com/StellarEdu/StellarEduPay/commit/805c1f930a05e01bf39f7569d73c8742ba1e5f7c))
* **docker:** [#1933](https://github.com/StellarEdu/StellarEduPay/issues/1933) proxy target reaches the frontend build; frontend image builds ([16858c3](https://github.com/StellarEdu/StellarEduPay/commit/16858c3934b728958be4022c89fe73ead65e5568))
* drop Horizon from readiness, add horizon_up +2 more ([d904672](https://github.com/StellarEdu/StellarEduPay/commit/d9046720adefe146d28a11e0f2076156f53e6496))
* Every probe and every anonymous GET /health makes a live Horizon request — no caching, so probes eat the Horizon budget and the endpoint can be used for amplification ([#2014](https://github.com/StellarEdu/StellarEduPay/issues/2014)) ([1c291da](https://github.com/StellarEdu/StellarEduPay/commit/1c291da4e5c6f21b6282044c0fc5fcd3a5262571))
* **fees:** allow replacing inactive structures ([02cc275](https://github.com/StellarEdu/StellarEduPay/commit/02cc2755906fec8e4378635787b7bf5ac07f5094))
* **fees:** allow replacing inactive structures ([79b2b6f](https://github.com/StellarEdu/StellarEduPay/commit/79b2b6f3169a0781871c1b1e59edd9e82b08267b))
* **fees:** call useTranslation in FeesPage ([00e62a6](https://github.com/StellarEdu/StellarEduPay/commit/00e62a6f51f60b55422eb531a32a03b6fdae6843))
* **frontend:** [#1578](https://github.com/StellarEdu/StellarEduPay/issues/1578) route analytics and webhooks requests through the shared API client ([443182c](https://github.com/StellarEdu/StellarEduPay/commit/443182c8e1dfbfa8ea30e1b91ffd79d989cb91ca))
* **frontend:** [#1578](https://github.com/StellarEdu/StellarEduPay/issues/1578) use a single same-origin API base for every client call ([45216be](https://github.com/StellarEdu/StellarEduPay/commit/45216bed3bd7f6c5c309bd62d0156751c98fc1a4))
* **frontend:** [#1579](https://github.com/StellarEdu/StellarEduPay/issues/1579) enforce the RequireAdmin guard centrally for all admin routes ([f97b42d](https://github.com/StellarEdu/StellarEduPay/commit/f97b42dbb4fd521293ad94794bf513d4746406a6))
* **frontend:** [#1580](https://github.com/StellarEdu/StellarEduPay/issues/1580) single source of truth for Navbar and sidebar navigation ([7850704](https://github.com/StellarEdu/StellarEduPay/commit/7850704c7e243c470fc5b75e31424cc7a68c85e6))
* **frontend:** [#1789](https://github.com/StellarEdu/StellarEduPay/issues/1789) restore API helpers dropped by merge 0e3d70c ([48c3560](https://github.com/StellarEdu/StellarEduPay/commit/48c35609add475febca73fa1ba6600158ac14a8d))
* **frontend:** [#1790](https://github.com/StellarEdu/StellarEduPay/issues/1790) import getPaymentPlan in PaymentForm ([e92ed66](https://github.com/StellarEdu/StellarEduPay/commit/e92ed66f27128798467816e4c7e60b1b6294277d))
* **frontend:** make the production build compile ([51ddbfe](https://github.com/StellarEdu/StellarEduPay/commit/51ddbfe64e1437a20aff523ebbc7b9629f7a5af1))
* **frontend:** super-admin school switcher reads bare array response ([cc1b323](https://github.com/StellarEdu/StellarEduPay/commit/cc1b323a87367904c543ff17429ad582ccbb27b5)), closes [#1791](https://github.com/StellarEdu/StellarEduPay/issues/1791)
* **health:** cache Horizon status for anonymous probes ([#2014](https://github.com/StellarEdu/StellarEduPay/issues/2014)) ([db2fae9](https://github.com/StellarEdu/StellarEduPay/commit/db2fae90aa329caaa230095e2d0e5ed8a890cb06))
* **health:** drop Horizon from readiness, add horizon_up ([440a67e](https://github.com/StellarEdu/StellarEduPay/commit/440a67e10e62d725767a89575c7cf17dce1e8343)), closes [#2013](https://github.com/StellarEdu/StellarEduPay/issues/2013)
* **health:** mount probes before rate limiter and queue ([62fd68c](https://github.com/StellarEdu/StellarEduPay/commit/62fd68c986ca577045284891dbd4638256eb3426)), closes [#2011](https://github.com/StellarEdu/StellarEduPay/issues/2011)
* **i18n:** define translation keys used by the UI in en.js and fr.js ([d9df9b2](https://github.com/StellarEdu/StellarEduPay/commit/d9df9b2d8a01bef10b57d3e01e5c073773435e9a)), closes [#1794](https://github.com/StellarEdu/StellarEduPay/issues/1794)
* **ingest:** enforce ingestStartsAt in shared ingestion path ([d7db029](https://github.com/StellarEdu/StellarEduPay/commit/d7db029b1fc40f25f210fdde90ed1f6e4c226b01)), closes [#1986](https://github.com/StellarEdu/StellarEduPay/issues/1986)
* **k8s:** scope SSE ingress settings to payments events ([b1a0029](https://github.com/StellarEdu/StellarEduPay/commit/b1a002902659510bf4f82e019ae97cba313b1db2)), closes [#2006](https://github.com/StellarEdu/StellarEduPay/issues/2006)
* **k8s:** single Ingress host via Kustomize replacements ([6de9a42](https://github.com/StellarEdu/StellarEduPay/commit/6de9a425e4d054ac8aee9153a347687ee8986dfb)), closes [#2005](https://github.com/StellarEdu/StellarEduPay/issues/2005)
* **lock:** add LockUnavailableError and cluster-safe keys ([851612e](https://github.com/StellarEdu/StellarEduPay/commit/851612e6b975f7ae610a9da4ea50f059b9250368)), closes [#1991](https://github.com/StellarEdu/StellarEduPay/issues/1991)
* **logging:** [#1934](https://github.com/StellarEdu/StellarEduPay/issues/1934) log to stdout only unless LOG_TO_FILE=true ([e12d0e1](https://github.com/StellarEdu/StellarEduPay/commit/e12d0e1c9a12b865b5c1b815dbedd593fb552f6e))
* **login:** close open redirect via backslash and encoded returnTo values ([#1951](https://github.com/StellarEdu/StellarEduPay/issues/1951)) ([69973d9](https://github.com/StellarEdu/StellarEduPay/commit/69973d93ad0f3c1cb243195bf86beed9e1c4e5de))
* make multi-sender memo collision a risk factor +2 more ([99bee0f](https://github.com/StellarEdu/StellarEduPay/commit/99bee0f39e25f6696ae4cb37ea4f07103ac8a110))
* **metrics:** export transaction queue alert threshold gauge ([7bd33b9](https://github.com/StellarEdu/StellarEduPay/commit/7bd33b9355fca2a5e667b457da7451d1d40ab10c)), closes [#2017](https://github.com/StellarEdu/StellarEduPay/issues/2017)
* **mfa:** reject TOTP replay within the validity window ([#1944](https://github.com/StellarEdu/StellarEduPay/issues/1944)) ([5efb559](https://github.com/StellarEdu/StellarEduPay/commit/5efb559acf29829f123895d8d1a3f3963f2df24b))
* **migrations:** add missing version exports and enforce contract ([#1](https://github.com/StellarEdu/StellarEduPay/issues/1)… ([dd687d2](https://github.com/StellarEdu/StellarEduPay/commit/dd687d23228ee0013dbf308eb861d13a6ff0e8a2))
* **migrations:** add missing version exports and enforce contract ([#1731](https://github.com/StellarEdu/StellarEduPay/issues/1731)) ([0776c7b](https://github.com/StellarEdu/StellarEduPay/commit/0776c7b35df1688acaeaeec4661fec26de0d3d10))
* **migrations:** renumber duplicate 036 migration and refuse duplicate numbers ([#2023](https://github.com/StellarEdu/StellarEduPay/issues/2023)) ([ad7157d](https://github.com/StellarEdu/StellarEduPay/commit/ad7157db6a6b5baec5ef1dfddd116f38854a68c6))
* monitoring security, README/env docs, duplicate migration, BIP-39 scanner ([#2019](https://github.com/StellarEdu/StellarEduPay/issues/2019) [#2020](https://github.com/StellarEdu/StellarEduPay/issues/2020) [#2022](https://github.com/StellarEdu/StellarEduPay/issues/2022) [#2023](https://github.com/StellarEdu/StellarEduPay/issues/2023)) ([28a2ae5](https://github.com/StellarEdu/StellarEduPay/commit/28a2ae598ee86b0d54452a0eb33f8e14885c4028))
* **monitoring:** load all alert rule files via glob ([d867292](https://github.com/StellarEdu/StellarEduPay/commit/d8672928c61eca048a3500a57cfd311feb7c7728)), closes [#2016](https://github.com/StellarEdu/StellarEduPay/issues/2016)
* **monitoring:** secure monitoring stack networking and credentials ([#2019](https://github.com/StellarEdu/StellarEduPay/issues/2019)) ([af56605](https://github.com/StellarEdu/StellarEduPay/commit/af56605f9c8fc2f80c474e70570d385ca18bd9c8))
* **outbox:** atomic claim, per-listener delivery, backoff ([#1646](https://github.com/StellarEdu/StellarEduPay/issues/1646)) ([f691c7e](https://github.com/StellarEdu/StellarEduPay/commit/f691c7e6743ec8791a319445a8be98342c0151de))
* **outbox:** atomic claim, per-listener delivery, backoff ([#1646](https://github.com/StellarEdu/StellarEduPay/issues/1646)) ([96b23c0](https://github.com/StellarEdu/StellarEduPay/commit/96b23c03dd73cb9a3f1d712649b9b307a9572b31))
* partial work towards [#1983](https://github.com/StellarEdu/StellarEduPay/issues/1983) ([f2d2aa5](https://github.com/StellarEdu/StellarEduPay/commit/f2d2aa52ee3b814c1e6eb6835eb75e9f2ab4918b))
* partial work towards [#1985](https://github.com/StellarEdu/StellarEduPay/issues/1985) ([a78d489](https://github.com/StellarEdu/StellarEduPay/commit/a78d489bf43916a87ae083d18f515fba1d054bc9))
* partial work towards [#1990](https://github.com/StellarEdu/StellarEduPay/issues/1990) ([eaa03d1](https://github.com/StellarEdu/StellarEduPay/commit/eaa03d12842d129b98345ea274ac1cfd8cce3356))
* partial work towards [#1992](https://github.com/StellarEdu/StellarEduPay/issues/1992) ([e286ee5](https://github.com/StellarEdu/StellarEduPay/commit/e286ee5c104a228dab5965dadb22cb2760604577))
* partial work towards [#1998](https://github.com/StellarEdu/StellarEduPay/issues/1998) ([61d6351](https://github.com/StellarEdu/StellarEduPay/commit/61d6351410891fd09ba1761c8de0b090f5e4590f))
* partial work towards [#2015](https://github.com/StellarEdu/StellarEduPay/issues/2015) ([5428477](https://github.com/StellarEdu/StellarEduPay/commit/54284774b0b7ce8677e77b9c8efeb3c094e1c082))
* **payments:** promote PENDING payments to SUCCESS in finalizer ([de609e0](https://github.com/StellarEdu/StellarEduPay/commit/de609e0d645bc9289c353f8ca8c993407fa61a16)), closes [#1754](https://github.com/StellarEdu/StellarEduPay/issues/1754)
* **payments:** resolve memos against intents in any status ([5f86c81](https://github.com/StellarEdu/StellarEduPay/commit/5f86c81047efa05e3d2033493177b49b12047d02)), closes [#1977](https://github.com/StellarEdu/StellarEduPay/issues/1977)
* **payments:** retry intent memo allocation instead of 409 ([e0fdbf5](https://github.com/StellarEdu/StellarEduPay/commit/e0fdbf56ac58e88d221e3fc85e04676f844fcdae)), closes [#1978](https://github.com/StellarEdu/StellarEduPay/issues/1978)
* **privacy:** bypass tenant scope in PII anonymization job ([d27b86a](https://github.com/StellarEdu/StellarEduPay/commit/d27b86a1ab259a9dc509cb4bda187fe55b3b3d81)), closes [#2003](https://github.com/StellarEdu/StellarEduPay/issues/2003)
* **queue:** release slots for long-lived streams ([0b60fbf](https://github.com/StellarEdu/StellarEduPay/commit/0b60fbfbf9daebdd52242d422acaaf27bd3aa45a)), closes [#2010](https://github.com/StellarEdu/StellarEduPay/issues/2010)
* **rate-limit:** consistent headers, reset values and 429 body across limiters ([56c108e](https://github.com/StellarEdu/StellarEduPay/commit/56c108edea696bf73d451aea85dc443afce13eaa))
* **rate-limit:** consistent RateLimit-* headers, reset values and 429 body across limiters ([1d2cbc6](https://github.com/StellarEdu/StellarEduPay/commit/1d2cbc62fb6d5bdaeab347789b9d81930834028d)), closes [#1642](https://github.com/StellarEdu/StellarEduPay/issues/1642)
* **reconciliation:** bypass tenant scope for stuck payments ([856e4be](https://github.com/StellarEdu/StellarEduPay/commit/856e4be2cf187631227af9f1a904b11c287bf803)), closes [#2002](https://github.com/StellarEdu/StellarEduPay/issues/2002)
* refund system — partial refunds, atomic txns, two-person approva… ([aed5419](https://github.com/StellarEdu/StellarEduPay/commit/aed5419e7f27ac59ca7e473a79baf74a1b31ae1f))
* **reminders:** [#1788](https://github.com/StellarEdu/StellarEduPay/issues/1788) run reminders for any email provider and SMS-only parents ([979669b](https://github.com/StellarEdu/StellarEduPay/commit/979669b109eee1dec9c74f926ec8ef71c68f7927))
* **reminders:** claim reminder slot via status state machine ([d330f53](https://github.com/StellarEdu/StellarEduPay/commit/d330f53f2610603ee006736487a360b6ef0d6414)), closes [#1997](https://github.com/StellarEdu/StellarEduPay/issues/1997)
* **reminders:** run scheduler hourly instead of daily ([abf657f](https://github.com/StellarEdu/StellarEduPay/commit/abf657ff6466e56b92f8f683e4c3b72fbc98949b)), closes [#1996](https://github.com/StellarEdu/StellarEduPay/issues/1996)
* resolve memos against intents in any status +3 more ([43254c8](https://github.com/StellarEdu/StellarEduPay/commit/43254c81d55cd7c5c57d98e3780e8c1baa8ad113))
* **routes:** [#1935](https://github.com/StellarEdu/StellarEduPay/issues/1935) remove unmounted students.js router and guard routes/ ([6278de9](https://github.com/StellarEdu/StellarEduPay/commit/6278de99b923accd148ce3a8f1821322ff042476))
* **schools:** allow-list public fields on GET /api/schools/:schoolId ([a1aeb65](https://github.com/StellarEdu/StellarEduPay/commit/a1aeb65240dc9042b669217acf1c8bb104d015f6)), closes [#1783](https://github.com/StellarEdu/StellarEduPay/issues/1783)
* **schools:** paginate school listing and use requireAdminAuth for includeInactive ([045ffde](https://github.com/StellarEdu/StellarEduPay/commit/045ffde8784143e728a0c0e57d55a365ad57c458))
* **schools:** paginate/search school listing and use requireAdminAuth for includeInactive ([c9288fd](https://github.com/StellarEdu/StellarEduPay/commit/c9288fdbe7080d352b15c7b9aff8cbb68dea0afe)), closes [#1643](https://github.com/StellarEdu/StellarEduPay/issues/1643)
* **security:** detect BIP-39 mnemonics by checksum, not wordlist words ([#2022](https://github.com/StellarEdu/StellarEduPay/issues/2022)) ([87ba9d9](https://github.com/StellarEdu/StellarEduPay/commit/87ba9d9c362a9d3b470c03689a42659007c11c71))
* serialise Horizon stream message processing +3 more ([4e429fc](https://github.com/StellarEdu/StellarEduPay/commit/4e429fca0be74850ac40bac47a3e9bc15620544b))
* **session-cleanup:** bypass tenant scope and batch expired intents ([36b5ba8](https://github.com/StellarEdu/StellarEduPay/commit/36b5ba8cf6a98932634456161324d5d0876f646a)), closes [#2001](https://github.com/StellarEdu/StellarEduPay/issues/2001)
* **shutdown:** stop outbox dispatcher, report worker, cache invalidator and heap monitor ([1336cd1](https://github.com/StellarEdu/StellarEduPay/commit/1336cd14cd1a67026e9c85fda36b3808e8d3afe9))
* **shutdown:** stop outbox dispatcher, report worker, cache invalidator and heap monitor on shutdown ([0d8cd23](https://github.com/StellarEdu/StellarEduPay/commit/0d8cd23ac91c8b3f7d459056071a5bec7925e4b4)), closes [#1645](https://github.com/StellarEdu/StellarEduPay/issues/1645)
* **stellar:** make multi-sender memo collision a risk factor ([7404aaf](https://github.com/StellarEdu/StellarEduPay/commit/7404aafe9c0da081490f01926910cc04a54b943f)), closes [#1980](https://github.com/StellarEdu/StellarEduPay/issues/1980)
* **stellar:** stop cross-school memo collision flagging ([7e1c2fd](https://github.com/StellarEdu/StellarEduPay/commit/7e1c2fd8c5c7d4d3fc12e5e3e658b682f5067ecc)), closes [#1979](https://github.com/StellarEdu/StellarEduPay/issues/1979)
* **streaming:** track Horizon cursors per wallet address ([862add1](https://github.com/StellarEdu/StellarEduPay/commit/862add1e7118a37695d51ade6e0270727aa267a1)), closes [#1987](https://github.com/StellarEdu/StellarEduPay/issues/1987)
* **stream:** serialise Horizon stream message processing ([83196f7](https://github.com/StellarEdu/StellarEduPay/commit/83196f75aec6ab3451e4789a15f750d2e0087331)), closes [#1988](https://github.com/StellarEdu/StellarEduPay/issues/1988)
* **students:** cap JSON bulk import rows and fix row numbers ([11300a8](https://github.com/StellarEdu/StellarEduPay/commit/11300a8a350c10c7e9e1cf1179d03b96cd14774b)), closes [#1995](https://github.com/StellarEdu/StellarEduPay/issues/1995)
* **students:** drop comment line from import template ([d2f508a](https://github.com/StellarEdu/StellarEduPay/commit/d2f508ad4b16695749b263f1300a05bcb98e7d79)), closes [#1994](https://github.com/StellarEdu/StellarEduPay/issues/1994)
* **students:** recompute balance and fee history on fee change ([ad33c66](https://github.com/StellarEdu/StellarEduPay/commit/ad33c669a0d629e91a5c1f7fd314357c77c15a3d)), closes [#1786](https://github.com/StellarEdu/StellarEduPay/issues/1786)
* tini PID 1, probe separation, K8s env, restricted PSS ([439cb22](https://github.com/StellarEdu/StellarEduPay/commit/439cb22f7c2299cbf32e07d6efa2d8cbc5e4f25b))
* track Horizon cursors per wallet address +2 more ([d3315a0](https://github.com/StellarEdu/StellarEduPay/commit/d3315a0c268a10737b65a95ade3db8aedd9583e3))
* unblock backend boot and restore auth session store contract ([0f64561](https://github.com/StellarEdu/StellarEduPay/commit/0f64561da8933dbc62077171756bafb072666452))


### Changed

* **health:** share Horizon poll budget with health probes ([10bc022](https://github.com/StellarEdu/StellarEduPay/commit/10bc022033986b0b7c406d3b372d70cd56771717)), closes [#2014](https://github.com/StellarEdu/StellarEduPay/issues/2014)
* **pay:** poll instead of SSE on the public pay page and add offline shell ([#1831](https://github.com/StellarEdu/StellarEduPay/issues/1831)) ([65fadfa](https://github.com/StellarEdu/StellarEduPay/commit/65fadfabba047be98ecc15b748c2ff05ddebf6d3))
* **students:** add tenant-first query indexes ([4425653](https://github.com/StellarEdu/StellarEduPay/commit/44256537c368d4a40417f7caa30ab46e2c79256c))
* **students:** add tenant-first query indexes ([991d325](https://github.com/StellarEdu/StellarEduPay/commit/991d325acd6d60e1db9ddd5d7c66cd17df74ac3b))

## [Unreleased]

### Added

- **Release process (#1634)**: semantic-versioned releases via release-please (`.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`) driven by conventional commits; the previous `[Unreleased]` history is now `v1.0.0`. New `GET /api/version` (`{ service, version, commit, buildTime, node }`), `version`/`commit` on `GET /health/live`, and a `build_info{version,commit,node_version}` metric. Release images are pushed to GHCR tagged with the version and `sha-<commit>`. See [docs/releasing.md](docs/releasing.md).
- **Coverage ratchet (#1635)**: `scripts/coverage-ratchet.js` + `coverage-baseline.json` fail CI when global coverage or the coverage of a changed file decreases, and post a coverage table as a PR comment. `npm run coverage:ratchet -- --update` raises the baseline and syncs the Jest floors. New `tests/routerInventory.test.js` fails on unmounted, unloadable or empty routers.
- **Distributed tracing (#1636)**: optional OpenTelemetry tracing (`OTEL_TRACING_ENABLED`, off by default) with auto-instrumentation for HTTP/Express, MongoDB/Mongoose, ioredis and axios; trace context carried through BullMQ jobs and outbox events; spans for Horizon calls (endpoint, attempt, failover) and `withStellarRetry`; `trace_id`/`span_id` on every log line and `correlation.id` on spans. Jaeger added to `docker-compose.monitoring.yml`. See [docs/tracing.md](docs/tracing.md).
- **Parent self-service portal (#1637)**: `/parent` page and `/api/parent/*` API behind signed, expiring, revocable per-family magic links (`ParentAccessToken` model). Parents see balances, payment plans and payment history, download receipts, raise disputes and toggle reminders for their own children only; staff issue (`POST /api/parent/links`), list and revoke links. Optional portal links in reminder emails (`PARENT_PORTAL_EMAIL_LINKS`). See [docs/parent-portal.md](docs/parent-portal.md).

### Fixed

- **Path-payment crediting wired in (#1747 / #1557)**: `extractValidPayment`, `verifyTransaction`, and the destination-check branch in `syncPaymentsForSchool` in `stellarService.js` now recognise `path_payment_strict_send` and `path_payment_strict_receive` in addition to plain `payment` operations. Previously only `op.type === "payment"` was accepted, so Stellar path payments that delivered XLM or USDC to the school wallet were silently dropped instead of being credited. For both path-payment types Horizon surfaces the destination wallet and received asset/amount on the same `to`, `asset_*`, and `amount` fields as a regular payment, so `detectAsset` and fee validation work without further changes. A `CREDITABLE_OP_TYPES` `Set` replaces the three separate hard-coded `op.type === "payment"` checks.

- **Report cache invalidation wired in (#1747)**: `services/reportCacheInvalidator.js` created and subscribed to the `payment.saved` event via `paymentSavedSubscribers.js`. Calls `cache.delByPrefix('report:<schoolId>:')` so school-scoped report cache entries are dropped immediately when a new payment lands rather than waiting for the 5-minute TTL.

- **Truncated source files**: `backend/src/middleware/rateLimiter.js` had lost `publicStudentLimiter` and its entire `module.exports`, and `backend/src/routes/paymentRoutes.js` had lost its lock/unlock, status, refund, receipt-verification and reconciliation routes plus `module.exports`; both are restored. `backend/src/routes/disputeRoutes.js` used `requireSchoolAuth` without importing it.

### Removed

- **Dead phantom service code noted (#1747)**: Audit confirmed the following modules were **never written to disk** (they were described in the issue but only existed as aspirational references in docs and a draft CHANGELOG entry). No files were deleted; no tests were broken:
  - `services/stellarRateLimitedClient.js` — rate-limit token bucket; replaced entirely by `horizonPollBudget.js` (cross-school coordinated budget) and `horizonFailoverClient.js` (per-endpoint circuit breaker).
  - `services/stellarTransactionManager.js` — outgoing transaction building; the backend is read-only and never submits transactions, so this was never appropriate.
  - `services/underpaidReconciliationService.js` — partial payments are accepted as `SUCCESS` on-chain; the `underpaidReconciliation` sub-document is populated by the refund service only when a refund is processed. See `docs/payment-plans-underpaid-reconciliation.md`.
  - `services/reminderScheduler.js` — `reminderService.js` already exports `startReminderScheduler`/`stopReminderScheduler`, which `app.js` calls directly.
  - `utils/responseHelper.js` — controllers use `res.json()` directly; a wrapper was never needed.

<!-- release-please appends new entries above this line on every release (#1634). -->

## [1.0.0] - 2026-10-17

First tagged release (#1634). Everything below was previously held under `[Unreleased]`; it is now the content of `v1.0.0`.

### Security

- **Per-endpoint webhook secrets encrypted at rest (#1538)**: `WebhookEndpoint.secret` is now encrypted with `webhookSecretEncryption` (AES-256-GCM, `WEBHOOK_SECRET_ENCRYPTION_KEY`) via the same `pre('save')`/`post('init')` pattern as `School.webhookSecret`, and is `select: false` so list queries never load it. Caller-supplied secrets must be ≥ 32 characters with enough estimated entropy (`400 WEAK_WEBHOOK_SECRET` otherwise); omitted secrets are generated server-side. New `POST /api/webhook-endpoints/:id/rotate-secret` returns a new server-generated secret once and dual-signs deliveries (`X-StellarEduPay-Signature-V2-Previous`) for a configurable overlap (`WEBHOOK_SECRET_ROTATION_OVERLAP_S`, default 24h). `scripts/rotate-webhook-encryption-key.js` now re-encrypts endpoint secrets too. Webhook retries now resolve the signing secret at send time instead of relying on a field that is never persisted.
  - **`030_encrypt_webhook_endpoint_secrets`** — encrypts existing `webhookendpoints.secret` / `previousSecret` values. **Prerequisite**: `WEBHOOK_SECRET_ENCRYPTION_KEY` set, otherwise a logged no-op. Idempotent (`enc:` values skipped); `down()` decrypts back to plaintext.
- **Email bounce/complaint webhook no longer fails open (#1537)**: `POST /api/email/webhooks/:provider` now verifies Amazon SNS signatures (cert host pinned to `sns.<region>.amazonaws.com`, `TopicArn` allow-listed via `EMAIL_SNS_TOPIC_ARNS`) and auto-confirms `SubscriptionConfirmation` messages after verification; verifies SendGrid Signed Event Webhook signatures (`EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY`); accepts `EMAIL_WEBHOOK_SECRET` only via the `X-Webhook-Token` header with a constant-time comparison and rejects `?token=`. In production, unauthenticated calls are always rejected and the route returns `503` when no authentication is configured. Rejections are logged and counted in `email_webhook_rejections_total{provider, reason}`. Secret-bearing query parameters are redacted from access logs.
- **Public `/health` no longer discloses internal topology (#1540)**: `GET /health` returns only `{ status }` (200/503). The detailed report moved to `GET /api/admin/health/details` (admin auth), and raw dependency error messages are replaced with stable reason codes everywhere (including `/health/ready`, which no longer lists Horizon endpoints). The Ingress continues to route only `/api` to the backend, so `/health*` is not externally reachable.

### Deprecated

- **Webhook V1 signature sunset plan (#1539)** — see [Migration guide: V1 → V2](docs/WEBHOOK_INTEGRATION.md#migration-guide-v1--v2). Endpoints now have a `signatureVersions` setting: new endpoints receive V2 only, existing endpoints were migrated to `["v1", "v2"]` and can opt out with `PUT /api/webhook-endpoints/:id { "signatureVersions": ["v2"] }`. V1 is never emitted after `WEBHOOK_V1_SUNSET` (default `2027-02-28`). Operators list endpoints still on V1 with `GET /api/admin/webhooks/v1-endpoints` and send the advance-notice emails with `POST /api/admin/webhooks/v1-endpoints/notify`; `webhook_deliveries_total` gained a `signature_version` label. V1 is now computed over the transmitted raw body.
  - **`031_backfill_webhook_signature_versions`** — sets `signatureVersions: ["v1", "v2"]` on existing endpoints and adds a `{ signatureVersions, isActive }` index. Idempotent; `down()` removes the field from endpoints that never changed it.

### Added

- **Migrations 019–025 documentation (#1388)**: CHANGELOG and `docs/migrations.md` previously had no record of what migrations `019` through `025` do. Documented here so operators upgrading can tell what will run before they run `npm run migrate`:
  - **`019_add_reminder_time_window`** — Backfills `schools.settings.reminderTimeWindow` to `{ startHour: 8, endHour: 18 }` for any school missing it. Data-only, no index changes. Safe during a rolling deploy; idempotent (`$exists: false` filter). No prerequisites.
  - **`020_tenant_isolate_source_validation_rules`** — Fixes a tenant-isolation bug (#904): `sourcevalidationrules` had a global-unique index on `name`, so a rule created by one school collided with (and was visible to) another. Drops the old global `name_1` unique index, creates a compound unique index on `{ schoolId, name }` plus a lookup index on `{ schoolId }`, and backfills any rule missing `schoolId` to `DEFAULT_SCHOOL_ID` (falls back to `"SCH-DEFAULT"`). **Operator action required**: after running, review any rules backfilled to the default school — they were previously global and are now silently owned by one tenant. Index creation is foreground (not `background: true`); on a large `sourcevalidationrules` collection this can briefly hold a write lock — plan for a maintenance window on large deployments.
  - **`021_encrypt_webhook_secrets`** — Encrypts existing plaintext `School.webhookSecret` values at rest with AES-256-GCM, and strips the plaintext `secret` field from any `WebhookRetry` documents that still carry it (#75). **Prerequisite**: set `WEBHOOK_SECRET_ENCRYPTION_KEY` (64-char hex) before running, or the migration no-ops (logs a skip) and secrets stay plaintext. Idempotent — values already prefixed `enc:` are skipped. Safe during a rolling deploy once the key is set.
  - **`022_create_reminder_logs`** — Creates the `reminderlogs` collection with a unique compound index on `{ schoolId, studentId, windowStart }` (cross-replica reminder idempotency) and a TTL index on `createdAt` (default 90-day retention, override with `REMINDER_LOG_TTL_SECONDS`). New collection — safe during a rolling deploy, no lock contention on existing data.
  - **`023_add_dispute_fields`** — Adds evidence/SLA/escalation tracking fields (`evidence`, `txReference`, `slaDeadline`, `slaBreachedAt`, `escalationLevel`, `escalatedAt`, `lastActivityAt`, `assignedTo`) to existing `disputes` documents, computing `slaDeadline` from each dispute's `createdAt` plus `DISPUTE_SLA_HOURS` (default 72h). Creates two non-unique indexes (`{ slaDeadline, status }`, `{ escalationLevel, status }`) for SLA/escalation queries. Safe during a rolling deploy; the `updateMany` backfill can take noticeable time on a large `disputes` collection since it uses an aggregation-pipeline update.
  - **`024_add_underpaid_reconciliation_field`** — Backfills an `underpaidReconciliation` sub-document (`status`, `appliedCredit`, `creditAppliedAt`, `creditAppliedBy`, `refundTxHash`, `refundInitiatedAt`, `refundCompletedAt`, `refundNote`) onto every existing `payments` document that lacks one. Data-only, no index changes. Safe during a rolling deploy; idempotent.
  - **`025_scope_payment_intent_memo_index`** — Fixes #1202: `paymentIntents.memo` had a global unique index, so two different schools producing the same memo hit a raw duplicate-key error. Drops the global unique `memo` index (if present) and creates a compound unique index on `{ schoolId, memo }` with `background: true`. Safe during a rolling deploy — the index build is backgrounded and does not hold a write lock, though it can take time to complete on a large `paymentintents` collection, during which duplicate-memo protection is temporarily index-less for that window.

  All seven migrations are already wired into `npm run migrate` (see `docs/migrations.md`); no code changes accompany this entry, only documentation.

### Fixed

- **tenantScope plugin threw TenantScopeError on every findById / findByIdAndUpdate (#1743)**: The `tenantScope` Mongoose plugin enforces `schoolId` on all queries against tenant-scoped models. Mongoose implements `Model.findById(id)` as `findOne({ _id: id })` and `findByIdAndUpdate(id, ...)` as `findOneAndUpdate({ _id: id }, ...)`, neither of which carries `schoolId`, so every `findById*` call on a tenant-scoped model (Payment, Student, Refund, Dispute, PaymentIntent, Receipt, EmailDelivery, PendingVerification, PaymentPlan, FeeAdjustmentRule, AuditLog, ReminderLog, FeeStructure, ReconciliationReport, StudentFeeHistory) threw `TenantScopeError` at runtime — breaking refund approval, intent-based submit, manual sync with intents, payment finalisation, reminder tracking, email delivery updates, receipt verification, and underpaid reconciliation. All 17 affected call sites across 10 source files replaced with `findOne({ _id, schoolId })` / `findOneAndUpdate({ _id, schoolId }, ...)`, threading `schoolId` through the refund service APIs (`approveRefund`, `rejectRefund`, `completeRefund` now accept `schoolId`). An ESLint `no-restricted-syntax` rule forbids `findById*` on all 15 tenant-scoped model variable names. A new test loads each tenant-scoped model against `mongodb-memory-server` and asserts `findById` throws `TENANT_SCOPE_MISSING` while `findOne({ _id, schoolId })` succeeds, including cross-tenant isolation.
- **TransactionManager retry semantics and replica-set baseline (#transactions)**: `withTransaction()` previously opened ONE session, called `session.startTransaction()` on it, and then ran its retry loop *inside* that session — every retry re-executed the operation against a transaction the server had already aborted, so retries could not succeed by construction and merely burned the backoff budget before surfacing `MAX_RETRIES_EXCEEDED`. `withTransaction()` now opens a fresh session per attempt and delegates per-attempt lifecycle semantics (start/commit/abort, `TransientTransactionError` callback retry, `UnknownTransactionCommitResult` commit retry) to the driver's `session.withTransaction()`, re-throwing the ORIGINAL error so driver labels survive for upstream callers. `isRetryableError()` was reduced to the driver error contract — `TransientTransactionError`/`UnknownTransactionCommitResult` labels plus numeric codes 112 (WriteConflict), 189 (PrimarySteppedDown), 261 (TooManyLogicalSessions) — deleting the message substring sweep that treated any error whose text contained 'Lock' or 'transaction' as transient and replayed it up to three times. Every bundled environment now runs MongoDB as an initiated single-node replica set ("rs0"), which multi-document transactions require: docker-compose.yml generates an intra-cluster keyfile at boot, runs mongod with `--replSet rs0`, and initiates via its healthcheck (verified live: transaction commits); both CI Mongo services do the same via their healthcheck; deploy/k8s/mongodb-statefulset.yaml was found to be STANDALONE (and localhost-bound) and now runs `--replSet rs0 --bind_ip_all` with a postStart `rs.initiate()` hook and a primary-only readiness probe. The requirement is documented in the module header and docs/architecture.md. Removed two orphaned test files (`tests/concurrentAllocation.test.js`, `tests/concurrent-payment-processor-queue.test.js`) that still imported `concurrentPaymentProcessor`, which was deleted in #1036 — they failed at require time and broke `npm test`.
- **Investigated duplicate sync bug (#731)**: Audited `syncAllPayments` in `paymentController.js` for the reported double `syncPaymentsForSchool` call and `ERR_HTTP_HEADERS_SENT` crash. Confirmed the code already calls `syncPaymentsForSchool` exactly once, sends a single response, and correctly passes `summary` to the audit log. No code change required.
- **Documented transaction-queue durability and fixed drainWorker orphan (#1053)**: Audited `backend/src/queue/` to verify that the primary transaction-submission queue (`transactionQueue.js`) is durable — every job is upserted to `PendingVerification` (MongoDB) before being handed to BullMQ, and `recoverPendingJobs()` re-enqueues any `pending`/`processing` documents on every restart. `docs/architecture.md` previously described the queue as "event-driven (BullMQ)" with no mention of the MongoDB outbox and startup recovery, which read as if Redis were the sole durability layer. It now distinguishes the three queues (transaction processing, transaction retry + DLQ, report generation) and documents the two-tier MongoDB + Redis durability model for each, the degraded MongoDB-only mode (when Redis is unreachable), the difference between the two queues' stalled-job recovery mechanisms, and the graceful-shutdown drain contract. The `transactionQueue.drainWorker()` was misusing `markDead()` for jobs interrupted by the drain timeout — those jobs were orphaned in `dead_letter` (which `recoverPendingJobs()` does NOT scan). Added `markInterrupted(txHash, reason)` which writes `status: 'pending'` with a `lastError` note so the next startup recovery sweep re-queues them. `tests/transactionQueueDurability.test.js` now contains a `restart-mid-queue — no transaction is silently dropped (#1053)` describe block (in-flight job whose Redis state was lost across a restart; doc stuck in `processing` from a dead worker; second-restart idempotency; end-to-end enqueue → crash → recover; drain-timeout markInterrupted sets `pending` not `dead_letter`) and a `graceful-shutdown interruption path (#1053)` describe block (markInterrupted writes `pending` and that doc is recoverable on the next boot).

### Added

- **Student Quota Enforcement (#680)**: Schools can now enforce per-school student registration limits via the `maxStudents` field. Quota is checked on both single student registration and bulk imports. Returns `403 STUDENT_QUOTA_EXCEEDED` when limit is reached.
- **Asset Validation in Payment Instructions (#682)**: `GET /api/payments/instructions/:studentId` now validates the optional `?asset=` query parameter against the school's accepted assets. Returns `400 ASSET_NOT_ACCEPTED` with a list of supported assets if the requested asset is not accepted.
- **Comprehensive Fee Adjustment Engine Tests (#681)**: Added extensive test coverage for `feeAdjustmentEngine` rule interactions, including sequential application of multiple rules, clamping of negative fees, and deterministic behavior verification.

### Changed

- **School Model**: Added `maxStudents` field (Number, default: 10000) to enforce student registration quotas per school.
- **Student Registration**: `POST /api/students` now checks school quota before creating a student.
- **Bulk Student Import**: `POST /api/students/bulk` now enforces quota with partial result support—rows exceeding the quota are marked as failed with `STUDENT_QUOTA_EXCEEDED` code.

### Fixed

- **Payment Instructions Clarity**: Parents requesting payment instructions for unsupported assets now receive a clear error message with a list of accepted assets, preventing confusion when payments are rejected.

### Documentation

- Added `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com) format.
- Updated `README.md` to link to `CHANGELOG.md`.

---

### Initial Release

- Decentralized school fee payment system built on Stellar blockchain
- Multi-school support with isolated wallets and records
- Automatic payment reconciliation via transaction memos
- Support for XLM and USDC payments
- Fee validation (exact, overpaid, underpaid detection)
- Payment history and audit trails
- Background polling for blockchain sync
- Retry mechanism for failed verifications
- RESTful API with comprehensive endpoints
- Next.js frontend for payment submission and dashboard
- MongoDB for persistent storage
- Docker Compose for containerized deployment
- Comprehensive test coverage with Jest

---

## Known Issues

- Rate limit persistence requires Redis configuration; without it, counters reset on server restart
- MongoDB replica set required for multi-document transactions (not supported on standalone instances)
- Stellar Horizon API rate limits constrain sync throughput during high-volume periods. This is now bounded and documented rather than open-ended: polling draws from a coordinated cross-school request budget spent in priority order, with measured maximum sync-delay figures and configuration guidance in [docs/horizon-rate-limits.md](docs/horizon-rate-limits.md). Operators running more than one replica must set `HORIZON_POLL_REPLICA_COUNT`, and should re-validate the published figures against their own Horizon instance before quoting them contractually.

---

## Migration Guide

### Upgrading to 1.0.0

#### Breaking Changes

None in this release.

#### Non-Breaking Changes

1. **Student Quota**: If you have schools with more than 10,000 students, update the `maxStudents` field in the School document to reflect your actual limit.
2. **Asset Validation**: Clients calling `GET /api/payments/instructions/:studentId?asset=USDC` will now receive a `400` error if USDC is not in the school's accepted assets. Update client code to handle this error gracefully.

#### Migration Steps

1. Update backend to latest version
2. Run database migrations (if any)
3. Restart backend services
4. Update frontend to handle new error codes: `STUDENT_QUOTA_EXCEEDED`, `ASSET_NOT_ACCEPTED`

---

## Contributing

Entries are generated from commit messages by [release-please](https://github.com/googleapis/release-please) (#1634), so PR titles / squash-merge commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: …` → **Added** (minor bump)
- `fix: …` → **Fixed** (patch bump)
- `feat!: …` or a `BREAKING CHANGE:` footer → **Breaking** (major bump)
- `docs:`, `chore:`, `test:`, `ci:`, `refactor:` → no release on their own

Hand-written detail (migrations, operator actions) may still be added to the release PR that release-please opens before it is merged.

---

## Release Process

See [docs/releasing.md](docs/releasing.md).

1. Merge PRs to `main` with conventional-commit titles.
2. release-please keeps a **release PR** open that bumps the version in every `package.json` and moves the pending notes into a new section of this file.
3. Merging the release PR tags `vX.Y.Z`, publishes a GitHub release with the generated notes, and the release workflow pushes Docker images tagged with the version as well as the commit SHA.

---

For more information, see [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
