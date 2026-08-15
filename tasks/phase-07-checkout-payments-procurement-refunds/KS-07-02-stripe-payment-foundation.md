# KS-07-02 - Stripe Payment Integration Foundation

## Scope

Implement the KeyCore Stripe PaymentIntent foundation without live charges, production keys, supplier procurement, product-key retrieval or fulfillment.

## Acceptance Criteria

- Orders can reserve exactly one local Stripe payment mapping per `OrderId`.
- PaymentIntent creation uses deterministic server-side idempotency: `keycore:payment-intent:create:<OrderId>:v1`.
- No PostgreSQL transaction is held across Stripe HTTP calls.
- Local persistence does not store Stripe `client_secret`.
- Raw-body webhook verification requires `Stripe-Signature` and a webhook secret before any receipt or order mutation.
- Supported webhook events are `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing` and `payment_intent.canceled`.
- Successful payment evidence is deduplicated and validated against local mapping, amount, currency and order metadata before order payment becomes `CAPTURED`.
- Processing, failed, canceled, ambiguous or mismatched payment evidence does not enable procurement.
- Stripe configuration remains test-mode only for this task.
- Migration is reversible and covered by PostgreSQL integration tests.
- Documentation and implementation report cite official Stripe documentation.

## Out Of Scope

- Live Stripe keys or production-mode payment processing.
- Real customer payment data.
- Supplier procurement.
- Product-key retrieval.
- Fulfillment.
- Refund implementation.
- KS-07-03 or later work.
