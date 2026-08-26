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
WooCommerce/Keyrano integration contract for account summary, owned order
history/detail, registration, email verification and identity linking while
leaving production HTTP, WordPress/WooCommerce installation, frontend, real
login provider and real key reveal disabled.

## Phase 09 – Fraud and Support

Risk rules, manual review, velocity limits, dispute evidence, support tickets and supplier claim workflow.

## Phase 10 – Monitoring and Operations

Dashboards, alerts, health checks, dead-letter queues, backup/restore, runbooks and emergency controls.

## Phase 11 – Staging and Acceptance

Load, security, recovery and end-to-end testing with synthetic and sandbox transactions.

## Phase 12 – Production Readiness

Legal and tax configuration gates, production credentials, controlled rollout, go-live checklist and post-launch review.
