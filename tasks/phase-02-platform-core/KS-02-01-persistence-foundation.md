# KS-02-01: PostgreSQL Persistence Foundation

## Goal

Create KeyCore's durable PostgreSQL persistence foundation, schema/migration infrastructure and supplier-neutral repository adapters without implementing later business workflows.

## Dependencies

- KS-01-01 completed and CI green
- KS-01-02 completed and CI green
- ADR-0001 through ADR-0012
- Specification v1.0.2

## Scope

- Add PostgreSQL migration infrastructure suitable for the Node.js/TypeScript architecture.
- Create versioned, reversible migrations for the initial durable KeyCore schema.
- Keep PostgreSQL as KeyCore's system of record for platform state.
- Keep WordPress/WooCommerce tables outside KeyCore primary persistence.
- Implement only minimum infrastructure repository adapters needed to prove the persistence architecture.
- Add PostgreSQL integration-test setup for CI.
- Document persistence architecture, schema ownership, migration workflow, local development, integration tests, and backup assumptions.

## Initial Data Model

Create durable schema foundations for:

- suppliers
- supplier_products
- supplier_offers
- products
- offers
- region_evidence
- region_decisions
- price_snapshots
- customers
- commerce_orders
- commerce_order_lines
- payment_records
- procurement_records
- fulfillment_records
- refund_records
- encrypted_key_records
- audit_events
- idempotency_records
- outbox_events
- reconciliation_records

## Acceptance Criteria

- Versioned migrations apply to an empty PostgreSQL database.
- Migrations are reversible.
- Required tables exist after migration.
- Foreign-key integrity is enforced where appropriate.
- Critical uniqueness constraints are present.
- Duplicate payment provider event IDs are rejected.
- Duplicate supplier purchase/idempotency references are rejected.
- Invalid Germany compatibility decisions are rejected.
- Monetary values use integer minor units plus currency.
- Historical price/payment snapshots can be retained.
- `encrypted_key_records` has no plaintext/raw/decrypted/unencrypted key columns.
- Audit records cannot contain a product-key field.
- Commerce order lines have immutable UUID identifiers suitable as future idempotency roots.
- Transactional outbox and reconciliation foundations exist.
- Core/domain packages do not import PostgreSQL clients.
- No database credentials, production connection strings, real customer data, real supplier data, real product keys, or payment credentials are committed.

## Required Tests

- Migration apply test against PostgreSQL.
- Required table existence test.
- Foreign-key integrity test.
- Critical unique constraint tests.
- Duplicate payment provider event ID rejection test.
- Duplicate supplier purchase/client reference rejection test.
- Invalid Germany compatibility decision rejection test.
- Integer minor-unit money storage test.
- Encrypted key table plaintext-column absence test.
- Audit metadata product-key rejection test.
- Order-line UUID existence test.
- Rollback or migration failure behavior test where safely practical.
- Boundary test proving core/domain still imports no PostgreSQL client.
- Existing formatting, lint, TypeScript, Vitest, secret scan, PHP/Composer validation, and Docker Compose validation gates.

## Forbidden Scope

- Redis workers or queues.
- KeyVault encryption/decryption.
- Kinguin.
- Another real supplier.
- Stripe.
- Payment execution.
- Procurement execution.
- Catalog synchronization.
- Pricing engine.
- Germany filtering engine.
- WooCommerce business integration.
- Emails.
- Invoices.
- Fraud rules.
- Production deployment.
- KS-02-02 or any later task.

## Risk Level

High.

## Human Approval Requirement

Human review/merge required. No production approval required.
