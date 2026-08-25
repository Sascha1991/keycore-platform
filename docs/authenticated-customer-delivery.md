# Authenticated Customer Delivery Transport

KS-07-08 adds a transport-neutral application boundary for authenticated
customer delivery requests. KeyCore still has no production HTTP server or
customer frontend in this task, so no new HTTP framework is introduced.

## Transport Shape

The handler models a future browser API as POST-only JSON operations:

- prepare delivery capability;
- execute delivery with the one-time capability.

Requests are bounded by configured body size and must use `application/json`.
The handler rejects supplier identifiers such as Kinguin order IDs and does not
accept `customerId` as an authorization input. Customer identity comes only
from:

```text
opaque session credential -> KS-07-07 session resolution -> principal
```

The customer-facing resource reference is the KeyCore-owned fulfillment UUID
plus order UUID. These are opaque UUIDs, not sequential IDs and not supplier
references.

## Security Policy

Browser session transport is a secure cookie contract:

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

Session credentials, delivery capabilities and CSRF tokens must not be placed
in URLs, localStorage, logs or audit metadata.

Credentialed delivery mutations require:

- configured allowed origin;
- HMAC double-submit CSRF token bound to the session credential hash;
- one-time delivery capability;
- rate-limit check by hashed session/resource/IP dimensions.

`KEYCORE_CUSTOMER_ALLOWED_ORIGINS` is required for production composition and
does not accept wildcard `*`. Local development may use `http://localhost`.
Staging and production accept HTTPS origins only, including for localhost. CORS
must never combine wildcard origin with credentials.

Invalid Origin is rejected before CSRF validation, session resolution,
authorization, decrypt or delivery. Invalid or failing CSRF validation is
rejected before session resolution. If the rate limiter backend fails, delivery
fails closed with `TEMPORARILY_UNAVAILABLE`; it must not bypass abuse
protection.

## Capability Decision

KS-07-05 one-time delivery capability remains required as defense in depth.
Session authentication proves the customer principal. The capability proves a
recent authorized delivery preparation for the same fulfillment/order/customer
context. The capability is returned only once in the prepare response body,
stored only as a hash, consumed atomically and never included in URLs, audit or
inspect output.

## Response Policy

Responses use:

- `Cache-Control: no-store`;
- `Pragma: no-cache`;
- `Content-Type: application/json`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`.

The transport handler does not return product keys directly. It calls the
KS-07-05 secure delivery engine, which owns the decrypt and delivery boundary.
Synthetic tests use a fake delivery port and fake encrypted key fixture to prove
the path without enabling production customer delivery.

KS-08-01 customer account key-vault metadata does not bypass this delivery
boundary. Account pages may show key availability metadata, but any future key
reveal must still use authenticated delivery transport, one-time capability,
authorization and immediate pre-decrypt checks.

## Replay And Concurrency

Successful execution consumes the one-time capability and transitions the
fulfillment through the existing KS-07-05 delivery semantics. Replays receive
stable already-delivered, in-flight or delivery-not-available responses and do
not redeliver. Ten concurrent requests for the same synthetic fulfillment have
exactly one claim winner in tests.

HTTP response success is not human acknowledgement that a customer saw or
copied a key. KS-07-08 does not introduce human acknowledgement semantics.

## Failure Semantics

Customer-visible failures are stable and safe:

- `AUTHENTICATION_REQUIRED`;
- `ACCESS_DENIED`;
- `RESOURCE_NOT_AVAILABLE`;
- `DELIVERY_NOT_AVAILABLE`;
- `RATE_LIMITED`;
- `TEMPORARILY_UNAVAILABLE`;
- `BAD_REQUEST`.

Object authorization failures collapse to resource-not-available style
responses so the API does not reveal whether a fulfillment exists for another
customer. Authorization, CSRF, origin, session and capability failures occur
before decrypt and before the delivery port is invoked.

## Production Readiness

Implemented:

- transport-neutral handler;
- secure cookie policy contract;
- origin policy;
- CSRF policy abstraction and HMAC implementation;
- in-memory rate-limit port;
- synthetic end-to-end delivery path.

Not implemented:

- production HTTP server;
- production customer frontend;
- WooCommerce login;
- OAuth provider;
- password login;
- distributed production rate limiter;
- real customer delivery enablement.

Before production exposure, the composition root must connect a real HTTP
server, real customer frontend, real login provider, production CSRF secret
management, production-grade shared rate limiting and reviewed live-delivery
gates.

The known legacy fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` remains
unowned and protected. KS-07-08 must not decrypt, display, deliver or mutate it.
