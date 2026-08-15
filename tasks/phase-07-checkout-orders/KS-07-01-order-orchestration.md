# KS-07-01 - Checkout & Order Orchestration Foundation

Risk: CRITICAL

Human approval: Review/merge required.

## Scope

Create KeyCore's internal order state machine and orchestration boundary. KeyCore is the source of truth for order lifecycle, price-lock ownership, payment state, procurement state, fulfillment state, refund state, risk state and reconciliation state.

This task must not implement real Stripe, live supplier purchase, product-key retrieval, real fulfillment, invoices, live refunds, WooCommerce order authority or KS-07-02.

## Acceptance Criteria

- Internal `KeyCoreOrder` model has explicit top-level states and sub-states.
- Order creation requires a valid safe `PriceLock`.
- Customer amount and currency are copied from the authoritative lock and cannot be overridden.
- Quantity is limited to `1` and unsupported quantities fail closed.
- Creating an order atomically claims exactly one single-use price lock.
- Idempotent order creation returns the same logical order for the same key and same commercial input.
- Conflicting idempotency reuse returns a stable fail-closed reason code.
- PostgreSQL prevents two orders from owning the same price lock.
- Commercial fields are immutable after creation.
- Procurement cannot start without captured payment and approved risk state.
- Ambiguous procurement moves to manual review/reconciliation and does not trigger supplier fallback.
- External event receipts are deduplicated by provider, external event ID and event type.
- Duplicate refund requests are concurrency-safe.
- Transitions use expected record versions and return explicit optimistic conflicts.
- Transition history, safe audit events and transactional outbox events are recorded.
- No product keys, payment credentials, card data, supplier credentials, raw provider payloads or supplier cost are stored in orders, history, audit or outbox payloads.
- Reversible migration exists and passes up/down validation.
- Unit, PostgreSQL integration, concurrency, invariant and 50k scale tests cover the task boundaries.

## Current Limitations

- Quantity is `1` only.
- Payment, procurement, fulfillment and refund execution are modeled but mocked/future-boundary only.
- Stripe webhooks and Kinguin order endpoints are not called.
- Invoice creation and customer key delivery remain later phases.
