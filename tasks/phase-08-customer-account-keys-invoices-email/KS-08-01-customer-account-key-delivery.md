# KS-08-01: Customer Account, Keys, Invoices, and Email

## Goal

Provide authorized customer access to order history, secure key reveal, invoices, activation instructions, and email notifications.

## Dependencies

- KS-07-01
- ADR-0005
- ADR-0011

## Scope

- Customer identity mapping.
- Key vault reveal flow.
- Order-line ownership checks.
- Invoice access.
- Mail notification workflow.
- Key access auditing.

## Forbidden Scope

- Storing plaintext keys in WooCommerce metadata, logs, traces, queues, caches, analytics, exceptions, snapshots, or backups.
- Cross-customer key access.

## Deliverables

- Customer account workflows.
- Secure key reveal flow.
- Invoice and email integration boundaries.
- Audit events for key reveals.

## Acceptance Criteria

- Authorization is checked immediately before decryption.
- Cross-customer access is denied.
- Reveals are audited without logging keys.

## Required Tests

- Authorization tests.
- Cross-customer denial E2E tests.
- Canary leakage tests.
- Mail outage tests.

## Risk Level

Critical.

## Human Approval Requirement

`TAX-INVOICE` required before production invoice behavior.
