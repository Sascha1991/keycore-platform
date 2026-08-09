# KS-02-02: Queue, Transactional Outbox & Reconciliation Foundation

## Goal

Create the reliable asynchronous execution foundation that KeyCore will later use for catalog synchronization, procurement, fulfillment, email, invoicing, refunds and reconciliation.

This task establishes retry-safe infrastructure without implementing those later business workflows.

## Dependencies

- KS-01-01 completed and CI green
- KS-01-02 completed and CI green
- KS-02-01 completed and CI green
- ADR-0001 through ADR-0012
- Specification v1.0.2

## Scope

- Transactional outbox foundation using PostgreSQL `outbox_events`.
- Redis-backed queue adapter behind the existing queue port.
- Versioned generic job envelope with safe payload validation.
- Reusable retry policy.
- Reconciliation foundation using PostgreSQL `reconciliation_records`.
- Generic worker lifecycle infrastructure.
- Generic outbox dispatcher.
- Security guards for forbidden queue/outbox payload fields.
- Observability hooks for queue, retry, reconciliation, and outbox metrics.
- CI-backed PostgreSQL and Redis integration tests.

## Acceptance Criteria

- PostgreSQL remains the durable source of truth.
- Redis is used only for delivery/scheduling assistance and never as the only durable record of business intent.
- Durable outbox records can be created, claimed, published, retried, and escalated.
- Concurrent outbox claims are safe for multiple workers.
- Retry policy supports max attempts, exponential backoff, max delay, jitter, and retryable/non-retryable classification.
- Reconciliation records can be created, claimed, completed, failed, retried, and escalated to `MANUAL_REVIEW`.
- Redis queue adapter accepts only safe job envelopes.
- Redis queue delivery uses explicit reservation, acknowledgment, failure requeue, and stale in-flight recovery.
- Worker acknowledgment happens only after successful handler completion.
- Redis unavailable behavior leaves PostgreSQL outbox intent retryable.
- Worker lifecycle supports startup, graceful shutdown, health state, handler registration, error classification, structured safe logging hooks, and correlation propagation.
- Payload validation rejects forbidden sensitive top-level and nested fields.
- Core/domain remains independent of Redis/PostgreSQL clients.
- No real payment, supplier, procurement, fulfillment, email, invoice, pricing, Germany filtering, fraud, or production behavior is introduced.

## Required Tests

- Durable outbox record creation.
- Successful outbox claiming.
- Concurrent claim safety.
- Publication status transition.
- Retry scheduling.
- Maximum retry behavior.
- Exponential backoff.
- Reconciliation creation.
- Due reconciliation claiming.
- `MANUAL_REVIEW` escalation.
- Duplicate job/idempotency handling.
- Redis queue adapter contract.
- Redis unavailable behavior.
- Redis data-loss assumption does not delete PostgreSQL intent.
- Successful Redis reserve and acknowledgment.
- Failed handler requeue.
- Simulated worker crash recovery.
- Stale in-flight job recovery.
- Duplicate redelivery idempotency compatibility.
- Graceful shutdown preserves in-flight work.
- Worker graceful shutdown.
- Correlation ID propagation.
- Forbidden queue payload fields.
- Forbidden nested sensitive fields.
- No product key or secret logging.
- Core/domain remains independent of Redis/PostgreSQL clients.

## Forbidden Scope

- Kinguin.
- Another real supplier.
- Stripe.
- Actual payment processing.
- Actual procurement.
- Actual fulfillment.
- Product key encryption/decryption.
- Catalog synchronization.
- Germany filtering engine.
- Pricing engine.
- WooCommerce business integration.
- Customer emails.
- Invoices.
- Fraud logic.
- Production deployment.
- KS-02-03 or any later task.

## Risk Level

High.

## Human Approval Requirement

Review/merge required. No production approval required.
