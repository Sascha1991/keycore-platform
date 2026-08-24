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

## Controlled Real-Data Dry-Run Verification

KS-07-03b adds `npm run kinguin:verify-procurement-dryrun` as a local,
manual verification command for current Kinguin production read-only data. The
command is not used by CI and refuses to run unless
`KEYCORE_ALLOW_KINGUIN_LIVE_READONLY=true`,
`KINGUIN_ENVIRONMENT=PRODUCTION`,
`KINGUIN_API_BASE_URL=https://gateway.kinguin.net/esa/api`, and a local
`KINGUIN_API_KEY` are present.

The verification transport is technically read-only. It allows only explicitly
allowlisted `GET` requests for product and reference data and blocks `POST`,
`PUT`, `PATCH`, `DELETE`, `/order`, `/keys`, `/keys/return`, non-HTTPS URLs,
unexpected hosts, unexpected base paths and unsafe redirects. The final result
asserts zero mutation, forbidden-path and key-retrieval attempts.

The flow reads a bounded product sample, normalizes Kinguin product/offer data,
resolves `SupplierOfferId -> SupplierProductId` through the existing mapping
boundary, evaluates Germany eligibility with the current DE policy engine,
exercises the pricing boundary with a policy clearly marked
`SYNTHETIC_VERIFICATION_ONLY`, and builds the Kinguin `POST /v2/order` payload
locally through the existing request builder. The payload is never sent.

The expected successful dry-run outcome is
`PURCHASE_REQUEST_READY_BUT_NOT_SENT` represented as
`purchaseMutation: "NOT_SENT"` plus a deterministic non-secret request
fingerprint. Real Kinguin supplier cost data is used only as read-only input.
Synthetic tax/fee/pricing assumptions are not production-valid margin evidence
and must not be used to approve live sales or real procurement.

`orderExternalId` uses a deterministic dry-run-only reference beginning with
`keycore-dryrun-`. That reference is non-production evidence and must not be
reused for a real purchase.

## Controlled First Live Kinguin Procurement

KS-07-03c adds a separate `CONTROLLED_VERIFICATION` path for one explicitly
approved Kinguin live order. It does not weaken normal customer procurement
gates and does not fake paid customer order evidence.

Preparation and candidate-list commands are read-only. They require explicit
Kinguin product and offer identifiers, validate current availability and Germany
eligibility, build the exact `POST /v2/order` payload locally, generate a
`keycore-liveverify-<uuid>` `orderExternalId`, compute a deterministic request
fingerprint and persist a short-lived approval manifest.

Execution requires both approval ID and a high-entropy one-time token. Only the
token hash is persisted. Claiming is atomic and consumes the approval before
dispatch, so a crash or ambiguous supplier outcome cannot authorize a second
POST. The controlled mutation transport allows only `POST /v2/order`, uses a
finite timeout, does not follow POST redirects, performs no automatic retry and
has no key retrieval capability.

For the first live verification, price is part of the request fingerprint. Any
price change requires a new approval; the maximum acquisition amount remains an
additional fail-closed check. Reconciliation is read-only and never retrieves
keys.

## Reconciliation And Webhooks

Known external supplier order IDs can be reconciled through the supplier port. Unknown outcomes use only documented supplier references. KeyCore does not guess by price, product or timestamp. Kinguin webhooks remain authenticated by documented `X-Event-Name` and `X-Event-Secret` behavior; unknown supplier orders require reconciliation/manual review and are not blindly attached to customer orders.

## Privacy

Acquisition cost is stored only on internal procurement records. Generic audit and outbox payloads include safe IDs, status, reason code, attempt generation and correlation ID. They exclude product keys, API credentials, raw supplier payloads, supplier cost, profit and margin.

## Limitations

Real supplier purchase execution is intentionally disabled. Product-key retrieval, fulfillment, refunds, invoices, admin UI and production deployment remain later tasks and approval-gated work.
