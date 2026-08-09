# ADR-0006: Order, Payment, Procurement, Fulfillment, and Refund State Machines

Status: Accepted

## Decision

KeyCore uses explicit state machines for payment, procurement, fulfillment, and refund workflows. The immutable internal order-line UUID is the idempotency root.

## Requirements

- Provider event IDs must be unique and replay-safe.
- Supplier purchases must be deduplicated.
- Webhook replays must be safe.
- Ambiguous supplier timeouts must reconcile before another purchase attempt.
- Procurement may not start from unconfirmed payment.
- Durable reconciliation jobs must resolve retryable and ambiguous states.
- Ambiguous states eventually enter `MANUAL_REVIEW` when automation cannot decide safely.
