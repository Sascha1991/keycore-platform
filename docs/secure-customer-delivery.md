# Secure Customer Key Delivery

KS-07-05 adds the secure customer key delivery foundation after KS-07-04
retrieval. It does not add production email, a customer HTTP endpoint or a full
customer identity system.

## Delivery Model

Delivery starts only from a fulfillment operation that is:

- `status = DELIVERY_PENDING`;
- `retrievalState = RETRIEVED`;
- `deliveryState = PENDING`;
- linked to the requested `orderId`;
- backed by an encrypted fulfillment secret.

The service uses two explicit steps:

1. `prepareDelivery` verifies fulfillment readiness and customer/order
   ownership through `CustomerOrderAuthorizationPort`, then creates a short
   lived one-time delivery capability.
2. `executeDelivery` atomically claims that capability, re-authorizes ownership,
   decrypts inside the final delivery boundary, calls the configured delivery
   port and acknowledges success only after durable persistence.

The default channel is fake/test infrastructure. Production customer delivery is
disabled unless a caller explicitly opts in through runtime configuration and a
real customer identity binding exists.

## Authorization

Delivery authorization is delegated to `CustomerOrderAuthorizationPort`.
Callers cannot authorize by merely knowing a fulfillment ID, order ID or token.
The canonical authorization context binds:

- customer ID;
- order ID;
- fulfillment ID;
- purpose `customer-key-delivery`;
- version `1`.

The context fingerprint is persisted and must match during execution. A changed
customer, order or fulfillment context fails closed before decryption.

The current `keycore_orders` schema has no production customer ownership column.
Until that schema and identity adapter exist, production customer delivery must
remain disabled and fail closed.

## Capability And TTL

One-time delivery capabilities are random 32-byte base64url strings. PostgreSQL
stores only the SHA-256 token hash.

Runtime settings:

- `KEYCORE_DELIVERY_APPROVAL_TTL_MS`, default `300000`;
- `KEYCORE_DELIVERY_LEASE_STALE_AFTER_MS`, default `60000`;
- `KEYCORE_ALLOW_LIVE_CUSTOMER_KEY_DELIVERY`, default `false`;
- `KEYCORE_CUSTOMER_DELIVERY_PROTECTED_FULFILLMENT_IDS`, comma-separated.

Invalid timing values fail closed.

## Decryption Boundary

Product-key plaintext is decrypted only after:

- a valid one-time capability is claimed;
- customer/order/fulfillment context matches;
- order authorization is rechecked;
- fulfillment is still delivery-ready.

Plaintext is passed as a mutable `Buffer` to the delivery port and overwritten
with zero bytes in a `finally` block after the delivery attempt finishes. Audit,
outbox, inspect output, reports and persistence must not contain plaintext,
ciphertext, nonce, authentication tag, wrapped DEK, master-key material, token
hashes or one-time tokens.

KMS or decrypt failures produce `FAILED_RETRYABLE` with
`FULFILLMENT_KEY_MANAGEMENT_FAILED`.

## Concurrency And Recovery

The repository has explicit claim/acknowledge behavior:

- exactly one worker can claim a delivery approval;
- fresh in-flight delivery returns `IN_FLIGHT`;
- stale in-flight delivery is moved to `MANUAL_REVIEW_REQUIRED`;
- successful delivery updates the fulfillment operation to `DELIVERED`, records
  the attempt as `DELIVERED` and writes one deduplicated outbox event in one
  transaction;
- once delivered, later execution returns `ALREADY_DELIVERED` and does not
  decrypt again.

Failed delivery-port results are classified:

- retryable provider failure: `FAILED_RETRYABLE`;
- provider rejection: `FAILED_TERMINAL`;
- ambiguous provider outcome: `MANUAL_REVIEW_REQUIRED`.

Automatic customer redelivery is not implemented in KS-07-05. Retry or
re-issue after failed/manual-review attempts requires future policy and human
safe handling.

## Safe Inspect

DB-only inspection:

```sh
npm run customer-delivery:inspect -- <fulfillmentId>
```

This command does not contact Kinguin or any delivery provider. It prints only
safe metadata such as fulfillment state, encrypted-secret presence, encryption
version/key ID and latest delivery attempt status/reason.

## Real Fulfillment Gate

The known live fulfillment
`fd61be5e-44ea-4914-98ae-c4404dc31779` remains protected. KS-07-05 must not
decrypt, display or deliver it. The service can be configured with protected
fulfillment IDs so accidental live customer delivery remains blocked unless a
future explicit production gate is approved.
