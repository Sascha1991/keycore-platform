# KS-07-03 - Supplier Procurement Orchestration

Risk: CRITICAL

Human approval: Review/merge required.

## Scope

Implement supplier-neutral procurement orchestration after captured payment and approved risk. Real supplier purchasing remains disabled by default. Tests and CI use fake suppliers only.

## Acceptance Criteria

- Procurement starts only when the KeyCore order exists, payment is `CAPTURED`, risk is `APPROVED`, quantity is `1`, the order state permits procurement, profitability revalidation is safe, a supplier offer is eligible, no success already exists, and no ambiguous/reconciliation block exists.
- Procurement operations are durable, generation-based and keep failed attempt history.
- Execution uses a durable lease and never holds a PostgreSQL transaction across supplier HTTP.
- Dispatch state distinguishes `NOT_DISPATCHED`, `DISPATCH_STARTED` and `DISPATCH_CONFIRMED`.
- Stale `DISPATCH_STARTED` work becomes ambiguous/reconciliation-required rather than blind retry.
- `AMBIGUOUS` blocks cross-supplier fallback.
- `FAILED_TERMINAL` may allow a later generation before mutation, according to existing routing/fallback policy.
- Dry run validates through the mutation boundary and performs no supplier mutation.
- Real Kinguin purchasing is not enabled in KS-07-03.
- Success stores supplier order evidence and acquisition cost internally, but no product key.
- Generic audit/outbox payloads contain safe identifiers only and exclude supplier cost, raw supplier payloads and key material.
- PostgreSQL constraints enforce valid states, quantity `1`, lease tuple validity and at most one successful procurement per order.
- Tests cover eligibility, dry run, success, retryable/terminal/ambiguous outcomes, crash recovery, concurrency, persistence constraints, privacy and 50k synthetic decisions.

## Out Of Scope

- Real Kinguin purchase enablement.
- Product-key retrieval.
- Fulfillment delivery.
- Customer key vault integration.
- Refund execution.
- Invoice generation.
- Admin UI.
- KS-07-04 or later work.
