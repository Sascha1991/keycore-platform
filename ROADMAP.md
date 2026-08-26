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

## Phase 10 – Monitoring and Operations

Dashboards, alerts, health checks, dead-letter queues, backup/restore, runbooks and emergency controls.

## Phase 11 – Staging and Acceptance

Load, security, recovery and end-to-end testing with synthetic and sandbox transactions.

## Phase 12 – Production Readiness

Legal and tax configuration gates, production credentials, controlled rollout, go-live checklist and post-launch review.
