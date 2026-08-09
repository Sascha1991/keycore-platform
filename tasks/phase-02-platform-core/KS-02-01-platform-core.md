# KS-02-01: Platform Core

## Goal

Define and implement the core domain model, persistence boundaries, migrations, idempotency records, audit events, and shared error model.

## Dependencies

- KS-01-01
- ADR-0003
- ADR-0006
- ADR-0009

## Scope

- Generic entities for catalog, offers, order lines, payments, procurement, fulfillment, refunds, audit, approvals, and authorization references.
- Reversible migrations.
- Idempotency and provider-event uniqueness rules.

## Forbidden Scope

- Supplier-specific API behavior.
- Live payment provider calls.
- Product-key plaintext persistence.

## Deliverables

- Core data model.
- Reversible migrations.
- Audit event schema.
- Idempotency storage model.

## Acceptance Criteria

- Database constraints enforce uniqueness for order-line UUIDs and provider events where applicable.
- Migrations roll forward and back.
- Audit schema excludes forbidden secret fields.

## Required Tests

- Unit tests for state guards.
- Migration forward/rollback tests.
- Audit payload validation tests.

## Risk Level

High.

## Human Approval Requirement

None unless schema decisions change production approval/audit policy.
