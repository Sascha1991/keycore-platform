# Supplier Procurement Orchestration

KS-07-03 adds the supplier-neutral procurement execution boundary. PostgreSQL remains the durable source of truth. Redis and queues may deliver work later, but they do not prove supplier state.

## Eligibility Gates

Procurement fails closed unless the order exists, payment is `CAPTURED`, risk is `APPROVED`, quantity is `1`, the order is in a procurement-capable state, the price lock remains safe, current supplier economics still preserve hard profitability, an eligible supplier offer exists, no successful procurement already exists, and no ambiguous/reconciliation block exists.

## Profitability And Routing

Immediately before procurement, the service revalidates the existing price lock and re-quotes the selected supplier offer. The customer sell price remains immutable. If the current offer cannot satisfy the hard minimum profit, procurement blocks before mutation. Supplier selection uses the existing routing foundation; KS-07-03 does not create a second routing algorithm.

## Operation Model

`procurement_operations` records each attempt generation with:

- order and supplier identifiers;
- supplier product and offer identifiers;
- quantity;
- procurement status;
- dispatch state;
- execution lease;
- external supplier order evidence;
- internal acquisition amount;
- response fingerprint;
- reconciliation metadata.

Attempt history is preserved. A later supplier attempt can be created only after a proven terminal failure. Ambiguous attempts block later generations.

## States

Procurement statuses are `PENDING`, `READY`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `AMBIGUOUS` and `RECONCILIATION_REQUIRED`.

Dispatch states are `NOT_DISPATCHED`, `DISPATCH_STARTED` and `DISPATCH_CONFIRMED`. Stale `NOT_DISPATCHED` work may be safely retried. Stale `DISPATCH_STARTED` work is treated as ambiguous because the supplier mutation may have happened.

## Execution Lease

Execution uses `execution_token` plus `execution_started_at`. Only the lease owner may call the supplier and persist the result. Fresh leases make other callers return `PROCUREMENT_ALREADY_IN_FLIGHT`. Stale leases are recoverable only when dispatch had not started. No PostgreSQL transaction is held across supplier HTTP.

## Kinguin Contract Finding

Current official Kinguin documentation was rechecked from `kinguinltdhk/Kinguin-eCommerce-API` on August 24, 2026. It documents `POST /v2/order`, `GET /v1/order/{orderId}`, `GET /v2/order/{orderId}/keys`, `POST /v2/order/{orderId}/keys/return`, order-status webhooks and `orderExternalId` as a custom external reference whose value should be unique. It does not document a strong server-side idempotency guarantee for order creation. Therefore a timeout or unknown response after a mutating request is `AMBIGUOUS` and must reconcile before any fallback.

## Dry Run And Mutation Guard

Execution modes are:

- `DISABLED`: default production-safe behavior; no procurement mutation.
- `DRY_RUN`: validates, routes and creates a would-be operation, then stops before supplier mutation.
- `FAKE_SUPPLIER_ONLY`: test/CI mode for deterministic fake suppliers.

Real Kinguin procurement remains disabled in KS-07-03. No controlled live-purchase flag is added.

## Reconciliation And Webhooks

Known external supplier order IDs can be reconciled through the supplier port. Unknown outcomes use only documented supplier references. KeyCore does not guess by price, product or timestamp. Kinguin webhooks remain authenticated by documented `X-Event-Name` and `X-Event-Secret` behavior; unknown supplier orders require reconciliation/manual review and are not blindly attached to customer orders.

## Privacy

Acquisition cost is stored only on internal procurement records. Generic audit and outbox payloads include safe IDs, status, reason code, attempt generation and correlation ID. They exclude product keys, API credentials, raw supplier payloads, supplier cost, profit and margin.

## Limitations

Real supplier purchase execution is intentionally disabled. Product-key retrieval, fulfillment, refunds, invoices, admin UI and production deployment remain later tasks and approval-gated work.
