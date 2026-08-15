# Checkout and Order Orchestration Foundation

KS-07-01 establishes KeyCore's internal order source of truth. WooCommerce, Stripe and suppliers provide future evidence and projections, but they do not own the business order lifecycle.

## Source of Truth

KeyCore owns:

- `OrderId`;
- lifecycle state;
- `PriceLockId` relationship;
- customer amount and currency;
- payment, procurement, fulfillment, risk and refund sub-states;
- record version, correlation ID and idempotency key.

Orders do not store supplier credentials, payment credentials, card data, raw provider payloads, supplier cost or product keys.

## State Machine

Top-level order states are:

- `CREATED`
- `AWAITING_PAYMENT`
- `PAYMENT_AUTHORIZED`
- `PAYMENT_CAPTURED`
- `PROCUREMENT_PENDING`
- `PROCUREMENT_IN_PROGRESS`
- `FULFILLMENT_PENDING`
- `COMPLETED`
- `CANCELLED`
- `FAILED`
- `REFUND_PENDING`
- `REFUNDED`
- `MANUAL_REVIEW`

Allowed transitions:

```text
CREATED -> AWAITING_PAYMENT | MANUAL_REVIEW
AWAITING_PAYMENT -> PAYMENT_AUTHORIZED | CANCELLED | FAILED
PAYMENT_AUTHORIZED -> PAYMENT_CAPTURED | CANCELLED | MANUAL_REVIEW
PAYMENT_CAPTURED -> PROCUREMENT_PENDING | MANUAL_REVIEW
PROCUREMENT_PENDING -> PROCUREMENT_IN_PROGRESS | MANUAL_REVIEW
PROCUREMENT_IN_PROGRESS -> FULFILLMENT_PENDING | MANUAL_REVIEW | FAILED
FULFILLMENT_PENDING -> COMPLETED | MANUAL_REVIEW
COMPLETED -> REFUND_PENDING
REFUND_PENDING -> REFUNDED | MANUAL_REVIEW
FAILED -> MANUAL_REVIEW
```

Invalid transitions fail closed with `INVALID_ORDER_TRANSITION`.

## Sub-States

Payment states:

- `NOT_STARTED`
- `PENDING`
- `AUTHORIZED`
- `CAPTURED`
- `FAILED`
- `CANCELLED`
- `REFUNDED`
- `PARTIALLY_REFUNDED`

Procurement states:

- `NOT_STARTED`
- `PENDING`
- `IN_PROGRESS`
- `SUCCEEDED`
- `FAILED_RETRYABLE`
- `FAILED_TERMINAL`
- `AMBIGUOUS`

Fulfillment states:

- `NOT_STARTED`
- `PENDING`
- `SUCCEEDED`
- `FAILED`
- `MANUAL_REVIEW`

Risk states:

- `NOT_EVALUATED`
- `APPROVED`
- `REVIEW_REQUIRED`
- `REJECTED`

Refund states:

- `NOT_REQUESTED`
- `PENDING`
- `SUCCEEDED`
- `FAILED`
- `MANUAL_REVIEW`

The invariant for active procurement is:

```text
procurementStatus in (PENDING, IN_PROGRESS)
=> paymentStatus = CAPTURED and riskStatus = APPROVED
```

## Price-Lock Ownership

Order creation requires an existing safe `PriceLock`. The order service validates:

- lock exists;
- product ID matches;
- amount and currency match the lock;
- lock is not expired;
- lock is not consumed;
- lock is not invalidated, blocked or reprice-required;
- current profitability validation returns `SAFE`;
- quantity is supported.

The order amount is copied from `lockedSellPrice`. Customer-supplied amount or currency cannot override it.

For KS-07-01, quantity is limited to `1`. Unsupported quantity returns `UNSUPPORTED_QUANTITY`.

## Atomic Creation

PostgreSQL order creation uses one transaction:

1. read existing order by idempotency key;
2. atomically update the matching active `price_locks` row to `CONSUMED`;
3. insert the `keycore_orders` row;
4. insert transition history;
5. insert the transactional outbox event.

If the lock cannot be claimed, no order is inserted. If the order cannot be inserted, the lock claim rolls back. A unique index on `keycore_orders.price_lock_id` prevents two orders from owning the same single-use lock.

## Idempotency

Order creation requires an idempotency key. The idempotency fingerprint is derived from non-secret commercial input:

- product ID;
- price lock ID;
- quantity;
- expected customer amount;
- expected currency.

Same key and same fingerprint returns the same logical `OrderId`. Same key and different fingerprint returns `ORDER_IDEMPOTENCY_CONFLICT`. The service rechecks idempotency after lock-consumption races so concurrent retry storms converge on one logical order.

## Payment and Risk Gating

Procurement does not start merely because an order exists. Procurement can move to `PENDING` or `IN_PROGRESS` only when:

- payment status is `CAPTURED`;
- risk status is `APPROVED`.

`NOT_STARTED`, `PENDING`, `AUTHORIZED`, `FAILED`, `CANCELLED`, `REFUNDED` and `PARTIALLY_REFUNDED` payment states block procurement. `NOT_EVALUATED`, `REVIEW_REQUIRED` and `REJECTED` risk states block procurement.

KS-07-01 does not implement Stripe. Payment methods are state-transition boundaries only.

## Procurement

Procurement is modeled but not executed. No Kinguin order endpoint is called.

Procurement result behavior:

- `SUCCEEDED` moves the order to fulfillment pending.
- `FAILED_RETRYABLE` moves to manual review; automatic cross-supplier fallback is not started.
- `FAILED_TERMINAL` can fail the order foundation state; later supplier fallback must still use the existing routing planner.
- `AMBIGUOUS` moves to manual review/reconciliation and returns no fallback candidates.

## Fulfillment

Fulfillment is modeled without real product keys. Successful fulfillment can complete the order only after procurement succeeded. Failed fulfillment moves to manual review.

No product-key plaintext or synthetic key-like value is stored in order, history, audit or outbox data.

## Refunds

Refunds are modeled but not executed. Requesting a refund moves a completed order to `REFUND_PENDING`; it does not mark the order refunded. Refund success later moves payment status to `REFUNDED` and order status to `REFUNDED`.

Concurrent refund requests use optimistic record versions; only one transition succeeds.

## External Event Deduplication

`external_event_receipts` records future provider events by:

- provider;
- external event ID;
- event type;
- non-secret fingerprint.

Repeating the same event with the same fingerprint returns `EXTERNAL_EVENT_DEDUPLICATED`. Reusing the same identity with a different fingerprint fails closed with `EXTERNAL_EVENT_CONFLICT`.

Stripe webhook parsing is not implemented in KS-07-01.

## Reconciliation

Unexpected or unsafe states produce bounded reconciliation intent through `order.reconciliation.requested` outbox events. Examples include ambiguous procurement, manual review and future provider-state uncertainty. The foundation does not create infinite retry loops.

## Audit and Outbox

Safe audit event names include:

- `ORDER_CREATED`
- `ORDER_STATE_CHANGED`
- `ORDER_PAYMENT_STATE_CHANGED`
- `ORDER_RISK_STATE_CHANGED`
- `ORDER_PROCUREMENT_STATE_CHANGED`
- `ORDER_FULFILLMENT_STATE_CHANGED`
- `ORDER_REFUND_STATE_CHANGED`
- `ORDER_MANUAL_REVIEW_REQUIRED`
- `ORDER_EXTERNAL_EVENT_DEDUPLICATED`

Safe outbox events include:

- `order.created`
- `order.procurement.requested`
- `order.fulfillment.requested`
- `order.refund.requested`
- `order.reconciliation.requested`

Payloads contain only order ID, product ID, price lock ID, status, reason code and correlation ID. They do not include product keys, credentials, raw provider payloads, card details or supplier acquisition cost.

## Persistence

Migration `009_order_orchestration` adds:

- `keycore_orders`;
- `order_transition_history`;
- `external_event_receipts`.

Constraints enforce valid states, positive money, `quantity = 1`, optimistic record versions, idempotency uniqueness, single price-lock ownership and active procurement payment/risk gates. A trigger rejects updates to immutable commercial fields.

## Phase 07 Boundaries

KS-07-01 prepares future integration points for:

- Stripe payment intent and webhook handling;
- supplier procurement execution;
- key fulfillment and secure vault storage;
- invoice trigger;
- refund execution;
- WooCommerce projection.

Those integrations remain out of scope here and require later tasks and approval gates where applicable.

## Current Limitations

- Quantity is fixed to `1`.
- No real payment provider is integrated.
- No live supplier purchase or key retrieval exists.
- No invoice creation exists.
- No customer account or admin UI is added.
- No production deployment is performed.
