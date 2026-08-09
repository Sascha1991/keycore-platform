# Changelog

## Unreleased

- Implemented `KS-02-03` secure product-key vault foundation:
  - added AES-256-GCM envelope encryption with per-record DEKs and nonce uniqueness;
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
