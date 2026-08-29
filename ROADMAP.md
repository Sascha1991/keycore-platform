# Roadmap

## Phase 01 – Foundation

Repository, local environment, CI, conventions, secrets handling and mock service skeleton.

## Phase 02 – Platform Core

Domain model, persistence, migrations, queues, encryption, audit trail and shared error model.

## Phase 03 – Supplier Framework

Supplier adapter contract, offer normalization, capabilities, mock supplier and contract tests.

KS-03-02 extends this phase with supplier-neutral multi-supplier routing, deterministic candidate ranking and safe fallback planning. Real supplier connector work remains in Phase 04.

## Phase 04 – Kinguin Connector

Authentication, catalog retrieval, offer retrieval, ordering, status polling/webhooks, key retrieval and refunds based on actual API documentation.

## Phase 05 – Catalog

Full import, incremental synchronization, Germany filtering, product grouping, WooCommerce publication and search indexing.

## Phase 06 – Pricing

Fees, VAT-aware calculations, target margin, minimum profit, rounding, price locks and profitability safeguards.

## Phase 07 – Checkout and Orders

Stripe, risk state, idempotent order orchestration, supplier procurement, fulfillment, invoice trigger and refunds.

KS-07-04 adds the secure key retrieval and fulfillment foundation after
confirmed procurement, while production customer delivery remains disabled.

## Phase 08 – Customer Account

Registration, order history, secure key vault, invoices, activation instructions and access auditing.

KS-08-01 adds the backend account read-model foundation for account summary,
owned order history, safe key-vault metadata, invoice metadata, activation
instruction metadata and access auditing while leaving production login,
frontend, real key reveal, invoice generation and guest claim flow disabled.

KS-08-02 adds the registration, email verification challenge, verified external
identity linking and fail-closed guest-order claim foundation while leaving
production email delivery, login provider, frontend, automatic login, account
merge and production guest claim flow disabled.

KS-08-03 adds the transport-neutral customer account API and future
WooCommerce/KeyRaNo integration contract for account summary, owned order
history/detail, registration, email verification and identity linking while
leaving production HTTP, WordPress/WooCommerce installation, frontend, real
login provider and real key reveal disabled.

KS-08-04 adds the secure customer key access application integration, connecting
account key-vault metadata to the existing KS-07 secure delivery boundary with
explicit prepare/execute actions while leaving production HTTP, WooCommerce,
frontend, real key reveal, Kinguin retrieval and live Stripe mutation disabled.

KS-08-05 adds the account-required guest order claim foundation with hash-only
one-time Kaufcode credentials, purchase-time checkout email snapshots,
authenticated verified-account claim checks, immutable order ownership binding
and a transport-neutral claim handler while leaving production guest claim
email, production HTTP, WooCommerce, frontend and real key reveal disabled.

KS-08-06 adds explicit customer invoice metadata access and curated activation
instruction services plus transport-neutral read handlers for authenticated
owned orders while leaving production invoice generation, PDF rendering,
tax/legal accounting integration, WooCommerce/frontend exposure and real key
reveal disabled.

With KS-08-01 through KS-08-06, Phase 08 backend/application foundation scope is
complete for registration, order history, secure key-vault metadata, invoices,
activation instructions and access auditing. Production login providers,
customer account UI, WooCommerce integration, production customer HTTP,
production invoice generation/storage, production activation-content approval,
email delivery, distributed rate limiting and real key reveal remain future
production/integration work.

## Phase 09 – Fraud and Support

Risk rules, manual review, velocity limits, dispute evidence, support tickets and supplier claim workflow.

KS-09-01 adds deterministic fraud risk evaluation, policy-versioned persisted
risk decisions, fact-fingerprint idempotency, a durable fraud manual-review
case foundation, trusted review authority boundary and a fail-closed downstream
fraud-clearance guard while leaving velocity limits, dispute evidence, support
tickets, supplier claim workflow, production operator UI and external fraud
providers for later Phase 09 tasks.

KS-09-02 adds durable server-authoritative fraud velocity signals,
pseudonymous checkout-email correlation, deterministic windowed count/amount
rules, `KS09_POLICY_V2` fact fingerprints and fail-closed stale-clearance
behavior while leaving production velocity policy approval, dispute evidence,
support tickets, supplier claim workflow, production operator UI and external
fraud providers for later Phase 09 tasks.

KS-09-03 adds a provider-neutral dispute evidence snapshot foundation with
authoritative persisted fact sourcing, mandatory order/payment sections,
explicit optional absence/ambiguity, deterministic fingerprints, immutable
finalized snapshots, exact-order-bound export and fail-closed trusted authority
gates while leaving Stripe dispute submission, support tickets, supplier claim
workflow and production operator UI for later Phase 09 tasks.

KS-09-04 adds a provider-neutral Support Case foundation with authenticated
customer-owned order support, account-only customer cases, fail-closed trusted
operator actions, structured messages/internal notes, exact-order dispute/fraud/
fulfillment reference links, append-only history and PostgreSQL migration 023
while leaving production helpdesk integration, email, UI, refunds, supplier
claims, Stripe/Kinguin mutations and product-key reveal out of scope.

KS-09-05 adds the provider-neutral Supplier Claim workflow with trusted
operator/system authority, exact-order support/procurement/fulfillment/evidence
binding, structured reported-problem categories, durable idempotency,
optimistic concurrency, append-only history and a separate fail-closed external
submission operation while leaving production supplier adapters, Kinguin claim
or key-return mutations, Stripe refunds, replacement fulfillment, operator UI
and production supplier-claim policy disabled.

With KS-09-01 through KS-09-05, Phase 09 backend/application foundation scope
is complete. Production operator authority and UI, real supplier claim APIs,
supplier-specific claim policy, production refund/replacement integrations,
retention and operational controls remain future production/integration work.

## Phase 10 – Monitoring and Operations

Dashboards, alerts, health checks, dead-letter queues, backup/restore, runbooks and emergency controls.

KS-10-01 consolidates the Phase 10 operational foundation: safe aggregate
metrics and dashboard specification, omission-first structured telemetry,
role-aware health/readiness, runbook-linked alert definitions, payload-free
dead-letter handling, durable PostgreSQL emergency controls, encrypted-only
backup/isolated-restore validation and incident runbooks. Production exporters,
dashboards, alert delivery, authority/UI, backup storage/scheduling and restore
drill approval remain production-readiness integration work.

KS-10-02 closes the remaining historical Phase-10 repository gaps with
field-specific logging allowlists, validated critical-runbook ownership and
fallback coverage, a real checkout deny gate, a precise global-commerce deny
gate, migration 026 and a deterministic synthetic PostgreSQL restore drill.
Category pause and a negative-margin order metric remain intentionally absent
until authoritative category and historical commercial snapshots exist.

With KS-10-01 and KS-10-02, Phase 10 is closed at the foundation/repository
level. Production exporters, dashboards, paging, operations UI/authority,
backup storage/scheduling and an approved production restore drill remain Phase
12 integration and human-approval work. The next work after KS-10-02 is the
detailed Phase-11 acceptance sequence. The repository's consolidated KS-11-01
validation task remains an umbrella and is not treated as one completed
detailed task.

## Phase 11 – Staging and Acceptance

Load, security, recovery and end-to-end testing with synthetic and sandbox transactions.

Phase 11 is tracked in `docs/phase-11-acceptance-matrix.md` as seven distinct
checkpoints. KS-11-01 staging and KS-11-02 deterministic E2E acceptance are
complete and merged. KS-11-03 implements the release-blocking 50k PostgreSQL
catalog import, refresh, replay and publication validation and is pending review
and merge. KS-11-04 order concurrency, KS-11-05 security assessment, KS-11-06
recovery exercise and KS-11-07 owner UAT remain not started. Phase 11 is not
complete and `SECURITY-READINESS` remains unapproved.

## Phase 12 – Production Readiness

Legal and tax configuration gates, production credentials, controlled rollout, go-live checklist and post-launch review.

For Phases 11 and 12, consolidated repository tasks do not supersede detailed
approved acceptance tasks. Every criterion must be evidenced, explicitly
deferred to a named task for a valid dependency reason, or superseded by a
documented stronger implementation. Human approvals are never inferred from
code or tests.
