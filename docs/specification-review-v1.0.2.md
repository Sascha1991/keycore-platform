# Specification Review v1.0.2

Reviewed sources:

- `PROJECT_CONSTITUTION.md`
- `AGENTS.md`
- `README.md`
- `ROADMAP.md`
- `START_HERE.md`
- `docs/00-project-overview.md`
- `docs/dependency-matrix.md`
- `docs/acceptance-test-matrix.md`
- `docs/approvals/README.md`
- all ADR files under `decisions/architecture-decisions/`
- all task files under `tasks/`
- `CHANGELOG.md`

No production or application implementation code was reviewed or introduced.

## Review Against Specification Review v1.0 Findings

### Required project overview and ADR files are missing

Status: RESOLVED

`docs/00-project-overview.md` now exists, and ADRs were added under `decisions/architecture-decisions/` for the required architectural areas.

### Secure key storage is mandated but not specified

Status: RESOLVED

The secure key vault is specified in `docs/00-project-overview.md`, ADR-0005, and the acceptance-test matrix. The specification covers envelope encryption, authenticated encryption, unique data encryption keys, external master-key storage, process-memory-only plaintext, prohibited storage locations, rotation, backup/restore behavior, authorization before decryption, reveal auditing, and canary leakage tests.

### Payment and procurement idempotency is required but lacks a state model

Status: RESOLVED

Payment, procurement, fulfillment, and refund state machines are defined in `docs/00-project-overview.md` and ADR-0006. The specification defines order-line UUID idempotency roots, provider event uniqueness, supplier purchase deduplication, webhook replay safety, reconciliation after ambiguous supplier timeout, no procurement from unconfirmed payment, durable reconciliation jobs, and `MANUAL_REVIEW` escalation.

### Germany compatibility gating is underspecified

Status: RESOLVED

The Germany compatibility engine now defines exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`, with only `ALLOWED` publishable or sellable. It covers DE, EU, Global, Region Free, incompatible regions, VPN activation, foreign-account requirements, missing evidence, contradictory evidence, unknown values, reason codes, blocking precedence, free-text title limits, and revalidation triggers.

### Human approval gates are unclear

Status: RESOLVED

ADR-0010 and `docs/approvals/README.md` define the required gates, approval artifact location, approval fields, and the rule that agents cannot approve their own gates.

### External dependencies are listed but not acceptance-bound

Status: PARTIALLY_RESOLVED

`docs/dependency-matrix.md` now separates local, CI, staging, and production dependencies and identifies required phases and approval constraints. Some exact versions remain intentionally unpinned for WordPress, WooCommerce, mail, invoice, and monitoring until implementation choices are made.

### Supplier API dependency is deferred without an explicit contract boundary

Status: RESOLVED

ADR-0008 and `docs/00-project-overview.md` define the Kinguin no-guess rule and require MockSupplier plus `REAL-SUPPLIER` approval before non-mock ordering.

### Auditability requirements lack event schema and retention policy

Status: PARTIALLY_RESOLVED

ADR-0009 defines the audit event schema and forbidden fields. The overview and test matrix require secret-free auditability. Exact retention periods and storage immutability controls are still deferred until production operations decisions are made.

### README status metadata is contradictory and duplicated

Status: RESOLVED

README metadata is cleaned and now identifies specification version `1.0.2`, KeyPlanet, `key-planet.de`, KeyCore, and `keycore-platform` once.

### Repository claims Sprint 1 readiness without visible task files

Status: RESOLVED

Executable phase task files now exist under `tasks/` using `KS-xx-xx` identifiers. `START_HERE.md` and README point to `KS-01-01`.

### Acceptance tests are required but not enumerated

Status: RESOLVED

`docs/acceptance-test-matrix.md` maps constitutional requirements to unit, integration, supplier contract, E2E, and security tests and marks critical business rules as release-blocking.

### Authorization requirements are too broad for implementation

Status: RESOLVED

`docs/00-project-overview.md` and ADR-0011 define roles, customer identity and order-line ownership checks, least-privilege expectations, support constraints, and cross-customer denial.

### Partial outage safety lacks concrete degradation behavior

Status: RESOLVED

`docs/00-project-overview.md` and ADR-0012 define supplier, payment, mail, invoice, Redis/queue, PostgreSQL, and WooCommerce synchronization outage behavior, including fail-closed unsafe mutations.

### Refund and dispute workflow is phase-split without boundary rules

Status: RESOLVED

`docs/00-project-overview.md` assigns Phase 04 to supplier capability, Phase 07 to durable refund orchestration and payment-provider execution, and Phase 09 to support, fraud, supplier claims, and dispute evidence.

### Invoice and tax requirements are not defined

Status: RESOLVED

`docs/00-project-overview.md`, `docs/dependency-matrix.md`, and the relevant tasks define the tax/invoicing boundary and require `TAX-INVOICE` approval based on professionally validated configuration before production sales.

### Documentation update requirement lacks scope

Status: RESOLVED

`docs/00-project-overview.md`, AGENTS, README, task files, and CHANGELOG now define documentation and versioning expectations for requirement and behavior changes.

### Region failure terminology is not fully consistent

Status: RESOLVED

The specification now defines canonical region decisions and explicitly states that `REVIEW_REQUIRED`, `BLOCKED`, and `DISABLED` are fail-closed and not publishable.

### Preferred technology choices are not backed by ADRs

Status: RESOLVED

ADRs now cover ports-and-adapters architecture, PHP/Node runtimes, PostgreSQL, Redis, WooCommerce-facing boundaries, and supplier adapter boundaries.

### Changelog and versioning responsibilities are not connected to the definition of done

Status: RESOLVED

AGENTS now requires documentation, changelog, and specification-version updates where applicable. CHANGELOG contains a v1.0.2 entry.

## Fresh Review of v1.0.2

### MEDIUM: Exact non-core dependency versions are still deferred

The dependency matrix pins PHP, Node.js, PostgreSQL, and Redis, but WordPress, WooCommerce, mail provider, invoice component, and monitoring versions/providers remain unspecified. This is acceptable for specification hardening but must be resolved before implementation tasks that depend on those systems are marked complete.

Recommended resolution: require the relevant implementation tasks to pin exact dependency versions or provider choices before completion.

### LOW: Task granularity is executable but coarse

Each development phase now has an executable task file, satisfying the phase-order requirement. Several phases remain broad enough that later breakdown into smaller `KS-xx-02` tasks will likely be needed for reviewable implementation pull requests.

Recommended resolution: split large phase tasks during planning before implementation begins.
