# Changelog

## Unreleased

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
