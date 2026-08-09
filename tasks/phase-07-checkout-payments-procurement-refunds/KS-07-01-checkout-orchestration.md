# KS-07-01: Checkout, Payments, Procurement, and Refunds

## Goal

Create durable checkout orchestration that captures payment, procures supplier keys, fulfills orders, and handles refunds safely.

## Dependencies

- KS-02-01
- KS-05-01
- KS-06-01
- ADR-0006
- `LIVE-PAYMENTS` before live payment capture

## Scope

- Stripe sandbox integration.
- Payment, procurement, fulfillment, and refund state machines.
- Idempotency root based on immutable order-line UUID.
- Webhook replay safety.
- Durable reconciliation jobs.
- Payment-provider refund execution.

## Forbidden Scope

- Procurement from unconfirmed payment.
- Blind supplier purchase retry after ambiguous timeout.
- Live payments without approval.
- Real supplier ordering without approval.

## Deliverables

- Checkout orchestration.
- Payment/refund handlers.
- Procurement/fulfillment workflow.
- Reconciliation jobs.

## Acceptance Criteria

- Webhook replay does not double charge or double fulfill.
- Ambiguous supplier timeouts enter reconciliation before retry.
- Ambiguous states eventually enter `MANUAL_REVIEW`.

## Required Tests

- Unit state-machine tests.
- Integration retry/replay tests.
- E2E sandbox checkout tests.
- Security redaction tests.

## Risk Level

Critical.

## Human Approval Requirement

`LIVE-PAYMENTS`, `REAL-SUPPLIER`, and `TAX-INVOICE` as applicable.
