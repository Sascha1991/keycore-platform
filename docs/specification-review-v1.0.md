# Specification Review v1.0

Reviewed sources:

- `PROJECT_CONSTITUTION.md`
- `AGENTS.md`
- `README.md`
- `ROADMAP.md`

Requested but not present on `main` during this review:

- `docs/00-project-overview.md`
- ADR files / `decisions/architecture-decisions/`

No implementation code was reviewed or proposed in this document.

## Findings

### Critical: Required project overview and ADR files are missing

The README instructs agents to read `docs/00-project-overview.md` and review ADRs in `decisions/architecture-decisions/`, but neither the `docs/` directory nor any ADR files are present. This makes the specification internally incomplete and prevents validation of architecture, dependencies, approval gates, and phase boundaries.

Required resolution: add the project overview and ADR set before implementation work begins, or update the README and AGENTS instructions to reflect the actual source of architectural authority.

### Critical: Secure key storage is mandated but not specified

The constitution requires product keys to be encrypted at rest and never exposed in logs, traces, analytics, exceptions, or snapshots. The roadmap mentions encryption and a secure key vault, but the specification does not define key management, encryption boundaries, key rotation, envelope encryption, access patterns, redaction strategy, backup handling, or emergency recovery behavior.

Required resolution: define the secure key storage architecture, including cryptographic approach, secret ownership, runtime access controls, redaction requirements, backup/restore handling, and acceptance tests for non-disclosure.

### Critical: Payment and procurement idempotency is required but lacks a state model

The constitution requires payment, procurement, refund, retry, race-condition, webhook-replay, and ambiguous-timeout safety. The roadmap lists these areas, but there is no explicit order state machine, idempotency key strategy, supplier purchase deduplication model, webhook replay policy, or timeout reconciliation flow.

Required resolution: define the order/procurement/refund state machine and idempotency contract before implementing checkout, supplier ordering, fulfillment, or refunds.

### High: Germany compatibility gating is underspecified

The specification requires publishing only offers verifiably usable in Germany and says unknown, contradictory, or incomplete region data must fail closed. It does not define accepted supplier region fields, evidence requirements, conflict precedence, manual review states, audit reason codes, or how Germany compatibility is revalidated after catalog updates.

Required resolution: define the Germany compatibility decision matrix, required supplier evidence, reason codes, review states, recheck triggers, and acceptance tests for unknown, contradictory, and incomplete region data.

### High: Human approval gates are unclear

The constitution says production deployment requires human approval and no agent may deploy directly to production. It also says VPN-dependent activation offers must not be sold unless approved by a future policy change. The README adds that production integrations must not start before required approval gates are complete. None of these gates identify the approver role, approval artifact, required evidence, expiration, or audit location.

Required resolution: define each approval gate, approver role, required evidence, storage location, and whether approval is one-time, per-release, per-supplier, or per-offer.

### High: External dependencies are listed but not acceptance-bound

The roadmap depends on WordPress, WooCommerce, PostgreSQL, Redis, Stripe, mail delivery, invoice generation, monitoring, and supplier APIs. The specification does not define versions, hosting assumptions, required plugins/libraries, compatibility constraints, local development dependencies, sandbox requirements, or operational ownership for those systems.

Required resolution: add a dependency matrix covering required versions, environments, credentials, sandbox/prod separation, failure behavior, and phase in which each dependency becomes mandatory.

### High: Supplier API dependency is deferred without an explicit contract boundary

The README says the final Kinguin connector must be implemented against current private API documentation and credentials, while the roadmap places Kinguin authentication, catalog retrieval, ordering, status polling/webhooks, key retrieval, and refunds in Phase 04. The specification does not define what must be blocked until private documentation exists, what can be mocked, or what contract tests must prove before real integration begins.

Required resolution: create an ADR or integration policy that separates mockable supplier behavior from documentation-dependent behavior and defines a no-go gate for real Kinguin integration.

### High: Auditability requirements lack event schema and retention policy

The constitution requires security and financial events to be auditable without exposing secrets. The roadmap mentions audit trail, support, disputes, operations, and monitoring, but there is no event taxonomy, retention policy, actor model, immutable log requirement, correlation ID strategy, or privacy minimization rule for audit events.

Required resolution: define audit event classes, required fields, forbidden fields, retention periods, access controls, and acceptance tests for financial, security, admin, and key-access events.

### Medium: README status metadata is contradictory and duplicated

The README status line contains `Specification version: 1.0.1 (Sprint 1 bootstrap).1 (Sprint 1 bootstrap)`, and the public brand, domain, and internal platform entries are duplicated. This creates ambiguity about the authoritative version and whether the document has been accidentally merged or edited twice.

Required resolution: clean up duplicate status metadata and define a single authoritative specification version.

### Medium: Repository claims Sprint 1 readiness without visible task files

The README says implementation status is `Sprint 1 ready` and instructs agents to execute task files in numerical phase order, but no task files are present in the repository. This makes phase execution impossible to verify and creates a risk that agents invent work from the roadmap.

Required resolution: add task files for Phase 01 or revise the status to indicate that task decomposition is still pending.

### Medium: Acceptance tests are required but not enumerated

The constitution requires automated tests for every critical business rule, and AGENTS requires tests for every changed business rule. The specification does not provide a business-rule test matrix for key secrecy, Germany compatibility, idempotency, authorization, audit safety, outage behavior, migrations, or production-gate enforcement.

Required resolution: add an acceptance test matrix mapping each constitutional rule to required unit, integration, contract, end-to-end, and security tests.

### Medium: Authorization requirements are too broad for implementation

The constitution requires customer key access to be authorized against owning order and customer identity, and administrative access to use least privilege. The specification does not define roles, permissions, session model, WooCommerce account mapping, support impersonation policy, admin audit requirements, or denial behavior.

Required resolution: define customer and admin authorization models, including role permissions, support workflows, identity binding, and tests for cross-customer access denial.

### Medium: Partial outage safety lacks concrete degradation behavior

The constitution requires safe operation during partial supplier, payment, or mail outages. The roadmap lists queues, locks, dead-letter queues, monitoring, and emergency controls, but no outage policy defines what customers see, whether checkout is blocked, when retries occur, how orders are reconciled, or when manual intervention is required.

Required resolution: define outage playbooks and product behavior for supplier, payment, invoice, mail, database, queue, and WooCommerce synchronization failures.

### Medium: Refund and dispute workflow is phase-split without boundary rules

Refund operations appear in the constitution, Phase 04 supplier connector, Phase 07 checkout/orders, and Phase 09 fraud/support. The specification does not define which phase owns refund initiation, supplier claim coordination, Stripe refund execution, customer communication, or dispute evidence generation.

Required resolution: define refund and dispute ownership by phase, including minimum safe behavior before later support tooling exists.

### Medium: Invoice and tax requirements are not defined

The primary goal includes invoices, and the roadmap includes VAT-aware calculations and invoice triggers. The specification does not define invoice provider, legal/tax configuration, VAT evidence, German compliance requirements, correction invoices, cancellation invoices, or approval gates before production billing.

Required resolution: add a legal/tax/invoicing specification and identify which decisions require human or professional approval.

### Medium: Documentation update requirement lacks scope

The constitution requires documentation for every externally visible behavior change, and AGENTS repeats this as part of required checks. The repository does not define which documents must be updated for API changes, customer-facing changes, admin behavior, operational runbooks, or supplier behavior.

Required resolution: define documentation ownership and required document updates by change type.

### Low: Region failure terminology is not fully consistent

The constitution says unknown, contradictory, or incomplete region data must `fail closed`. AGENTS says unknown region data must result in `REVIEW_REQUIRED` or `BLOCKED`, never `ALLOWED`. This can be consistent if both states prevent publication, but the specification does not explicitly say whether `REVIEW_REQUIRED` is a closed/non-sellable state.

Required resolution: define canonical region decision states and explicitly mark which states permit publication.

### Low: Preferred technology choices are not backed by ADRs

AGENTS names PHP 8.3+, Node.js 22 LTS, PostgreSQL, Redis, REST or event-driven contracts, and ports-and-adapters architecture. These may be reasonable choices, but without ADRs there is no recorded decision rationale, tradeoff, or replacement process.

Required resolution: add ADRs for runtime, persistence, queue/cache, architecture style, WooCommerce integration, and supplier adapter boundaries.

### Low: Changelog and versioning responsibilities are not connected to the definition of done

The repository contains a changelog, and the README has a specification version, but AGENTS does not require changelog updates or define when spec version changes are required. This can lead to externally visible behavior or requirement changes without traceable version updates.

Required resolution: add changelog and specification-version rules to the definition of done for requirement or behavior changes.
