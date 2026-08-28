# Changelog

## Unreleased

- Added KS-11-02 deterministic E2E acceptance coverage for 15 critical
  customer/order scenarios, a real-PostgreSQL coherence journey, omission-first
  JSON/Markdown evidence and release-blocking CI artifact archival. The suite
  uses synthetic payment, authority, mail and supplier-neutral outcomes with no
  production side effects; KS-11-03 through KS-11-07 remain open.

- Hardened KS-11-01 staging origin isolation so the four current KeyRaNo
  production storefront origins are classified as production and only the
  canonical staging origin plus isolated CI fixture are accepted; arbitrary
  HTTPS hosts and URL credentials remain fail-closed.

- Added KS-11-01 isolated repeatable staging foundation with explicit STAGING
  identity, omission-first safety preflight, role-aware readiness, pinned
  WordPress/PostgreSQL/Redis/Mailpit Compose scaffold, migrations-through-026
  verification and a small idempotent synthetic catalog seed. Preserved the
  consolidated Phase-11 validation task as an umbrella while KS-11-02 through
  KS-11-07 remain not started and `SECURITY-READINESS` remains unapproved.

- Added KS-10-02 Phase-10 gap closure with field-specific operational logging
  allowlists and nested-data omission tests, validated critical runbook owners
  and recovery/fallback metadata, PostgreSQL-backed checkout and precise global
  commerce deny gates in migration 026, and deterministic manifest plus
  synthetic isolated PostgreSQL restore-drill validation. Category pause and a
  negative-margin order metric remain deferred until their required
  authoritative persisted facts exist.

- Added consolidated KS-10-01 monitoring, backups and emergency-controls
  foundation with allowlisted aggregate metrics and structured telemetry,
  role-aware liveness/readiness, runbook-linked alert definitions, authorized
  payload-free dead-letter handling, PostgreSQL-backed deny-only controls for
  procurement/key retrieval/customer delivery/supplier claims, migration 025,
  encrypted-only backup/isolated-restore validation and incident runbooks while
  leaving production exporters, dashboards, alert delivery, operations UI,
  backup storage/scheduling and Security Readiness approval unconnected.

- Added KS-09-05 supplier claim workflow foundation with provider-neutral
  structured claims, fail-closed trusted authority and submission ports,
  authoritative supplier derivation, exact-order support/procurement/
  fulfillment/evidence binding, idempotent creation, optimistic concurrency,
  append-only history, PostgreSQL migration 024 and ambiguity-safe prepared
  submission operations while leaving Kinguin claim/key-return mutations,
  Stripe refunds, replacement fulfillment, production UI and Product Key access
  disabled.

- Hardened KS-09-04 before merge by adding runtime validation for support
  categories, priorities, visibility, statuses, resolution codes, IDs,
  correlation IDs and pagination, preventing operator-created false ownership
  on unclaimed orders, narrowing customer support projections, making support
  messages and links append-only, adding database exact-order link backstops
  and auditing operator actions without message bodies.
- Added KS-09-04 support case foundation with provider-neutral internal
  `SupportCase` records, authenticated customer-owned order support,
  account-only customer cases, fail-closed trusted operator authority,
  customer/internal message visibility, immutable ownership, append-only
  support history, exact-order dispute/fraud/fulfillment reference links,
  PostgreSQL migration 023 and audit-safe metadata while leaving production
  helpdesk integration, email, UI, refunds, supplier claims, Stripe/Kinguin
  mutations and product-key reveal out of scope.
- Added KS-09-03 dispute evidence foundation with provider-neutral structured
  evidence snapshots, mandatory order/payment sections, explicit optional
  absence and ambiguity states, deterministic fingerprints, PostgreSQL
  migration 022, immutable finalized snapshots, exact-order-bound export,
  fail-closed trusted authority gates and audit-safe metadata events while
  leaving Stripe dispute submission, support tickets, supplier claim workflow,
  production operator UI, provider mutations and product-key reveal out of
  scope.
- Added KS-09-02 fraud velocity limits with durable `PAYMENT_CONFIRMED`
  velocity events, pseudonymous checkout-email correlation, typed window and
  threshold policy, `KS09_POLICY_V2` fingerprints, fail-closed unavailable
  signal handling, PostgreSQL migration 021 and documentation while leaving
  production velocity policy approval, external fraud providers, support
  tickets, dispute evidence, supplier claims, Kinguin calls, Stripe mutations
  and real key reveal out of scope.
- Hardened KS-09-02 before merge by requiring trusted velocity event authority,
  rejecting no-subject velocity as unavailable, versioning checkout-email
  subject keys, validating event timestamps and velocity aggregate completeness,
  freezing validated velocity policy, rejecting duplicate/zero/non-canonical
  configuration, making PostgreSQL velocity snapshots one-statement coherent
  and clarifying partial guest-to-customer event counts.
- Added KS-09-01 fraud risk and manual-review foundation with deterministic
  trusted-fact rule evaluation, policy-versioned persisted decisions,
  fact-fingerprint idempotency, PostgreSQL migration 020, one-active-fraud-case
  review persistence, trusted review authority boundary, fail-closed
  downstream clearance guard and documentation while leaving velocity limits,
  external fraud providers, production operator UI, support tickets, dispute
  evidence, supplier claims, Kinguin calls, Stripe mutations and real key
  reveal out of scope.
- Hardened KS-09-01 before merge by binding clearance and review resolution to
  current authoritative facts, policy version and fact fingerprint, scoping open
  fraud review uniqueness to the exact evaluation, retaining stale review
  history, documenting best-effort audit behavior and adding adversarial stale
  approval, replay, concurrency, policy-isolation and fingerprint tests.
- Hardened KS-08-06 before merge by sanitizing customer-visible invoice
  references/timestamps, enforcing invoice state/download consistency, failing
  fast on duplicate activation registry keys, defensively copying registry
  entries, tightening trusted help URL policy, adding transport error redaction
  coverage and documenting Phase 08 backend/application foundation closure.
- Added KS-08-06 customer invoice and activation-instruction foundation with
  explicit owned-order read services, transport-neutral invoice and activation
  endpoints, curated structured activation registry validation, authority-field
  rejection tests and documentation while leaving production invoice generation,
  PDF rendering, tax/legal accounting, WooCommerce/frontend exposure and real
  key reveal disabled.
- Hardened KS-08-05 guest order claim before merge by preventing claim-time
  checkout email snapshot backfill, making snapshot updates fully immutable,
  replacing permissive test issuance authority with persisted order/snapshot
  checks, adding delivery-exception/reissue-failure/token-entropy/WooCommerce
  bypass tests and clarifying claim-email copy.
- Added KS-08-05 account-required guest order claim foundation with
  purchase-time checkout email snapshots, hash-only one-time Kaufcode
  credentials, trusted claim issuance/consume authority, authenticated
  verified-account claim transport, PostgreSQL migration 019 and documentation
  while leaving production guest claim email, production HTTP, WooCommerce,
  frontend and real key reveal disabled.
- Hardened KS-08-04 customer key access review coverage for stale account
  metadata, current persisted delivery authorization, cross-customer capability
  execution, order/fulfillment confusion, synthetic secret/capability/session
  leakage checks and KeyRaNo public-brand documentation alignment.
- Added KS-08-04 secure customer key access integration with a transport-neutral
  `CustomerKeyAccessService`, explicit prepare/execute account transport
  actions, KS-07 secure delivery reuse, fulfillment/order eligibility checks,
  one-time capability preservation, concurrency/replay tests and documentation
  while leaving production HTTP, WooCommerce, real key reveal, Kinguin and live
  Stripe mutation disabled.
- Hardened KS-08-03 customer account transport boundaries with deterministic
  fail-closed credential-source extraction, broader authority-field rejection,
  redacted internal-failure mapping, origin/content/body/correlation regression
  tests, token-leakage tests and pagination clamp preservation.
- Added KS-08-03 customer account transport and shop integration foundation
  with transport-neutral v1 account/registration handlers, session-backed
  principal resolution, strict request DTO validation, Origin/CSRF/rate-limit
  policy reuse, safe cache/response headers, WooCommerce trust-boundary
  documentation and synthetic transport tests while leaving production HTTP,
  WordPress/WooCommerce installation, frontend, real key reveal, Kinguin and
  live Stripe mutation out of scope.
- Added KS-08-02 customer registration and verified account-linking foundation
  with enumeration-safe registration, hash-only one-time email verification
  challenges, single-active challenge reissue, trusted verification authority
  integration, authenticated verified external identity linking, fail-closed
  guest-order claim foundation, safe registration inspect command and
  PostgreSQL migration 018 while leaving production email, login, frontend,
  account merge, email-only order claiming, Kinguin and live Stripe mutation out
  of scope.
- Added KS-08-01 customer account foundation with a transport-neutral
  `CustomerAccountService`, authenticated-principal account scoping, SQL-level
  owned order-history/detail projections, bounded signed cursor pagination,
  explicit pagination validation, fail-closed fulfillment/order-link key-vault
  metadata, invoice metadata, structured activation instruction metadata,
  private no-store cache policy and account access audit events while
  leaving production login, frontend, real key reveal, invoice generation,
  guest order claiming, Kinguin retrieval/purchase and live Stripe mutation out
  of scope.
- Added KS-07-08 authenticated customer delivery transport foundation with a
  transport-neutral POST-only handler, session principal resolution,
  fulfillment/order object authorization, one-time capability requirement,
  Origin and CSRF policy, in-memory rate-limit port, no-store response policy
  and synthetic encrypted delivery tests while leaving production HTTP,
  frontend, login provider, distributed rate limiting and real customer
  delivery disabled.
- Added KS-07-07 production customer authentication foundation with trusted
  authentication assertions, persisted server-side customer sessions, hash-only
  opaque tokens, session-backed authenticated principals, rotation/revocation,
  safe inspect command, reversible PostgreSQL migration and cookie/transport
  policy documentation while leaving login UI, OAuth/WooCommerce adapters,
  checkout, email delivery, Kinguin procurement and key retrieval out of scope.
- Added KS-07-06 customer order identity and ownership foundation with opaque
  customer IDs, normalized/verified customer records, external identity binding
  placeholders, immutable order ownership, persisted delivery authorization,
  reversible PostgreSQL migration, safe inspect commands and fail-closed
  production principal behavior; hardened trust boundaries so email
  verification, external identity binding and order ownership binding require
  injected trusted authorities instead of request-controlled metadata.
- Added KS-07-05 secure customer key delivery foundation with one-time
  capability authorization, customer/order authorization port, explicit
  claim/acknowledge delivery attempts, fake/test delivery boundary, plaintext
  zeroization, reversible PostgreSQL delivery persistence, safe inspect command
  and live-delivery gate while leaving production email and customer HTTP
  endpoints out of scope.
- Hardened KS-07-05 post-dispatch delivery semantics so local persistence
  failures after external delivery success become manual-review ambiguous
  outcomes and cannot trigger blind customer redelivery.
- Added KS-07-04 secure key retrieval and fulfillment foundation with durable
  fulfillment operations, AES-256-GCM encrypted fulfillment secrets, controlled
  Kinguin key-retrieval approval gates, retrieval leases, safe inspect command
  and supplier-key leakage tests while leaving production customer delivery
  disabled.
- Hardened KS-07-04 key retrieval with documented Kinguin repeatability policy,
  finite controlled retrieval timeout configuration, one-request execution,
  local crypto/persistence failure reason codes, `FULFILLMENT_KEY_RETRIEVED`
  success semantics and PostgreSQL orphan-secret/concurrent-writer tests.
- Added KS-07-03e safe Kinguin procurement rejection diagnostics with sanitized
  supplier HTTP status, documented machine error code, normalized category,
  safe reason code, durable approval persistence, reconciliation output and a
  local database inspect command while preserving ambiguous no-retry semantics.
- Added KS-07-03c controlled first live Kinguin procurement foundation with a
  one-time approval manifest, hashed execution token, atomic PostgreSQL claim,
  price-bound request fingerprint, dispatch-before-HTTP evidence, no retry,
  read-only reconciliation, and no key retrieval.
- Hardened KS-07-03c live procurement wiring so real CLI composition invokes
  controlled config validators, read-only commands use guarded GET-only
  transport, mutation transport pins the production Kinguin order endpoint, and
  approval lifecycle updates are conditional on expected state/version.
- Added KS-07-03d bounded read-only Kinguin candidate discovery pagination with
  safe CLI caps, product-record counting, candidate deduplication and numeric
  minor-unit price sorting.
- Added KS-07-03b controlled Kinguin procurement dry-run verification with a technically read-only live transport, bounded real product sampling, Germany eligibility, synthetic verification-only pricing, deterministic purchase request fingerprinting and no supplier mutation.
- Added KS-07-03 supplier procurement orchestration with durable operations, execution leases, dispatch-state crash safety, dry-run mode, fake-supplier execution tests and PostgreSQL persistence constraints while keeping real supplier procurement disabled.
- Hardened KS-07-03 PostgreSQL procurement concurrency so attempt creation uses order-scoped advisory locking, lease acquisition uses an atomic conditional update, and tests use separate PostgreSQL clients for concurrent actors.
- Implemented `KS-07-02` Stripe payment integration foundation:
  - added Stripe PaymentIntent initialization behind a payment port with deterministic server-side idempotency keys;
  - added local `order_payments` persistence with atomic order/provider reservation, optimistic updates and no stored client secrets;
  - added raw-body Stripe webhook verification and idempotent handling for succeeded, failed, processing and canceled PaymentIntent events;
  - hardened Stripe PaymentIntent creation with a durable bounded create lease so crashed or unknown create outcomes retry safely with the same Stripe idempotency key;
  - added fail-closed amount, currency, order metadata and external mapping checks before marking orders captured;
  - added test-mode configuration guards, reversible migration and Stripe payment documentation;
  - kept live Stripe keys, live charges, supplier procurement, key retrieval, fulfillment and KS-07-03 out of scope.
- Implemented `KS-07-01` checkout and order orchestration foundation:
  - added KeyCore-owned order state machine with payment, procurement, fulfillment, risk and refund sub-states;
  - added atomic PostgreSQL order creation that claims a single-use price lock and writes transactional outbox intent;
  - added order idempotency, external event deduplication, transition history and optimistic concurrency handling;
  - hardened concurrent same-key order idempotency across different price locks with transaction-scoped PostgreSQL advisory locking;
  - added procurement payment/risk gates, ambiguous-procurement manual-review behavior and refund lifecycle modeling;
  - added reversible PostgreSQL `keycore_orders`, `order_transition_history` and `external_event_receipts` migration;
  - kept real Stripe, live supplier purchase, product-key retrieval, invoice creation, WooCommerce order authority and KS-07-02 out of scope.
- Implemented `KS-06-02` price locks and profitability safeguards:
  - added explicit price-lock state model, idempotent creation and immutable locked customer price;
  - added profitability revalidation against current hard minimum-profit and minimum sell-price safety floors;
  - added deterministic multi-offer rescue behavior before procurement starts;
  - added atomic single-use consumption foundation with optimistic record versions;
  - hardened price-lock idempotent creation and status transitions for PostgreSQL concurrency races;
  - added reversible PostgreSQL `price_locks` persistence and 50,000-offer invariant coverage;
  - kept checkout, payments, orders, procurement, fulfillment, GAMIVO, live supplier purchase and live WooCommerce mutation out of scope.
- Implemented `KS-06-01` pricing and margin foundation:
  - added supplier-neutral `pricing-policy-v1` pricing with integer minor-unit `Money` calculations;
  - added fee, tax and FX boundaries that fail closed for unknown or stale inputs;
  - added durable global pricing policies, product overrides, manual sell prices and price snapshots;
  - hardened manual sell-price persistence so configured manual prices must be greater than zero at domain, repository, PostgreSQL and hydration boundaries;
  - added deterministic multi-offer safe quote selection behind the storefront price boundary;
  - added audit-safe pricing events, safe recalculation payloads and 50,000-offer synthetic pricing coverage;
  - kept admin UI, checkout, payment, procurement, GAMIVO, live FX, production VAT assumptions and live WooCommerce out of scope.
- Implemented `KS-05-04` catalog search and incremental operations foundation:
  - added PostgreSQL-native, supplier-neutral search projections with `catalog-search-v1`;
  - added deterministic ranking, bounded cursor pagination and safe filter support;
  - added restartable reindex and targeted refresh operations with durable checkpoints;
  - added safe catalog-change, webhook refresh-signal and storefront re-evaluation payloads;
  - hardened the PostgreSQL search projection to persist `search_text` explicitly instead of using a generated `tsvector` column rejected by PostgreSQL 16;
  - kept live WooCommerce, live Kinguin bulk crawl, GAMIVO, checkout, procurement and Phase 06 out of scope.
- Implemented `KS-05-03` WooCommerce storefront publication foundation:
  - added supplier-neutral storefront publication state machine, eligibility evaluation and price boundary;
  - added durable `ProductId + storefront -> remote Woo product ID` mapping with fail-closed conflict checks;
  - added WooCommerce REST `wc/v3` adapter foundation for create, update, read and soft-unpublish without live credentials;
  - hardened WooCommerce mutating transport uncertainty so ambiguous creates, updates and soft-unpublishes require reconciliation;
  - injected storefront audit environment instead of hardcoding `CI`;
  - added a shared PostgreSQL integration-test bootstrap with advisory-locked `pgcrypto` setup to remove parallel schema initialization races;
  - added reversible PostgreSQL publication mapping migration and integration coverage;
  - kept live WooCommerce, checkout, payment, procurement, GAMIVO and production publication out of scope.
- Implemented `KS-05-02` canonical product grouping foundation:
  - added supplier-neutral canonical grouping policy `canonical-grouping-v1`;
  - added evidence, title normalization, edition safety, platform safety and mapping state models;
  - added in-memory and PostgreSQL grouping repositories with reversible migration and indexed strong identifier lookup;
  - corrected migration rollback so the obsolete `supplier_products(product_id)` legacy unique index is not restored over valid many-to-one canonical mappings;
  - added manual match/detach/reject command foundation and audit-safe event metadata;
  - kept WooCommerce publication, WordPress sync, GAMIVO, Steam API calls, fuzzy matching, pricing and procurement out of scope.
- Implemented `KS-05-01` catalog synchronization and Germany eligibility foundation:
  - added supplier-neutral full, incremental and webhook-to-sync catalog orchestration;
  - added Germany eligibility policy `de-eligibility-v1` with fail-closed structured evidence handling;
  - added durable supplier product/offer state, offer-to-product mapping, sync runs and checkpoints;
  - added PostgreSQL migration/repository support and 50,000-product synthetic scale coverage;
  - stabilized supplier-offer/product mapping conflict diagnostics and aligned CI with `npm@11.6.2`;
  - kept WooCommerce publication, product grouping, search indexing, GAMIVO and live bulk supplier crawls out of scope.
- Added `KS-04-01b` Kinguin read-only integration verification:
  - added a fail-closed live read-only guard for Kinguin verification;
  - added a local opt-in verification command that never prints credentials or raw live payloads;
  - added guard tests for allowed read-only endpoints, blocked mutations, blocked order/key paths, host/path validation, redirect safety, and secret-safe output.
- Implemented `KS-04-01` Kinguin connector foundation:
  - added Kinguin-specific HTTP transport and supplier adapter behind supplier-neutral ports;
  - added documented product, offer, order, key, key-return, reference-data and webhook mapping;
  - hardened Kinguin health so undocumented numeric rate limits are omitted instead of represented as exhausted;
  - hardened Kinguin offer and purchase resolution to use explicit offer-to-product mappings without scanning the catalog during purchase;
  - added Secure KeyVault handoff for retrieved serial material without exposing keys in audit or queue metadata;
  - added synthetic Kinguin contract tests with no live HTTP, no credentials and no real product keys.
- Implemented `KS-03-02` multi-supplier routing foundation:
  - added supplier-neutral product-to-supplier-offer mapping and routing contracts;
  - added deterministic eligibility, ranking, currency-comparison and fallback-planning behavior;
  - hardened fallback planning so only terminal supplier failures can automatically progress to another supplier;
  - added routing observability and audit event vocabulary;
  - added multi-supplier routing tests without real supplier or network imports.
- Implemented `KS-03-01` supplier framework and MockSupplier foundation:
  - refined supplier-neutral capability and normalization contracts;
  - added SupplierRegistry, supplier-neutral errors, and observability contracts;
  - added deterministic offline MockSupplier with catalog, delta, purchase, reconciliation, key-handle, refund, health, rate-limit, and fault-injection behavior;
  - added scalable 50,000-product deterministic generated MockSupplier fixtures with broad region/product/offer scenario coverage;
  - added reusable supplier adapter contract tests and supplier framework documentation.
- Implemented `KS-02-04` secure audit service foundation:
  - added recursive secret-safe audit metadata validation and append validation;
  - added authorized read-only audit query service with bounded keyset pagination;
  - added PostgreSQL audit query repository and filter support indexes;
  - added audit-of-audit events for executed and denied audit queries;
  - added canary, authorization, pagination, append-only, and PostgreSQL integration coverage.
- Implemented `KS-02-03` secure product-key vault foundation:
  - added AES-256-GCM envelope encryption with per-record DEKs and nonce uniqueness;
  - bound vault ciphertext to canonical AES-GCM AAD containing purpose, version, order-line ID, and algorithm;
  - added KeyManagementProvider abstraction and development/test-only key provider;
  - added vault authorization boundary, secret-safe audit events, rewrap support, and PostgreSQL encrypted-key repository;
  - added canary leakage, tamper detection, authorization, and repository tests.
- Implemented `KS-02-02` queue, transactional outbox and reconciliation foundation:
  - added safe job envelope, payload validation/redaction, retry policy and observability hooks;
  - added Redis queue adapter behind the generic queue port using `redis@6.2.0`;
  - corrected Redis delivery to use explicit reserve, acknowledgment, failure requeue and stale in-flight recovery;
  - added PostgreSQL outbox/reconciliation repositories, transaction boundary, dispatcher and worker lifecycle;
  - added CI-backed PostgreSQL/Redis tests and queue/outbox/reconciliation documentation.
- Implemented `KS-02-01` PostgreSQL persistence foundation:
  - added reversible SQL migrations and a TypeScript migration runner using `pg@8.23.0`;
  - added initial durable schema foundations for supplier, catalog, region, commerce, workflow, encrypted key metadata, audit, idempotency, outbox, and reconciliation records;
  - added minimal PostgreSQL repository adapters and PostgreSQL integration tests for CI;
  - documented migration workflow, schema ownership, local PostgreSQL development, integration tests, and backup assumptions.
- Implemented `KS-01-02` core contract skeleton:
  - added supplier-neutral TypeScript domain/value types and port contracts;
  - added region, workflow state, audit, vault, supplier, storefront, queue, persistence, mail, invoice, monitoring, secret-management, and clock boundaries;
  - added contract and dependency-boundary tests proving fail-closed region defaults and forbidden adapter imports;
  - added `docs/core-contracts.md` and the KS-01-02 completion report.
- Implemented `KS-01-01` foundation bootstrap:
  - added repository tooling for Node.js/TypeScript, PHP/Composer validation, formatting, linting, type checking, tests, and secret scanning;
  - added local Docker Compose foundation for WordPress, WooCommerce skeleton, PostgreSQL, Redis, MariaDB for local WordPress, and Mailpit;
  - added environment example files, CI quality gates, local developer bootstrap documentation, and the KS-01-01 completion report.

## 1.0.2 - Specification hardening

- Added `docs/00-project-overview.md` as the authoritative project overview.
- Added dependency, approval, and acceptance-test documentation.
- Added ADRs for architecture, runtimes, persistence, Redis, secure key vault, workflow state machines, Germany compatibility, Kinguin integration boundary, audit events, approval gates, authorization, and outage behavior.
- Added executable task files for phases 01 through 12 using `KS-xx-xx` identifiers.
- Defined secure product-key vault requirements, idempotent state machines, Germany compatibility decision states, reason codes, revalidation triggers, human approval gates, authorization roles, outage behavior, tax/invoicing boundaries, refund/dispute ownership, and documentation/versioning policy.
- Cleaned README metadata and updated repository-wide agent Definition of Done.
- Added Specification Review #2 for v1.0.2.

## 1.0.1 - KeyPlanet / KeyCore bootstrap

- Renamed the internal platform to KeyCore.
- Defined KeyPlanet as the public customer-facing brand.
- Recorded `key-planet.de` as the initial domain.
- Recorded naming and namespace rules for the KeyPlanet / KeyCore bootstrap.
- Added `START_HERE.md` and the Sprint 1 execution plan.
- Marked the specification as ready for the initial Codex review and foundation tasks.

## 1.0.0 - 2026-08-07

- Initial Codex-ready specification.
- Added project constitution and repository-wide agent rules.
- Added target architecture and architecture decision records.
- Added requirements, security baseline and operating model.
- Added fully defined implementation tasks for phases 01-12.
