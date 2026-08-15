# KS-06-02 - Price Locks & Profitability Safeguards

Risk: HIGH

Human approval: Review/merge required.

## Scope

Add the supplier-neutral safety layer between calculated customer prices and future checkout/order flow.

Included:

- explicit price-lock domain model and state machine;
- immutable locked customer sell price;
- configurable explicit expiry;
- idempotent lock creation;
- profitability revalidation against current authoritative pricing inputs;
- multi-offer safe revalidation that may use another eligible offer before procurement starts;
- single-use consumption foundation with optimistic concurrency;
- PostgreSQL persistence with reversible migration;
- audit-safe lifecycle events and safe queue payloads;
- documentation, tests and implementation report.

## Out Of Scope

- Stripe;
- customer checkout;
- customer orders;
- payment authorization or capture;
- live Kinguin purchase;
- product-key retrieval;
- fulfillment;
- invoices;
- customer account;
- admin UI;
- GAMIVO;
- production tax assumptions;
- live WooCommerce mutation;
- Phase 07.

## Acceptance Criteria

- A lock can be created only from a current `QUOTED` sell-price quote.
- Locked customer price is immutable after creation.
- Lock expiry is explicit and persisted; expired locks cannot be honored.
- Revalidation returns structured statuses and reason codes, not arbitrary operational text.
- `SAFE` is returned only when at least one current quoted eligible offer keeps the locked price above current hard minimum profit and minimum sell-price floors.
- Unknown required fee, unknown tax, missing or stale FX, stale supplier price, pricing disablement, currency mismatch and consumed/expired locks fail closed.
- Multi-offer revalidation remains deterministic and supplier-neutral.
- Lock creation is idempotent; conflicting idempotency-key reuse returns conflict.
- Concurrent lock creation with the same idempotency key is race-safe across application instances.
- Consumption is atomic; two concurrent consumers cannot both consume the same active lock.
- PostgreSQL migration is reversible and enforces positive locked price, valid state, positive versions, expiry ordering and idempotency uniqueness.
- Audit metadata, queue payloads and customer-safe representation do not expose supplier cost, supplier identity, credentials, product keys or raw supplier payloads.
- A synthetic 50,000-lock/offer invariant test runs without external HTTP.
- Existing KS-06-01 pricing behavior remains green.
