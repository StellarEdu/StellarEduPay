# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/StellarEdu/StellarEduPay/compare/v1.0.0...v1.1.0) (2026-10-22)


### Added

* **#1569:** add AcademicPeriod model, StudentPeriodFee, rollover service and routes ([9b170de](https://github.com/StellarEdu/StellarEduPay/commit/9b170de71e4a27540db9d7e5d3d831742bb379c0))
* **#1570:** replace interval polling with Horizon SSE streaming ([c92d0e2](https://github.com/StellarEdu/StellarEduPay/commit/c92d0e21b0ca75bf7e5a84531e20f4b03aba7ac3))
* **#1571,#1572:** SEP-24 anchor service, fix timezone-aware report date ranges ([a068665](https://github.com/StellarEdu/StellarEduPay/commit/a068665514b2279c9d3ee8dde4ddd63316c50886))
* add frontend i18n support with English and French translation f… ([818622c](https://github.com/StellarEdu/StellarEduPay/commit/818622cb555884d56af2a115031344b4ad25c278))
* add frontend i18n support with English and French translation files ([f9a0a14](https://github.com/StellarEdu/StellarEduPay/commit/f9a0a14e175aed0137dda37b099d83ab476b88cd))
* add maximum export row limit for student CSV export ([03691bc](https://github.com/StellarEdu/StellarEduPay/commit/03691bc0303d26649011f798b671dbebafff0ff3)), closes [#1410](https://github.com/StellarEdu/StellarEduPay/issues/1410)
* add pagination to fee structures list with isActive filter ([80a2128](https://github.com/StellarEdu/StellarEduPay/commit/80a2128217f14fc9bb7455d61483eae15df7af37)), closes [#1408](https://github.com/StellarEdu/StellarEduPay/issues/1408)
* add per-school payment volume analytics dashboard ([e53ca04](https://github.com/StellarEdu/StellarEduPay/commit/e53ca0434baa9db6018b2a8d33489e2d6733fe40)), closes [#1411](https://github.com/StellarEdu/StellarEduPay/issues/1411)
* add structured logging for transaction polling cycle ([c9dde88](https://github.com/StellarEdu/StellarEduPay/commit/c9dde882482917e8e0b259143f7f2981c9d48856)), closes [#1409](https://github.com/StellarEdu/StellarEduPay/issues/1409)
* **admin:** operations overview endpoint for payment detection health ([9d51a8b](https://github.com/StellarEdu/StellarEduPay/commit/9d51a8bd2a6ce7d042a1b0d4426a37d04b1305dc)), closes [#1817](https://github.com/StellarEdu/StellarEduPay/issues/1817)
* **auth:** add user management, password reset flow, and school selector ([9a92779](https://github.com/StellarEdu/StellarEduPay/commit/9a92779a0ebe5a13c3024039704d31e770320e41))
* **auth:** add user management, password reset flow, and school selector ([a4b9c82](https://github.com/StellarEdu/StellarEduPay/commit/a4b9c82f4a1403d5246c93bc584d962ce549ac13))
* complete dark mode support for frontend ([#1371](https://github.com/StellarEdu/StellarEduPay/issues/1371)) ([4be0dac](https://github.com/StellarEdu/StellarEduPay/commit/4be0dacaa5cb377a432403c76995a72e1e3e4a02))
* complete dark mode support for frontend ([#1371](https://github.com/StellarEdu/StellarEduPay/issues/1371)) ([c5b3531](https://github.com/StellarEdu/StellarEduPay/commit/c5b3531237c3648c942c0b4af383b376524d516d))
* consolidate webhooks and email provider callbacks, add dispute notifications ([6a3df60](https://github.com/StellarEdu/StellarEduPay/commit/6a3df60b6d7deeed5384333702da661fc3082afa)), closes [#1638](https://github.com/StellarEdu/StellarEduPay/issues/1638) [#1639](https://github.com/StellarEdu/StellarEduPay/issues/1639) [#1640](https://github.com/StellarEdu/StellarEduPay/issues/1640) [#1641](https://github.com/StellarEdu/StellarEduPay/issues/1641)
* docker-compose CI smoke test, weekly backup restore test, 401/403 shape check, webhookSecret step-up auth ([5469975](https://github.com/StellarEdu/StellarEduPay/commit/54699757e16d8719b8fac4c82062bfdef5dbe0cc)), closes [#1418](https://github.com/StellarEdu/StellarEduPay/issues/1418) [#1413](https://github.com/StellarEdu/StellarEduPay/issues/1413) [#1417](https://github.com/StellarEdu/StellarEduPay/issues/1417) [#1412](https://github.com/StellarEdu/StellarEduPay/issues/1412)
* emit leader election prometheus metrics and split-brain alert ([0f1d566](https://github.com/StellarEdu/StellarEduPay/commit/0f1d5668b284dae8695954a2049daaddacc223a4))
* enforce REQUIRE_MFA, document confirmation state machine, add dispute total count ([4dcf4c2](https://github.com/StellarEdu/StellarEduPay/commit/4dcf4c23533983634ddeb41f6a889420e27d7303)), closes [#1359](https://github.com/StellarEdu/StellarEduPay/issues/1359) [#1358](https://github.com/StellarEdu/StellarEduPay/issues/1358) [#1357](https://github.com/StellarEdu/StellarEduPay/issues/1357) [#1356](https://github.com/StellarEdu/StellarEduPay/issues/1356)
* fee-adjustment delete confirmation, source-rule UI, dispute balance sync, backend HPA ([adf0b60](https://github.com/StellarEdu/StellarEduPay/commit/adf0b6005a73642c0ec73b776a74c4b9d5341f9b)), closes [#1355](https://github.com/StellarEdu/StellarEduPay/issues/1355) [#1354](https://github.com/StellarEdu/StellarEduPay/issues/1354) [#1353](https://github.com/StellarEdu/StellarEduPay/issues/1353) [#1352](https://github.com/StellarEdu/StellarEduPay/issues/1352)
* fix([#1364](https://github.com/StellarEdu/StellarEduPay/issues/1364)): enhance scan-repo-secrets.js to detect hex secrets, mnemo… ([2037813](https://github.com/StellarEdu/StellarEduPay/commit/20378137d10ecfb9c4d1da416a2573551c4a626a))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Payments admin screen with suspicious-payment review ([3a2fb48](https://github.com/StellarEdu/StellarEduPay/commit/3a2fb485e46fcd2820d477c0a0a7a8a0ec45267f))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Reminders admin screen ([8a47246](https://github.com/StellarEdu/StellarEduPay/commit/8a472466a1d51ac6c048366d5b57bc2d3fbe537f))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) role-based permissions and API client for admin screens ([6af4ace](https://github.com/StellarEdu/StellarEduPay/commit/6af4ace28f9cc6d1991c092e7d79ff4c9c333e29))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) role-gate refund approval, fix refunds badge, document admin UI ([a4684a3](https://github.com/StellarEdu/StellarEduPay/commit/a4684a30ee77b2425df5bf80e7a22684d2937496))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Security admin screen (sessions and MFA) ([3098b57](https://github.com/StellarEdu/StellarEduPay/commit/3098b575897f9f8ca4a2c3c512f91318e4350374))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Settings & users admin screen ([fd7079f](https://github.com/StellarEdu/StellarEduPay/commit/fd7079f4c180cc89a330e0f80f0f92489371866d))
* **frontend:** [#1581](https://github.com/StellarEdu/StellarEduPay/issues/1581) Students admin screen ([0062de7](https://github.com/StellarEdu/StellarEduPay/commit/0062de710577ba48e3ed5b774757f01daa85cf3e))
* **i18n:** report and enforce translation coverage in CI ([3bf358a](https://github.com/StellarEdu/StellarEduPay/commit/3bf358ac6756decd153e60096d3ea22d7f84411e)), closes [#1793](https://github.com/StellarEdu/StellarEduPay/issues/1793)
* impemented_logger_Writes_Rotating_files ([ed10e7c](https://github.com/StellarEdu/StellarEduPay/commit/ed10e7c8067349582981f4a9b48093bf499d0804))
* **metrics:** expire daily rollups, keep monthly ones ([ad9ee72](https://github.com/StellarEdu/StellarEduPay/commit/ad9ee72298d6b93c1c0bf87ba9082d67a6322940))
* **metrics:** expire daily rollups, keep monthly ones ([#1373](https://github.com/StellarEdu/StellarEduPay/issues/1373)) ([d647dca](https://github.com/StellarEdu/StellarEduPay/commit/d647dca50b9ad3cb53d23f92ecc1b25217d4d0b7))
* **metrics:** expose dispute SLA and resolution-time metrics ([1cfc5ec](https://github.com/StellarEdu/StellarEduPay/commit/1cfc5ecfc9f611290b1af5dd8aecb1b3cb6a5c06))
* **metrics:** expose dispute SLA and resolution-time metrics ([#1375](https://github.com/StellarEdu/StellarEduPay/issues/1375)) ([89b4171](https://github.com/StellarEdu/StellarEduPay/commit/89b41719156d6376845f4d5db9320396229c6858))
* **payments:** add bulk status update endpoint ([3e06b04](https://github.com/StellarEdu/StellarEduPay/commit/3e06b045657410a14770bc3111358b3a0d28c71c))
* **payments:** add bulk status update endpoint ([#1372](https://github.com/StellarEdu/StellarEduPay/issues/1372)) ([64db659](https://github.com/StellarEdu/StellarEduPay/commit/64db659ac01c549776dfc71a812ae2e1880944a3))
* **payments:** ingestStartsAt bounds history ingestion per school wallet ([7744e81](https://github.com/StellarEdu/StellarEduPay/commit/7744e8134aed3a611338f2b4648aef2bd3c87853)), closes [#1818](https://github.com/StellarEdu/StellarEduPay/issues/1818)
* **payments:** rate limit manual sync per school ([5b2fdcd](https://github.com/StellarEdu/StellarEduPay/commit/5b2fdcd52c476e184c9508b35dec04566eb766c5))
* **payments:** rate limit manual sync per school ([#1419](https://github.com/StellarEdu/StellarEduPay/issues/1419)) ([4574884](https://github.com/StellarEdu/StellarEduPay/commit/45748844013b07cd6b4b4993af55070bf3f6c9b6))
* **payments:** signed per-student pay link tokens ([c818284](https://github.com/StellarEdu/StellarEduPay/commit/c818284e4f5b3c0ddc20d34873c0adc9c87a19ec))
* **pay:** wallet payment request builder and network gating ([5a5b6ed](https://github.com/StellarEdu/StellarEduPay/commit/5a5b6edb2231e9df04547b3ce5eb28989a5d5dc8))
* release process, coverage ratchet, OpenTelemetry tracing and parent portal ([9ff7adf](https://github.com/StellarEdu/StellarEduPay/commit/9ff7adfc76893aca2079bd8b88aab1e470743852)), closes [#1634](https://github.com/StellarEdu/StellarEduPay/issues/1634) [#1635](https://github.com/StellarEdu/StellarEduPay/issues/1635) [#1636](https://github.com/StellarEdu/StellarEduPay/issues/1636) [#1637](https://github.com/StellarEdu/StellarEduPay/issues/1637)
* release process, coverage ratchet, OpenTelemetry tracing and parent portal ([#1634](https://github.com/StellarEdu/StellarEduPay/issues/1634) [#1635](https://github.com/StellarEdu/StellarEduPay/issues/1635) [#1636](https://github.com/StellarEdu/StellarEduPay/issues/1636) [#1637](https://github.com/StellarEdu/StellarEduPay/issues/1637)) ([76c34bb](https://github.com/StellarEdu/StellarEduPay/commit/76c34bbea31cf8894db9e92d9bd5c7287adbad6b))
* **schools:** wallet readiness evaluator for school Stellar accounts ([29a942f](https://github.com/StellarEdu/StellarEduPay/commit/29a942f3a2b36bdb0ca7ee27d4f949f2dbd42848))
* **scripts:** add --network flag and mainnet activation guidance in create-school-wallet.js (closes [#1494](https://github.com/StellarEdu/StellarEduPay/issues/1494)) ([ffce8ee](https://github.com/StellarEdu/StellarEduPay/commit/ffce8eea00b0f70e872e8c904493d6d35b4f6ad8))
* **scripts:** add --network flag and mainnet activation guidance in create-school-wallet.js (closes [#1494](https://github.com/StellarEdu/StellarEduPay/issues/1494)) ([9c56dd0](https://github.com/StellarEdu/StellarEduPay/commit/9c56dd077462477eff0d5bc4c5975d7e69030bfc))
* **scripts:** support mainnet and funding guidance in create-school-wallet.js ([#1494](https://github.com/StellarEdu/StellarEduPay/issues/1494)) ([b7b3d34](https://github.com/StellarEdu/StellarEduPay/commit/b7b3d34330207ad5d9b634d9ed69d20677d2858d))
* **students:** dry-run bulk import preview and CSV template ([ca57d8c](https://github.com/StellarEdu/StellarEduPay/commit/ca57d8cd76d61bc4c71f44a617250065f7c156e4)), closes [#1816](https://github.com/StellarEdu/StellarEduPay/issues/1816)
* **students:** paginate archived fee history ([#1416](https://github.com/StellarEdu/StellarEduPay/issues/1416)) ([e7a2aa5](https://github.com/StellarEdu/StellarEduPay/commit/e7a2aa5c145a9408a85674e9ebd24cc9cfbb3e8d))
* update on issue 1284 ([8300766](https://github.com/StellarEdu/StellarEduPay/commit/830076674f9c5de8b0173b7a4804f48adeb0575d))
* update on issue 1284 ([8103e1f](https://github.com/StellarEdu/StellarEduPay/commit/8103e1fd49b3765f63d24431e543cefa6ae43117))
* update on the issue 1286 ([f3158e8](https://github.com/StellarEdu/StellarEduPay/commit/f3158e80b713ea664eee5204ab66ba6750f7caf2))
* **webhooks:** apiVersion and per-endpoint sequence on event deliveries ([7f30cfe](https://github.com/StellarEdu/StellarEduPay/commit/7f30cfef3b5d26d0f02005f8c97e62187aa8a3f2)), closes [#1815](https://github.com/StellarEdu/StellarEduPay/issues/1815)
* **webhooks:** apply delivery retention to existing deployments ([6616751](https://github.com/StellarEdu/StellarEduPay/commit/66167515ce7ecb795b9fdd65aa7393293deee693))
* **webhooks:** apply delivery retention to existing deployments ([#1414](https://github.com/StellarEdu/StellarEduPay/issues/1414)) ([b6848c8](https://github.com/StellarEdu/StellarEduPay/commit/b6848c8d458a992ceb71d5895878aa37eaaec742))


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
* [#1590](https://github.com/StellarEdu/StellarEduPay/issues/1590) Plan the frontend toolchain upgrade — Next.js 14, React 18 an ([53c3d44](https://github.com/StellarEdu/StellarEduPay/commit/53c3d449fd571b68f5c36b08228a6ae41857be08))
* [#1591](https://github.com/StellarEdu/StellarEduPay/issues/1591) Add automated accessibility checks and fix WCAG issues on the ([f25df1d](https://github.com/StellarEdu/StellarEduPay/commit/f25df1d86332a88a5bd23ee2072eb643d80f3930))
* [#1592](https://github.com/StellarEdu/StellarEduPay/issues/1592) /api/retry-queue routes are registered after the 404 handler ([c529c72](https://github.com/StellarEdu/StellarEduPay/commit/c529c72bb8a1d1757f5352b5bf5971ec8a92c17b))
* [#1593](https://github.com/StellarEdu/StellarEduPay/issues/1593) Backup heartbeat route is never mounted, so backup_last_succe ([aec7313](https://github.com/StellarEdu/StellarEduPay/commit/aec73134abe590997b2e0929874b4cc00e3625af))
* [#1594](https://github.com/StellarEdu/StellarEduPay/issues/1594) GET /api/payments/verify/:receiptId is shadowed by /verify/:t ([e9e11bc](https://github.com/StellarEdu/StellarEduPay/commit/e9e11bc06cccdc518ab22f9a9a482b9291f654e2))
* [#1595](https://github.com/StellarEdu/StellarEduPay/issues/1595) Maintenance mode hits MongoDB on every request, its per-schoo ([0bab400](https://github.com/StellarEdu/StellarEduPay/commit/0bab400a0ba1fc2d3ae2a96445492b24cb5c985b))
* [#1596](https://github.com/StellarEdu/StellarEduPay/issues/1596) In-memory rate-limit stores grow without bound, and requests ([15cfeab](https://github.com/StellarEdu/StellarEduPay/commit/15cfeab171fcdbd62bcf306fd3e451f48049daa4))
* [#1597](https://github.com/StellarEdu/StellarEduPay/issues/1597) Global limit of 100 requests/minute per IP is hard-coded and ([884c6fa](https://github.com/StellarEdu/StellarEduPay/commit/884c6fa121f676bd72d0769c16f1ae0cfbc61342))
* [#1598](https://github.com/StellarEdu/StellarEduPay/issues/1598) express.json copies the raw body of every request into memory ([c5e78d0](https://github.com/StellarEdu/StellarEduPay/commit/c5e78d04d93de1409cd36b0983c22b3a6139e6a9))
* [#1599](https://github.com/StellarEdu/StellarEduPay/issues/1599) Idempotency middleware only intercepts res.json — responses s ([8a07277](https://github.com/StellarEdu/StellarEduPay/commit/8a072771833e034f39b3b2ea331ec62813c65d15))
* [#1600](https://github.com/StellarEdu/StellarEduPay/issues/1600) app.js requires the undeclared 'debug' package and globally d ([9535130](https://github.com/StellarEdu/StellarEduPay/commit/95351305f7249e43579f8bde6c178b6ce487324d))
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
* **#1364:** enhance scan-repo-secrets.js to detect hex secrets, mnemonics, and support exceptions allowlist ([4304693](https://github.com/StellarEdu/StellarEduPay/commit/4304693a8d20ded60ab718323183ee95658c91f3))
* **#1370:** add GET /api/audit/export endpoint for CSV and JSON download ([84cb280](https://github.com/StellarEdu/StellarEduPay/commit/84cb2802a9a1dc729d653691dd35d11d21ec0508)), closes [#1370](https://github.com/StellarEdu/StellarEduPay/issues/1370)
* **#1476:** Add soft-delete hooks for updateMany, deleteMany, and findOneAndDelete operations ([ee8559d](https://github.com/StellarEdu/StellarEduPay/commit/ee8559d069f993858dd33716a4d67543cce34e5e))
* **#1477:** Increase stuckPaymentReconciliation threshold to reduce false positives ([9161bb6](https://github.com/StellarEdu/StellarEduPay/commit/9161bb629b68a9977cb11aef588b2c8a0d07bb6d))
* **#1478:** Extend webhook events enum and route disputes through unified system ([17c5f85](https://github.com/StellarEdu/StellarEduPay/commit/17c5f85328136a3f854c64dbfa62388fd42267e1))
* **#1479:** Route transaction fetching through rate-limited client and add pagination ([f4de6ac](https://github.com/StellarEdu/StellarEduPay/commit/f4de6ac0aa4958c492e311fa6b0aa5978e5829a2))
* **#1573:** make pay-fees page work for anonymous parents ([a68e325](https://github.com/StellarEdu/StellarEduPay/commit/a68e3257040cb9e51978a744cfabb31ba59cd043))
* **#1574:** allow resolveSchool to read schoolId from query string for SSE ([2e8d78f](https://github.com/StellarEdu/StellarEduPay/commit/2e8d78fad6131d531a8286749b060d9b2be68245))
* **#1575:** align audit log API path across frontend, backend and docs ([805056e](https://github.com/StellarEdu/StellarEduPay/commit/805056e06277ead84c4f2415c3c3e716ae71dac6))
* **#1577:** use axios instance for CSV report download ([a369c3a](https://github.com/StellarEdu/StellarEduPay/commit/a369c3a2ae2ed5718e246651091189c197b95a5d))
* **#1582:** generate robots.txt and sitemap.xml at runtime from real origin ([0874a0e](https://github.com/StellarEdu/StellarEduPay/commit/0874a0e9ddc15236f731f1e40ff5030725d9f6bf))
* **#1583:** make frontend image environment-agnostic at runtime ([edddf88](https://github.com/StellarEdu/StellarEduPay/commit/edddf88a9af5cd316a62efaec15db04ce5be9154))
* **#1584:** add X-School-Slug, correlation IDs to CORS allowedHeaders; add exposedHeaders ([db8a255](https://github.com/StellarEdu/StellarEduPay/commit/db8a2555774eef6c1b0dadb5b89582d370a1671d))
* **#1585:** migrate inline &lt;style&gt; blocks to CSS Modules; merge global stylesheets ([c9c5614](https://github.com/StellarEdu/StellarEduPay/commit/c9c5614c6f81826cb74b144baf241aa94b99fb7d))
* **#1586:** eliminate theme FOUC and stop overwriting OS preference ([3efea30](https://github.com/StellarEdu/StellarEduPay/commit/3efea301fccac757b24fcfd13f1d7a1a8c6951ec))
* **#1587, #1588:** wire i18n into reminder emails and fix blank label placeholders ([3cdbeba](https://github.com/StellarEdu/StellarEduPay/commit/3cdbeba7bfb0a433994705faaba6aef7409aae47))
* **#1589:** format reminder email/SMS amounts with asset code and fiat equivalent ([28d9444](https://github.com/StellarEdu/StellarEduPay/commit/28d9444a15b9c7b4dbac9e95c83698a43b97bb01))
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
* 1472: Consolidate refund mechanisms for underpaid payments ([378ad4c](https://github.com/StellarEdu/StellarEduPay/commit/378ad4c082ffdf8524baa22c2339e96f4f370be0))
* 1473: Include creditAdjustments in studentBalanceUpdater calculation ([4a9a3ec](https://github.com/StellarEdu/StellarEduPay/commit/4a9a3ece7665a50c5111c8f848abebe2a0a53d5a))
* 1474: Wire feeAdjustmentEngine into payment validation path ([99f873f](https://github.com/StellarEdu/StellarEduPay/commit/99f873fe87995053fa49889b563ae539aab32b55))
* 1475: Add tenant scoping to feeAdjustmentEngine ([991a1e2](https://github.com/StellarEdu/StellarEduPay/commit/991a1e2ff787d6b3f2c791276a90da8c0c145118))
* 1521: School endpoints read req.params.schoolId instead of schoolSlug ([7ee1d60](https://github.com/StellarEdu/StellarEduPay/commit/7ee1d608566c04090eaa832793c92093a3e66b05))
* 1522: Idempotency keys scoped to tenant ([22609b7](https://github.com/StellarEdu/StellarEduPay/commit/22609b77d5da838b67d8a55fd8698b5a4bc7a5a7))
* 1523: Rate limiter namespace collision — verify and global limiters ([6c2de1a](https://github.com/StellarEdu/StellarEduPay/commit/6c2de1a228e75824a781ae9a24cce8374074b257))
* 1524: Query-string operator injection prevention with Joi validation ([2d7c836](https://github.com/StellarEdu/StellarEduPay/commit/2d7c8369c3d31cb332814b27981b7b036397d652))
* **academic-periods:** batch rollover writes to stay within transaction limits ([0f078f0](https://github.com/StellarEdu/StellarEduPay/commit/0f078f013c68c2fff83a41d10565fcf528001a87)), closes [#1784](https://github.com/StellarEdu/StellarEduPay/issues/1784)
* **academic-periods:** keep StudentPeriodFee.totalPaid in step with payments ([2cd3ee1](https://github.com/StellarEdu/StellarEduPay/commit/2cd3ee1f40aa0ed4ec3dabf1eae7748c25623239)), closes [#1785](https://github.com/StellarEdu/StellarEduPay/issues/1785)
* add status validation and distributed lock to updateRefundStatus ([2feee31](https://github.com/StellarEdu/StellarEduPay/commit/2feee315fba11c56e8aa8c86483acdebbb1b674a))
* add status validation and distributed lock to updateRefundStatus ([d493f5f](https://github.com/StellarEdu/StellarEduPay/commit/d493f5f7a3e851b6f34e6b16eee01d622fceb139)), closes [#1471](https://github.com/StellarEdu/StellarEduPay/issues/1471) [#1470](https://github.com/StellarEdu/StellarEduPay/issues/1470) [#1469](https://github.com/StellarEdu/StellarEduPay/issues/1469) [#1429](https://github.com/StellarEdu/StellarEduPay/issues/1429)
* align Node.js runtime to v24 across all environments ([#1735](https://github.com/StellarEdu/StellarEduPay/issues/1735)) ([752e6b0](https://github.com/StellarEdu/StellarEduPay/commit/752e6b0361ca09f688c24111ef7cb27849da01f0))
* align Node.js runtime to v24 across all environments ([#1735](https://github.com/StellarEdu/StellarEduPay/issues/1735)) ([4075841](https://github.com/StellarEdu/StellarEduPay/commit/40758410e1c3606515ea72cc95bcfa8a7ee9c38b))
* **api:** [#1787](https://github.com/StellarEdu/StellarEduPay/issues/1787) let staff correct parent email and phone on update ([9cab182](https://github.com/StellarEdu/StellarEduPay/commit/9cab1829007a13a81927b76e0fd16f4d5e0fd3fe))
* **audit:** [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) add auditContext to routes + logAudit to all mutati… ([a10790f](https://github.com/StellarEdu/StellarEduPay/commit/a10790f68e7f8b355a2f670a96517f7e7c45c723))
* **audit:** [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) add auditContext to routes + logAudit to all mutating handlers ([81d378d](https://github.com/StellarEdu/StellarEduPay/commit/81d378d21561aee83e3f364b7658df22b45faab0))
* **audit:** [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) add logAudit to all state-changing handlers ([c8bd474](https://github.com/StellarEdu/StellarEduPay/commit/c8bd47471162d31d596cb4a91f01f7cf98c3488c))
* **auth:** resolve REQUIRE_MFA enrolment loop ([#1739](https://github.com/StellarEdu/StellarEduPay/issues/1739)) ([3e44457](https://github.com/StellarEdu/StellarEduPay/commit/3e444574ced9c1947ad4e267d6777c5ee107104a))
* **auth:** resolve REQUIRE_MFA enrolment loop ([#1739](https://github.com/StellarEdu/StellarEduPay/issues/1739)) ([b156442](https://github.com/StellarEdu/StellarEduPay/commit/b156442a7cdd93422c1503aec2e95aa1aef78313))
* **backend:** mount GET /api/public-config ([eac5b06](https://github.com/StellarEdu/StellarEduPay/commit/eac5b0699bbea9df5000757792103031006a9dcb)), closes [#1792](https://github.com/StellarEdu/StellarEduPay/issues/1792)
* batch fixes for issues [#1360](https://github.com/StellarEdu/StellarEduPay/issues/1360) [#1361](https://github.com/StellarEdu/StellarEduPay/issues/1361) [#1362](https://github.com/StellarEdu/StellarEduPay/issues/1362) [#1363](https://github.com/StellarEdu/StellarEduPay/issues/1363) ([77f0098](https://github.com/StellarEdu/StellarEduPay/commit/77f0098e674818ac076a4aef3c1c597b814bdbe0))
* Bulk soft-delete hooks, webhook reconciliation, and rate-limited Horizon ([#1476](https://github.com/StellarEdu/StellarEduPay/issues/1476)-[#1479](https://github.com/StellarEdu/StellarEduPay/issues/1479)) ([b6dc844](https://github.com/StellarEdu/StellarEduPay/commit/b6dc844b2ca401e0034bef3db0d2b797c1caa524))
* **ci:** enforce Jest coverage thresholds and promote coverage job to required check ([5e9bd10](https://github.com/StellarEdu/StellarEduPay/commit/5e9bd10ba1a7c80bb135b4e51b75ba7073880eb4))
* **ci:** enforce Jest coverage thresholds and promote coverage job to required check ([82a42f5](https://github.com/StellarEdu/StellarEduPay/commit/82a42f59db3d8fac2943a0c9b572fc803558d996))
* **ci:** restore valid dynamic cache key interpolation ([#1489](https://github.com/StellarEdu/StellarEduPay/issues/1489)) ([7416d59](https://github.com/StellarEdu/StellarEduPay/commit/7416d59688741ce026357205847163fdc6d0557a))
* client-side txHash validation, QR download error handling, accessible confirm modals, and CSV export guard ([b50d1ba](https://github.com/StellarEdu/StellarEduPay/commit/b50d1ba4c503f798de163dc3b36f5c957cf4d537))
* consolidate ad-hoc migrations into versioned runner ([#1631](https://github.com/StellarEdu/StellarEduPay/issues/1631)) ([a42fcce](https://github.com/StellarEdu/StellarEduPay/commit/a42fcce060d5ebeba6b323b7bb4f913ad5a929dc))
* consolidate ad-hoc migrations into versioned runner ([#1631](https://github.com/StellarEdu/StellarEduPay/issues/1631)) ([0fae00e](https://github.com/StellarEdu/StellarEduPay/commit/0fae00e2e497ad76e4cf586de2657b1cb0e54c12))
* **deploy:** enable Redis AOF persistence and persistent volumes ([#1491](https://github.com/StellarEdu/StellarEduPay/issues/1491)) ([a7a3641](https://github.com/StellarEdu/StellarEduPay/commit/a7a3641518422c56f924abd77b507d27ff74e73f))
* dispute SSE listeners, CI cache keys, k8s manifests, and Redis persistence ([fc95df2](https://github.com/StellarEdu/StellarEduPay/commit/fc95df2755dd08eb8f1a0cd73ed575b7e1ad9ec1))
* **disputes:** import requireSchoolAuth and bind disputes to the payment's student ([805c1f9](https://github.com/StellarEdu/StellarEduPay/commit/805c1f930a05e01bf39f7569d73c8742ba1e5f7c))
* fee-bump tx, asset code, audit gaps, per-user MFA ([#1553](https://github.com/StellarEdu/StellarEduPay/issues/1553) [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) [#1555](https://github.com/StellarEdu/StellarEduPay/issues/1555) [#1556](https://github.com/StellarEdu/StellarEduPay/issues/1556)) ([fab903a](https://github.com/StellarEdu/StellarEduPay/commit/fab903a428b66db12b65d363aabfb2d767bf193e))
* **frontend:** [#1578](https://github.com/StellarEdu/StellarEduPay/issues/1578) route analytics and webhooks requests through the shared API client ([443182c](https://github.com/StellarEdu/StellarEduPay/commit/443182c8e1dfbfa8ea30e1b91ffd79d989cb91ca))
* **frontend:** [#1578](https://github.com/StellarEdu/StellarEduPay/issues/1578) use a single same-origin API base for every client call ([45216be](https://github.com/StellarEdu/StellarEduPay/commit/45216bed3bd7f6c5c309bd62d0156751c98fc1a4))
* **frontend:** [#1579](https://github.com/StellarEdu/StellarEduPay/issues/1579) enforce the RequireAdmin guard centrally for all admin routes ([f97b42d](https://github.com/StellarEdu/StellarEduPay/commit/f97b42dbb4fd521293ad94794bf513d4746406a6))
* **frontend:** [#1580](https://github.com/StellarEdu/StellarEduPay/issues/1580) single source of truth for Navbar and sidebar navigation ([7850704](https://github.com/StellarEdu/StellarEduPay/commit/7850704c7e243c470fc5b75e31424cc7a68c85e6))
* **frontend:** [#1789](https://github.com/StellarEdu/StellarEduPay/issues/1789) restore API helpers dropped by merge 0e3d70c ([48c3560](https://github.com/StellarEdu/StellarEduPay/commit/48c35609add475febca73fa1ba6600158ac14a8d))
* **frontend:** [#1790](https://github.com/StellarEdu/StellarEduPay/issues/1790) import getPaymentPlan in PaymentForm ([e92ed66](https://github.com/StellarEdu/StellarEduPay/commit/e92ed66f27128798467816e4c7e60b1b6294277d))
* **frontend:** add client-side Stellar transaction hash validation ([#1487](https://github.com/StellarEdu/StellarEduPay/issues/1487)) ([1d52f3e](https://github.com/StellarEdu/StellarEduPay/commit/1d52f3e3eaec3730de64655b7f4cf3f941c9c831))
* **frontend:** add error handling and revoke object URL in downloadQr ([#1485](https://github.com/StellarEdu/StellarEduPay/issues/1485)) ([6cb2d39](https://github.com/StellarEdu/StellarEduPay/commit/6cb2d390cd5f90a102bfc63e5b91db5160ec90d9))
* **frontend:** guard concurrent CSV report downloads with loading state ([#1486](https://github.com/StellarEdu/StellarEduPay/issues/1486)) ([366378f](https://github.com/StellarEdu/StellarEduPay/commit/366378fadf39a307431e8ecd0d84ef01fe600932))
* **frontend:** listen for real dispute SSE event names ([#1488](https://github.com/StellarEdu/StellarEduPay/issues/1488)) ([e8d8684](https://github.com/StellarEdu/StellarEduPay/commit/e8d868427241074baf32001d44e8dd30c49580a0))
* **frontend:** super-admin school switcher reads bare array response ([cc1b323](https://github.com/StellarEdu/StellarEduPay/commit/cc1b323a87367904c543ff17429ad582ccbb27b5)), closes [#1791](https://github.com/StellarEdu/StellarEduPay/issues/1791)
* **i18n:** define translation keys used by the UI in en.js and fr.js ([d9df9b2](https://github.com/StellarEdu/StellarEduPay/commit/d9df9b2d8a01bef10b57d3e01e5c073773435e9a)), closes [#1794](https://github.com/StellarEdu/StellarEduPay/issues/1794)
* Issue 1332 - Add TTL-aware DNS caching for webhook SSRF protection ([93f0c89](https://github.com/StellarEdu/StellarEduPay/commit/93f0c89f976cf7370f486f8c01f5d236dc1b34a1))
* Issue 1333 - Add frontend UI for webhook endpoint management ([02388dd](https://github.com/StellarEdu/StellarEduPay/commit/02388dd9ab373b031afcb6ff92f4b4b641db7fdf))
* Issue 1334 - Migrate audit log pagination to cursor-based ([e8e6bf9](https://github.com/StellarEdu/StellarEduPay/commit/e8e6bf9e2d0c5cf3f089d2afe79723b5669cff42))
* Issue 1335 - Add circuit breaker to currencyConversionService ([a06c64a](https://github.com/StellarEdu/StellarEduPay/commit/a06c64a565b10134036a0fdec00be997c19437d8))
* judge payment plan installments against installment amount in underpaid reconciliation ([990b80a](https://github.com/StellarEdu/StellarEduPay/commit/990b80afd387c492328fbab26c2462634b1acb9f))
* **k8s:** add NetworkPolicies for mongodb and redis ([#1492](https://github.com/StellarEdu/StellarEduPay/issues/1492)) ([3fb38df](https://github.com/StellarEdu/StellarEduPay/commit/3fb38dfb2890d40cf2586f803e43cbc20bbcfbbf))
* Make RECEIPT_SIGNATURE_SECRET a required configuration variable ([523a566](https://github.com/StellarEdu/StellarEduPay/commit/523a566a0d6bf149b96fd27b56b6d7bae298d872)), closes [#1498](https://github.com/StellarEdu/StellarEduPay/issues/1498)
* **migrations:** add missing version exports and enforce contract ([#1](https://github.com/StellarEdu/StellarEduPay/issues/1)… ([dd687d2](https://github.com/StellarEdu/StellarEduPay/commit/dd687d23228ee0013dbf308eb861d13a6ff0e8a2))
* **migrations:** add missing version exports and enforce contract ([#1731](https://github.com/StellarEdu/StellarEduPay/issues/1731)) ([0776c7b](https://github.com/StellarEdu/StellarEduPay/commit/0776c7b35df1688acaeaeec4661fec26de0d3d10))
* **monitoring:** delete duplicate Grafana dashboard-provisioning file (closes [#1493](https://github.com/StellarEdu/StellarEduPay/issues/1493)) ([c9cff96](https://github.com/StellarEdu/StellarEduPay/commit/c9cff964aa30beee710c57cc248366eb872f4769))
* **monitoring:** delete duplicate Grafana dashboard-provisioning file (closes [#1493](https://github.com/StellarEdu/StellarEduPay/issues/1493)) ([77c67ac](https://github.com/StellarEdu/StellarEduPay/commit/77c67acdc6430af3a29d15d3b19b8d450235e337))
* **monitoring:** remove duplicate dashboard provisioning file ([#1493](https://github.com/StellarEdu/StellarEduPay/issues/1493)) ([1fae778](https://github.com/StellarEdu/StellarEduPay/commit/1fae77887645dc67e7c2985569b5ae4aff161f51))
* NetworkPolicies for DBs, dashboard deduplication, mainnet wallet guidance, and webhook key fallback ([4d1d1f7](https://github.com/StellarEdu/StellarEduPay/commit/4d1d1f730491251a964ad471d63d7ac3f80bfa3f))
* **outbox:** atomic claim, per-listener delivery, backoff ([#1646](https://github.com/StellarEdu/StellarEduPay/issues/1646)) ([f691c7e](https://github.com/StellarEdu/StellarEduPay/commit/f691c7e6743ec8791a319445a8be98342c0151de))
* **outbox:** atomic claim, per-listener delivery, backoff ([#1646](https://github.com/StellarEdu/StellarEduPay/issues/1646)) ([96b23c0](https://github.com/StellarEdu/StellarEduPay/commit/96b23c03dd73cb9a3f1d712649b9b307a9572b31))
* **payments:** add error handling and revoke object URL in PaymentForm QR download (closes [#1485](https://github.com/StellarEdu/StellarEduPay/issues/1485)) ([7563ff5](https://github.com/StellarEdu/StellarEduPay/commit/7563ff5956bac010f7ba5940975b406f8138816c))
* **payments:** add error handling and revoke object URL in PaymentForm QR download (closes [#1485](https://github.com/StellarEdu/StellarEduPay/issues/1485)) ([b9a594d](https://github.com/StellarEdu/StellarEduPay/commit/b9a594dfb40d3230ca1502328047dd1ed3fe7c27))
* **payments:** promote PENDING payments to SUCCESS in finalizer ([de609e0](https://github.com/StellarEdu/StellarEduPay/commit/de609e0d645bc9289c353f8ca8c993407fa61a16)), closes [#1754](https://github.com/StellarEdu/StellarEduPay/issues/1754)
* **rate-limit:** consistent headers, reset values and 429 body across limiters ([56c108e](https://github.com/StellarEdu/StellarEduPay/commit/56c108edea696bf73d451aea85dc443afce13eaa))
* **rate-limit:** consistent RateLimit-* headers, reset values and 429 body across limiters ([1d2cbc6](https://github.com/StellarEdu/StellarEduPay/commit/1d2cbc62fb6d5bdaeab347789b9d81930834028d)), closes [#1642](https://github.com/StellarEdu/StellarEduPay/issues/1642)
* **rate-limiter:** bound the in-memory fallback and unify the windowing algorithm ([#1285](https://github.com/StellarEdu/StellarEduPay/issues/1285)) ([11482e0](https://github.com/StellarEdu/StellarEduPay/commit/11482e00e5ef9683926465adde894b48e3b3f1f4))
* **rate-limiter:** bound the in-memory fallback and unify the windowing algorithm ([#1285](https://github.com/StellarEdu/StellarEduPay/issues/1285)) ([c307e52](https://github.com/StellarEdu/StellarEduPay/commit/c307e52ac4592d05137875f726a62dd298d40c72))
* redact log secrets, wire email locale, worker heartbeat health, queue metrics ([8b10ae8](https://github.com/StellarEdu/StellarEduPay/commit/8b10ae835302264e6e4296660c98cc67201c6b90))
* refund system — partial refunds, atomic txns, two-person approva… ([aed5419](https://github.com/StellarEdu/StellarEduPay/commit/aed5419e7f27ac59ca7e473a79baf74a1b31ae1f))
* refund system — partial refunds, atomic txns, two-person approval, execution ([#1564](https://github.com/StellarEdu/StellarEduPay/issues/1564) [#1565](https://github.com/StellarEdu/StellarEduPay/issues/1565) [#1566](https://github.com/StellarEdu/StellarEduPay/issues/1566) [#1567](https://github.com/StellarEdu/StellarEduPay/issues/1567)) ([5da71f4](https://github.com/StellarEdu/StellarEduPay/commit/5da71f46c0056a8a44ed9b7276fd9077f82fa9bd))
* **reminders:** [#1788](https://github.com/StellarEdu/StellarEduPay/issues/1788) run reminders for any email provider and SMS-only parents ([979669b](https://github.com/StellarEdu/StellarEduPay/commit/979669b109eee1dec9c74f926ec8ef71c68f7927))
* Remove secret fields from public school endpoints ([cb83f77](https://github.com/StellarEdu/StellarEduPay/commit/cb83f775b6c827d1895602e71abe9d291e5b673f)), closes [#1520](https://github.com/StellarEdu/StellarEduPay/issues/1520)
* replace duplicate $ne with $nin in detectMemoCollision ([64e7ac3](https://github.com/StellarEdu/StellarEduPay/commit/64e7ac30b3eb9ace4303eabb5bf97b09bd15bfec))
* **reports:** bound report aggregations with maxTimeMS ([320ab53](https://github.com/StellarEdu/StellarEduPay/commit/320ab538c2a9c9b05afbb9dae87c044752f58c1d))
* **reports:** bound report aggregations with maxTimeMS ([#1376](https://github.com/StellarEdu/StellarEduPay/issues/1376)) ([0c05b34](https://github.com/StellarEdu/StellarEduPay/commit/0c05b348c93155d6180851d4efbe2846e87765ca))
* resolve issues [#1553](https://github.com/StellarEdu/StellarEduPay/issues/1553) [#1554](https://github.com/StellarEdu/StellarEduPay/issues/1554) [#1555](https://github.com/StellarEdu/StellarEduPay/issues/1555) [#1556](https://github.com/StellarEdu/StellarEduPay/issues/1556) ([70662b0](https://github.com/StellarEdu/StellarEduPay/commit/70662b0dad21e28ee16773deced13a60f369bb1b))
* **schools:** allow-list public fields on GET /api/schools/:schoolId ([a1aeb65](https://github.com/StellarEdu/StellarEduPay/commit/a1aeb65240dc9042b669217acf1c8bb104d015f6)), closes [#1783](https://github.com/StellarEdu/StellarEduPay/issues/1783)
* **schools:** paginate school listing and use requireAdminAuth for includeInactive ([045ffde](https://github.com/StellarEdu/StellarEduPay/commit/045ffde8784143e728a0c0e57d55a365ad57c458))
* **schools:** paginate/search school listing and use requireAdminAuth for includeInactive ([c9288fd](https://github.com/StellarEdu/StellarEduPay/commit/c9288fdbe7080d352b15c7b9aff8cbb68dea0afe)), closes [#1643](https://github.com/StellarEdu/StellarEduPay/issues/1643)
* Scope fee structure cache keys by tenant ([cfcebe5](https://github.com/StellarEdu/StellarEduPay/commit/cfcebe5aa1feee649cd6c44aae35a6668ca95a9b)), closes [#1518](https://github.com/StellarEdu/StellarEduPay/issues/1518)
* Scope student record caches by tenant ([4d3eec2](https://github.com/StellarEdu/StellarEduPay/commit/4d3eec2ae4cf1d3dcde62dd00db397fcebafd7c2)), closes [#1519](https://github.com/StellarEdu/StellarEduPay/issues/1519)
* **security:** encrypt endpoint webhook secrets, harden email webhooks, add V1 signature sunset, redact public /health ([5bed16b](https://github.com/StellarEdu/StellarEduPay/commit/5bed16b9320310ccbba44c86f8bb33a43988b998))
* **security:** protect OpenAPI doc, safe reminder unsubscribe, escape email HTML, CSV formula injection ([2b14ccd](https://github.com/StellarEdu/StellarEduPay/commit/2b14ccd65d14a259dbc76aca6d93c09df58e42dd))
* **security:** protect OpenAPI doc, safe unsubscribe, escape email HTML, CSV formula injection ([578db19](https://github.com/StellarEdu/StellarEduPay/commit/578db1995045189773debd53e15a45a3af689a60)), closes [#1541](https://github.com/StellarEdu/StellarEduPay/issues/1541) [#1542](https://github.com/StellarEdu/StellarEduPay/issues/1542) [#1543](https://github.com/StellarEdu/StellarEduPay/issues/1543) [#1544](https://github.com/StellarEdu/StellarEduPay/issues/1544)
* **security:** redact PII from logs, mask student identifiers, prevent roster enumeration ([ca36486](https://github.com/StellarEdu/StellarEduPay/commit/ca3648653c536046f1913b0436e116bb3a07da16))
* **security:** redact PII from logs, mask student identifiers, prevent roster enumeration ([504aa9f](https://github.com/StellarEdu/StellarEduPay/commit/504aa9ff87c0a440128bb248172209dcadba4ba3))
* **security:** support WEBHOOK_SECRET_ENCRYPTION_KEY_OLD fallback during key rotation ([#1495](https://github.com/StellarEdu/StellarEduPay/issues/1495)) ([d377c09](https://github.com/StellarEdu/StellarEduPay/commit/d377c09f72ecc1691c0768adc4fcc6500e7e1a2d))
* **security:** webhook secret encryption, email webhook auth, V1 signature sunset, public /health redaction ([cf6ad45](https://github.com/StellarEdu/StellarEduPay/commit/cf6ad458a2c0e7622b50ddeb0710470a4bcfc412))
* **shutdown:** stop outbox dispatcher, report worker, cache invalidator and heap monitor ([1336cd1](https://github.com/StellarEdu/StellarEduPay/commit/1336cd14cd1a67026e9c85fda36b3808e8d3afe9))
* **shutdown:** stop outbox dispatcher, report worker, cache invalidator and heap monitor on shutdown ([0d8cd23](https://github.com/StellarEdu/StellarEduPay/commit/0d8cd23ac91c8b3f7d459056071a5bec7925e4b4)), closes [#1645](https://github.com/StellarEdu/StellarEduPay/issues/1645)
* **sse:** subscribe to all backend dispute lifecycle events in usePaymentEvents (closes [#1488](https://github.com/StellarEdu/StellarEduPay/issues/1488)) ([fd2e501](https://github.com/StellarEdu/StellarEduPay/commit/fd2e5017a460cea62f7293e54ee983e1421f0cff))
* **sse:** subscribe to all backend dispute lifecycle events in usePaymentEvents (closes [#1488](https://github.com/StellarEdu/StellarEduPay/issues/1488)) ([2b0d886](https://github.com/StellarEdu/StellarEduPay/commit/2b0d8864bb2081a413f3a63c05aaef123f7664a0))
* **stellar:** [#1556](https://github.com/StellarEdu/StellarEduPay/issues/1556) read memo/ops from top-level tx, [#1555](https://github.com/StellarEdu/StellarEduPay/issues/1555) pass assetCode to limits ([9722cd7](https://github.com/StellarEdu/StellarEduPay/commit/9722cd72a6e11dfd7eba636577dd1d0f5be63b40))
* **students:** recompute balance and fee history on fee change ([ad33c66](https://github.com/StellarEdu/StellarEduPay/commit/ad33c669a0d629e91a5c1f7fd314357c77c15a3d)), closes [#1786](https://github.com/StellarEdu/StellarEduPay/issues/1786)
* **students:** register PATCH for student updates, encode the ID ([c85b6bc](https://github.com/StellarEdu/StellarEduPay/commit/c85b6bc4c4dff5a4d27f5ba98aba101b3bb1f9c9))
* **students:** register PATCH for student updates, encode the ID ([18627b5](https://github.com/StellarEdu/StellarEduPay/commit/18627b5e488c9d25bf7d3033b79239e62ed79d19))
* **students:** validate student form, encrypt parent PII, unify class options ([4b61919](https://github.com/StellarEdu/StellarEduPay/commit/4b61919ddf64143b9dfe2b78a9aaae9cb0d48d3d))
* **students:** validate student form, encrypt parent PII, unify class options ([1e36a24](https://github.com/StellarEdu/StellarEduPay/commit/1e36a24e9726b249872d97ba66bec30f78c20261)), closes [#1481](https://github.com/StellarEdu/StellarEduPay/issues/1481) [#1482](https://github.com/StellarEdu/StellarEduPay/issues/1482) [#1483](https://github.com/StellarEdu/StellarEduPay/issues/1483) [#1480](https://github.com/StellarEdu/StellarEduPay/issues/1480)
* **tests:** delete stale duplicate test files and extend orphan-dir check to tests/ (closes [#1496](https://github.com/StellarEdu/StellarEduPay/issues/1496)) ([02173d2](https://github.com/StellarEdu/StellarEduPay/commit/02173d29da1c0eca6b6aa2acb6bb36e768c502be))
* **tests:** delete stale duplicate test files and extend orphan-dir check to tests/ (closes [#1496](https://github.com/StellarEdu/StellarEduPay/issues/1496)) ([b477f0c](https://github.com/StellarEdu/StellarEduPay/commit/b477f0cd4fc82b3d7ac722944308aed93750d4e3))
* tini PID 1, probe separation, K8s env, restricted PSS ([439cb22](https://github.com/StellarEdu/StellarEduPay/commit/439cb22f7c2299cbf32e07d6efa2d8cbc5e4f25b))
* tini PID 1, probe separation, K8s env, restricted PSS ([0b26af5](https://github.com/StellarEdu/StellarEduPay/commit/0b26af585ae093babf45c35e4b40afeaa7c99692))
* validate feeCategory query parameter on payment instructions ([8a4ee98](https://github.com/StellarEdu/StellarEduPay/commit/8a4ee9892e65a668869d98bddf57aa2490edb2b5))
* wire sendAdminAlert to real alert delivery ([74d78d6](https://github.com/StellarEdu/StellarEduPay/commit/74d78d67ed5f2048f20b1a9ff965eb97933a54d3))

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
