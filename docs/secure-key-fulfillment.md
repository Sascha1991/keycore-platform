# Secure Key Fulfillment

KS-07-04 establishes the supplier-agnostic secure key retrieval and
fulfillment foundation. Product keys are secrets and are handled at least as
carefully as credentials.

## Threat Model

KeyCore assumes supplier key payloads may contain product keys, API-related
debug text or other sensitive strings. These values must not spread into logs,
audit metadata, queues, outbox events, CLI output, reports or plaintext
database columns.

Plaintext may exist only in process memory between supplier response validation
and immediate encryption. Customer delivery is a separate narrow boundary and
is not implemented as production email in KS-07-04.

## State Model

Fulfillment operation states:

- `PENDING`;
- `READY`;
- `RETRIEVAL_IN_FLIGHT`;
- `RETRIEVED`;
- `DELIVERY_PENDING`;
- `DELIVERED`;
- `FAILED_RETRYABLE`;
- `FAILED_TERMINAL`;
- `AMBIGUOUS`;
- `MANUAL_REVIEW_REQUIRED`.

Retrieval and delivery are distinct. A retrieved key moves to
`DELIVERY_PENDING`; it is not considered delivered to a customer.

## Database Model

Migration 014 adds:

- `fulfillment_operations`;
- `fulfillment_secrets`.

`fulfillment_operations` owns metadata, state, one-time approval token hash,
retrieval lease and safe status fields. `fulfillment_secrets` stores encrypted
secret material only:

- ciphertext;
- random nonce;
- authentication tag;
- wrapped data encryption key;
- encryption key ID;
- encryption version;
- encryption algorithm.

There is no plaintext key, raw supplier response, supplier response JSON or
customer-visible key-copy column.

## Encryption

Fulfillment secrets use `AES-256-GCM-v1` with:

- random 32-byte data encryption key per secret;
- random 12-byte nonce per secret;
- authentication tag;
- canonical AAD binding fulfillment ID, supplier ID, external supplier order ID,
  purpose, algorithm and version;
- wrapped data encryption key;
- explicit encryption key ID and version.

Runtime key material is supplied through:

- `KEYCORE_FULFILLMENT_MASTER_KEY`;
- `KEYCORE_FULFILLMENT_MASTER_KEY_ID`.

The master key must be a base64-encoded 32-byte value. KeyCore fails closed if
it is missing or malformed. No production key is generated silently.

The stored key ID and wrapped DEK keep future rotation possible without storing
plaintext.

## Kinguin Retrieval Semantics

Official Kinguin documentation defines key retrieval as:

`GET /v2/order/{orderId}/keys`

The endpoint accepts `page` and `limit` query parameters and returns an array of
key objects. Each object includes `id`, `serial`, `type`, `name`, `kinguinId`,
`offerId` and `productId`. `serial` is product-key material.

The docs state a key is available once delivered to the order and explicitly
list periodic calls to the Download keys endpoint with pagination as one of the
recommended retrieval strategies. The state-changing return flow is documented
separately as `POST /v2/order/{orderId}/keys/return`, with its own one-request
limit. KS-07-04 therefore models Kinguin key download as repeatable read-only.
Network, timeout and rate-limit failures on key retrieval may become
`FAILED_RETRYABLE` and be retried only by a later explicit command invocation
through the durable fulfillment lease. Malformed key responses fail closed.

Kinguin also documents:

- `GET /v1/order/{orderId}` where order `processing` waits for keys and
  `completed` means all keys have been delivered;
- key statuses `PENDING`, `PROCESSING`, `DELIVERED`, `RETURNED`, `REFUNDED`,
  `CANCELED`;
- `POST /v2/order/{orderId}/keys/return` as a separate state-changing return
  operation. KS-07-04 does not call it.

## Controlled Live Retrieval

Preparation command:

```sh
npm run kinguin:prepare-live-key-retrieval -- <controlledProcurementApprovalId>
```

Preparation is DB-only and performs no key retrieval. It requires:

- confirmed controlled procurement;
- `DISPATCH_CONFIRMED`;
- external supplier order ID;
- supplier `kinguin`;
- expected quantity `1`;
- no encrypted secret already stored;
- valid fulfillment crypto configuration.

Execution command:

```sh
npm run kinguin:execute-approved-key-retrieval -- <fulfillmentApprovalId> <oneTimeToken>
```

Execution additionally requires:

- `KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL=true`;
- `KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE=CONTROLLED_VERIFICATION_ONE_TIME`;
- finite `KINGUIN_CONTROLLED_KEY_RETRIEVAL_TIMEOUT_MS`, default `10000`;
- matching unexpired one-time token;
- durable retrieval lease ownership;
- no existing encrypted secret.

One execution invocation performs at most one supplier key request. There is no
internal rapid retry loop.

Do not run execution for a real order until PR review, green CI, merge, local
migration and explicit operator action are complete.

## Crash And Failure Recovery

Supplier success and local persistence are not one atomic transaction. After a
supplier key response, KeyCore encrypts the material and commits the encrypted
secret insert plus fulfillment state transition in one PostgreSQL transaction.
If local KMS/encryption fails, the operation is marked `FAILED_RETRYABLE` with
`FULFILLMENT_KEY_MANAGEMENT_FAILED`. If encrypted persistence loses ownership
or fails before commit, the operation uses `FULFILLMENT_LOCAL_PERSISTENCE_FAILED`
and no orphan secret may remain.

This retryable recovery is allowed only because the current Kinguin docs support
periodic repeatable key download. Unknown local errors before a classified
supplier result are not labeled as supplier failures; they become
`AMBIGUOUS` with `FULFILLMENT_LOCAL_UNKNOWN`.

Successful encrypted persistence uses reason code `FULFILLMENT_KEY_RETRIEVED`.
`FULFILLMENT_CREATED` is reserved for operation creation.

## Inspect

Safe local inspection:

```sh
npm run fulfillment:inspect -- <fulfillmentId>
```

Output includes only metadata such as fulfillment ID, supplier, external
supplier order ID, status, retrieval state, delivery state, whether an encrypted
secret exists, encryption version and key ID. It never prints plaintext,
ciphertext, nonce, tag, token hash or master-key material.

## Audit And Outbox

Audit metadata and outbox/queue payloads may include fulfillment ID, supplier
ID, external supplier order ID, status, retrieval state, delivery state, reason
code and timestamps.

They must not include product key material, ciphertext, nonce, tag, wrapped
DEK, master keys, token hashes, one-time tokens or raw supplier responses.

Queue/outbox payloads reference `fulfillmentId` only. A trusted worker must use
the secure storage boundary when customer delivery later needs decryption.

## Delivery Boundary

KS-07-04 does not implement production customer email. KS-07-05 adds the
separate secure customer delivery foundation documented in
`docs/secure-customer-delivery.md`: a short-lived one-time capability,
customer/order authorization port, explicit claim/acknowledge delivery attempt,
safe fake/test delivery boundary, plaintext zeroization and DB-only safe
inspection.

Broad admin plaintext listing is not implemented.
