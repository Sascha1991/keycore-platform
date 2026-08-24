# Stripe Payment Foundation

KS-07-02 integrates Stripe at the PaymentIntent boundary. KeyCore owns the local order and payment state; Stripe provides payment evidence.

## Official References

- Stripe PaymentIntents API: <https://docs.stripe.com/api/payment_intents>
- PaymentIntent create API: <https://docs.stripe.com/api/payment_intents/create>
- PaymentIntent lifecycle: <https://docs.stripe.com/payments/paymentintents/lifecycle>
- Idempotent requests: <https://docs.stripe.com/api/idempotent_requests>
- Webhook signature verification for Node: <https://docs.stripe.com/webhooks/signature?lang=node>
- Payment webhook handling: <https://docs.stripe.com/webhooks/handling-payment-events>
- Undelivered webhook processing: <https://docs.stripe.com/webhooks/process-undelivered-events>
- Stripe SDK versioning: <https://docs.stripe.com/sdks/versioning>
- Webhook versioning: <https://docs.stripe.com/webhooks/versioning>

## PaymentIntent Creation

KeyCore creates PaymentIntents through a `StripePaymentProviderPort`. The local service first reserves one durable `order_payments` row for `(OrderId, STRIPE)` and commits that reservation before calling Stripe.

The Stripe idempotency key is deterministic and non-secret:

```text
keycore:payment-intent:create:<OrderId>:v1
```

Stripe receives:

- amount from the immutable KeyCore order amount;
- lowercase ISO currency from the immutable KeyCore order currency;
- automatic payment methods enabled;
- automatic capture;
- metadata containing `keycore_order_id` and `keycore_payment_version`.

The Stripe `client_secret` may be returned to the caller of initialization, but it is not persisted in PostgreSQL, outbox payloads or audit-safe metadata.

## Create Recovery Lease

PaymentIntent creation is split into a local reservation and a bounded local creation lease:

1. reserve or load the local `order_payments` row;
2. atomically claim `create_attempt_token` and `create_attempt_started_at`;
3. call Stripe outside any PostgreSQL transaction with the deterministic idempotency key;
4. persist the returned PaymentIntent only if the caller still owns the lease.

Only payments in `CREATION_PENDING` or `CREATE_OUTCOME_UNKNOWN` with no `external_payment_id` are eligible for create retry. A fresh lease returns `PAYMENT_CREATE_IN_FLIGHT`; another caller may recover only after the configured stale threshold. The threshold is supplied by application configuration, represented in local examples as `STRIPE_CREATE_LEASE_STALE_AFTER_MS`.

If Stripe creation is ambiguous before KeyCore stores the external ID, the local status becomes `CREATE_OUTCOME_UNKNOWN`. Recovery repeats the same Stripe create call with the same deterministic idempotency key. It does not search Stripe by amount, customer, email or timestamp.

If Stripe definitively rejects creation, the local payment becomes `FAILED` and is not automatically retried.

Recovered PaymentIntent responses are validated before being persisted as authoritative:

- amount matches the immutable KeyCore order amount;
- currency matches the immutable KeyCore order currency;
- `metadata.keycore_order_id` matches the `OrderId`;
- `metadata.keycore_payment_version` matches the local payment operation version.

Unexpected recovered identity fails closed to reconciliation/manual review and is never captured automatically.

## Local Payment Mapping

`order_payments` stores the KeyCore payment mapping:

- `order_id`
- `provider = STRIPE`
- `external_payment_id`
- amount and currency
- local payment status
- record and operation versions
- deterministic Stripe idempotency key
- provider fingerprint
- reconciliation flag
- create attempt token and start timestamp

`order_id + provider`, `provider + external_payment_id` and the Stripe idempotency key are unique. Order identity, provider, amount, currency, operation version and idempotency key are immutable after insert.

## Webhooks

The webhook path verifies the exact raw request body using `Stripe-Signature` and the endpoint secret before recording an external event receipt or mutating an order. Invalid signatures return fail-closed and do not create receipts.

Supported events:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.processing`
- `payment_intent.canceled`

External event receipts deduplicate replays by provider, external event ID and event type. Conflicting fingerprints require reconciliation.

Before marking an order captured, KeyCore verifies:

- the PaymentIntent maps to the persisted local payment;
- amount matches the immutable order amount;
- currency matches the immutable order currency;
- Stripe metadata references the same `OrderId`.
- Stripe metadata references the expected payment operation version.

Mismatch requires reconciliation and moves the order to manual review when the state machine permits it.

If a signed webhook arrives before the local Stripe create response is persisted, KeyCore records the external event receipt when metadata safely identifies the order, but it does not mark the order captured from metadata alone. A later create recovery establishes the authoritative payment mapping through the deterministic Stripe create response.

## Safety

`payment_intent.succeeded` may transition local payment and order payment status to `CAPTURED`, but it does not approve risk and does not start supplier procurement.

`payment_intent.processing` remains non-captured. `payment_intent.payment_failed` and `payment_intent.canceled` are not procurement eligible. Older or duplicate non-captured evidence cannot regress a captured local payment.

## Configuration

KS-07-02 permits only Stripe test-mode configuration. Live-mode secret keys and non-test environments are rejected by configuration validation.

`.env.example` contains placeholders only. Real Stripe API keys, webhook secrets, raw webhook payloads, card data and customer payment data must not be committed.
