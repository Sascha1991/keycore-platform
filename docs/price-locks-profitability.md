# Price Locks and Profitability Safeguards

KS-06-02 adds the supplier-neutral price-lock foundation between a calculated customer sell-price quote and future checkout/order flow.

## Purpose

A price lock answers whether a previously quoted customer price can still be honored safely at the current moment. It protects future checkout from honoring an old sell price after supplier costs, required fees, tax, FX or hard safety policy changed.

This task does not implement checkout, payment, procurement, fulfillment, invoices, live supplier purchase, live WooCommerce mutation or GAMIVO.

## Immutable Locked Price

The locked customer price is copied from a valid `QUOTED` `SellPriceQuote` at lock creation. It is never silently recalculated or increased in place.

If current inputs make the old price unsafe, the old lock is marked with a fail-closed status such as `REPRICE_REQUIRED` or `BLOCKED`. A future caller must request a new quote and new lock.

## States

Price locks use explicit states:

- `ACTIVE`
- `CONSUMED`
- `EXPIRED`
- `INVALIDATED`
- `REPRICE_REQUIRED`
- `BLOCKED`

`CONSUMED` is terminal and cannot become `ACTIVE` again. Expired, invalidated, blocked or reprice-required locks cannot be consumed automatically.

## TTL and Expiration

Every lock has a persisted `expiresAt`. The service requires an explicit expiry and rejects expired or stale creation requests.

KS-06-02 does not invent a production TTL. Callers provide the expiry from configured policy boundaries such as the pricing quote TTL.

## Profitability Revalidation

Revalidation asks the current pricing service for current authoritative quotes for the product. A result can be:

- `SAFE`
- `REPRICE_REQUIRED`
- `BLOCKED`
- `EXPIRED`
- `CONSUMED`
- `CONFLICT`

`SAFE` requires at least one current `QUOTED` offer where:

```text
lockedSellPrice - current fully known acquisition cost >= current hard minimum profit
```

The locked price must also satisfy the current hard minimum sell price and currency. If this cannot be proven, the lock is not honored automatically.

## Hard Safety Checks

The lock validation fails closed for:

- expired lock;
- consumed lock reuse;
- no eligible offer;
- supplier price increase below hard floor;
- profit below hard minimum;
- pricing disabled globally or for the product;
- unknown required fee;
- unknown tax treatment;
- missing or stale FX;
- stale supplier price input;
- amount/currency mismatch;
- unsafe persisted state or idempotency conflict.

## Multi-Supplier Behavior

A lock is not permanently tied to one supplier before procurement starts. If the original offer becomes unsafe but another current eligible offer can fulfill the locked price safely, validation may remain `SAFE`.

Supplier fallback after an ambiguous procurement attempt remains governed by the supplier routing state machine. KS-06-02 performs pre-procurement profitability validation only and does not implement procurement.

## Policy, Overrides and Manual Prices

Target markup or margin changes do not automatically invalidate an existing lock when the locked price still satisfies current hard safety floors.

Hard safety changes are authoritative. If current minimum profit, minimum sell price, disabled pricing, tax, fee or FX boundaries make the old locked price unsafe, validation fails closed.

Manual sell-price changes after lock creation do not mutate the locked price and cannot bypass profitability validation.

## Idempotency

Lock creation requires an idempotency key. Repeating the same key with the same lock inputs returns the same logical lock. Reusing the key with different lock inputs returns `CONFLICT`.

The idempotency fingerprint is derived from non-secret quote identity, price, policy/tax/FX versions and expiry.

PostgreSQL creation uses an atomic idempotent insert. The repository attempts `INSERT ... ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING ...`; when another application instance wins the race, it reads the persisted row and compares `idempotency_fingerprint`.

If the fingerprint matches, the caller receives the existing logical lock. If it differs, the caller receives `IDEMPOTENCY_CONFLICT`. Raw unique-constraint errors are not part of the application idempotency contract.

The database keeps nullable idempotency columns for future migration or administrative compatibility, but the tuple is atomic: either both `idempotency_key` and `idempotency_fingerprint` are null, or both are present. The service-created path requires an idempotency key.

## Consumption and Concurrency

The repository exposes `consumeIfActive(lockId, expectedVersion)`. PostgreSQL consumption is a single conditional update on `id`, `status = ACTIVE`, `record_version` and non-expired state.

Two concurrent consumers cannot both consume the same lock. The loser receives a conflict/consumed result and no order behavior is implemented in this task.

Status transitions also use optimistic versions. A stale status update returns an explicit conflict with the current persisted lock instead of surfacing a generic persistence error. The service maps that current state fail-closed.

## Persistence

Migration `008_price_locks_profitability` creates `price_locks` with:

- immutable product, currency and locked sell price;
- quote/source fingerprints;
- pricing policy, override, manual price, tax, fee and FX version references;
- state, record version and lifecycle timestamps;
- idempotency key and fingerprint;
- correlation ID and reason code.

The migration is reversible. Constraints enforce positive locked price, valid states, positive versions, expiry after creation and idempotency uniqueness.

## Emergency Stop

The foundation reuses the existing pricing enabled state. If global pricing or product pricing is disabled, new current quotes are blocked and existing active locks fail validation closed.

No admin UI is added in KS-06-02.

## Audit and Events

Lifecycle events use `PRICING_PRICE_LOCK_*` audit event names. Safe metadata includes only lock ID, product ID, currency, status, reason code, pricing policy version and correlation ID.

Audit metadata and queue payloads do not include supplier cost, credentials, product keys, raw supplier payloads or customer/order data.

The safe queue payload helper is `priceLockRevalidationJobPayload`, with `ProductId`, `correlationId` and reason.

## Customer-Safe Representation

Future customer surfaces may expose:

- price lock ID;
- product ID;
- price;
- currency;
- expiry.

They must not expose supplier identity, supplier offer, supplier cost, margin, profit, fee details, tax internals, routing state or internal fingerprints.

## Phase 07 Boundary

The service prepares:

- `createPriceLock`;
- `getPriceLock`;
- `validatePriceLock`;
- `consumePriceLock`.

Phase 07 can later call these methods from checkout/order orchestration. KS-06-02 intentionally stops before checkout, payment, order creation and procurement.

## Limitations

- No production TTL is selected.
- No checkout/order API exists yet.
- No live supplier purchase or key retrieval exists here.
- No GAMIVO behavior is implemented.
- No production tax/legal assumption is made.
