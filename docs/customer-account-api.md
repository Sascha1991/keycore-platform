# Customer Account API Contract

KS-08-03 defines a transport-neutral customer account API/application boundary.
It is not a production HTTP service and does not expose a live frontend.
Future public/customer-facing storefront copy should use the KeyRaNo brand line
"Rapid Access. No Waiting." Internal service, package and repository identifiers
remain KeyCore.

## Architecture

Future HTTP or storefront adapters must follow this chain:

```text
HTTP/storefront adapter
-> session credential extraction
-> KS-07-07 session resolution
-> AuthenticatedCustomerPrincipal
-> customer account or registration handler
-> KeyCore service
-> safe DTO response
```

Storefront input is never authoritative for `customerId`, order ownership, key
ownership, verification state or delivery authorization.

## Common Contract

- API DTO version: `v1`.
- Session credential: opaque server-side session token from a secure cookie or
  equivalent trusted extraction.
- Credential extraction is deterministic and fail-closed. A future HTTP adapter
  must reject duplicate cookies, duplicate session headers, duplicate
  Authorization credentials, whitespace-padded credentials, empty credentials,
  oversized credentials, malformed opaque tokens and conflicting credential
  sources instead of selecting one.
- Correlation ID: optional `A-Za-z0-9._:-`, max 96 chars. Invalid/missing values
  are replaced with a generated safe ID.
- Error response: `{ status: "ERROR", apiVersion: "v1", code, correlationId }`.
- Internal exception names, SQL, constraint names, stack traces, filesystem
  paths and provider errors are never returned.

Common safe error codes:

- `BAD_REQUEST`;
- `AUTHENTICATION_REQUIRED`;
- `ACCESS_DENIED`;
- `RESOURCE_NOT_AVAILABLE`;
- `CONFLICT`;
- `RATE_LIMITED`;
- `TEMPORARILY_UNAVAILABLE`;
- `CLAIM_INVALID`.

## Headers

Account reads:

- `Content-Type: application/json`;
- `Cache-Control: private, no-store`;
- `Pragma: no-cache`;
- `X-Content-Type-Options: nosniff`.

Registration, verification and identity-link mutations:

- `Content-Type: application/json`;
- `Cache-Control: no-store`;
- `Pragma: no-cache`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`.

No customer account response may be stored in shared caches.

## Cookie Policy

The future browser session cookie contract is:

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

Session tokens must not be placed in URLs, localStorage, logs, analytics or
audit metadata.

## Origin, CORS And CSRF

Production and staging origins must be HTTPS and configured explicitly.
Wildcard credentialed CORS is forbidden. Same-origin deployment remains
preferred where practical. Local/CI may deliberately allow localhost HTTP.

Authenticated customer mutations require Origin validation and HMAC
double-submit CSRF validation bound to the session credential hash. Public
registration and verification handlers require strict Origin validation; they
do not create a principal and are not session-bound, so they use strict
Origin, content-type, body-size and rate-limit controls rather than the
authenticated session CSRF check.

SameSite is defense-in-depth only and is not the sole CSRF control for
sensitive authenticated mutations.

## Routes

These routes are future route contracts. KS-08-03 does not expose production
HTTP.

| Method | Path                         | Auth | CSRF | Cache                   |
| ------ | ---------------------------- | ---- | ---- | ----------------------- |
| GET    | `/v1/customer/account`       | Yes  | No   | `private, no-store`     |
| GET    | `/v1/customer/orders`        | Yes  | No   | `private, no-store`     |
| GET    | `/v1/customer/orders/{id}`   | Yes  | No   | `private, no-store`     |
| POST   | `/v1/customer/register`      | No   | No   | `no-store`              |
| POST   | `/v1/customer/verify-email`  | No   | No   | `no-store`, no-referrer |
| POST   | `/v1/customer/link-identity` | Yes  | Yes  | `no-store`              |
| POST   | `/v1/customer/key-access`    | Yes  | Yes  | `no-store`, no-referrer |
| POST   | `/v1/customer/orders/claim`  | Yes  | Yes  | `no-store`, no-referrer |

## Account Summary

`GET /v1/customer/account`

Response fields:

- `customerId`;
- masked email only;
- email verification state;
- creation timestamp.

No raw email, provider subject, auth context, session token or identity binding
internals are returned.

## Order History

`GET /v1/customer/orders`

Query:

- `limit`: positive integer, bounded by the account service;
- `cursor`: opaque signed cursor.

Invalid limit or cursor returns `BAD_REQUEST`. Missing `limit` delegates to the
service default of 20 and limits above 100 are passed to the service clamp
instead of being rejected by the transport. The response contains owned orders
only, safe customer-facing states, totals and an opaque `nextCursor` when
available. Supplier IDs, supplier order IDs and supplier item references are not
returned.

## Order Detail

`GET /v1/customer/orders/{id}`

The path ID is a customer-facing opaque UUID. The transport resolves the session
first and calls `getOwnedOrderDetail`; it must never load arbitrary orders
directly. Unknown, wrong-owner and legacy/unclaimed orders map to
`RESOURCE_NOT_AVAILABLE` without revealing which case occurred.

Safe key-vault metadata may include fulfillment ID, status, delivery status,
`hasEncryptedSecret`, retrieval/delivery timestamps and
`keyAccessAvailable`. Plaintext key fields, ciphertext fields, nonces, wrapped
keys and decrypt endpoints are forbidden.

Order detail never reveals a key automatically. A future UI may display
`keyAccessAvailable=true` and let the customer explicitly start the KS-07-08
authenticated delivery flow.

## Key Access

`POST /v1/customer/key-access`

KS-08-04 models explicit transport-neutral prepare and execute actions for
future key access. The request must include the KeyCore order UUID and
fulfillment reference. Execute also requires the one-time delivery approval and
capability from prepare. The transport rejects authority fields such as
`customerId`, supplier IDs, external supplier order IDs, raw key material,
ciphertext and encryption fields.

The handler re-resolves the current session, validates Origin and CSRF, applies
rate limiting and delegates to `CustomerKeyAccessService`, which then delegates
to the KS-07 secure customer delivery service. Account GET reads never prepare,
decrypt or deliver.

## Guest Order Claim

`POST /v1/customer/orders/claim`

KS-08-05 models an authenticated account-required claim action for guest
checkout orders. The request body may contain:

- `claimCode`;
- optional `orderId` as context.

The `claimCode` is secret input. It is never echoed, logged, audited or used as
a raw limiter key. The order ID is not authority and may only narrow the claim
context. The handler resolves the current session, requires a verified
authenticated customer, validates Origin and CSRF, applies rate limiting and
delegates to `CustomerRegistrationService.claimGuestOrder()`.

Request-supplied `customerId`, email, ownership flags, checkout email,
provider subject, WooCommerce user ID, supplier IDs, fulfillment IDs, delivery
capabilities and Product Key material are rejected. Invalid, expired,
consumed, revoked, wrong-email, wrong-order and malformed claim credentials map
to `CLAIM_INVALID` without revealing which case occurred.

Successful responses contain only:

- `ORDER_CLAIMED` or `ORDER_ALREADY_OWNED`;
- the KeyCore `orderId`.

After a successful claim, the customer uses the ordinary owned-order and
KS-08-04 key access paths. Guest claim does not decrypt, deliver, retrieve or
email Product Keys.

## Registration

`POST /v1/customer/register`

Body:

- `email`.

The public success response is always `REGISTRATION_ACCEPTED` and does not
include `customerId`, whether the account already existed or whether the email
is already known. No session is created automatically.

Fields such as `customerId`, `providerSubject`, `orderOwner`, `supplierId`,
`supplierOrderId`, `externalSupplierOrderId`, `fulfillmentId`,
`fulfillmentReference`, verification state, session/principal objects, raw
session token and delivery capability fields are rejected.

## Email Verification

`POST /v1/customer/verify-email`

Body:

- `verificationToken`.

The token is secret input. It is never echoed, logged or audited. Invalid,
expired and consumed tokens return stable `VERIFICATION_INVALID`. The response
is `no-store` with `Referrer-Policy: no-referrer`.
Unexpected verification persistence or service failures are mapped to
`TEMPORARILY_UNAVAILABLE` without echoing the token, SQL details, filesystem
paths, stack traces or provider messages.

If a future email link must carry a query token, the HTTP adapter must exchange
and consume it immediately through POST-style server handling and apply
referrer protections.

## Identity Linking

`POST /v1/customer/link-identity`

Requires:

- authenticated principal;
- verified customer;
- trusted provider adapter evidence through
  `CustomerIdentityBindingAuthorityPort`;
- CSRF and Origin validation.

The request body is empty. Raw `providerSubject` or provider email in the body
is not proof and is rejected. Without a real trusted provider adapter,
production composition must fail closed.

## Rate Limiting

KS-08-03 reuses the KS-07-08-style rate-limit port. Registration and
verification are abuse-sensitive. Account reads may use lighter policy.

If the configured limiter is required and unavailable for sensitive mutations,
the transport returns `TEMPORARILY_UNAVAILABLE` and does not bypass silently.
The in-memory limiter remains local/test only; production distributed rate
limiting is not ready.

Limiter keys must be safe fingerprints. Raw session tokens, verification
tokens and emails must not be exposed as limiter keys.

## Safety Counters

Tests assert that:

- invalid request syntax does not call session resolution;
- invalid or denied sessions do not call account repositories;
- wrong-owner and legacy reads do not decrypt, deliver or consume capabilities;
- verification and guest-claim tokens are not echoed or audited.
