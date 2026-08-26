# Customer Authentication

KS-07-07 adds the production customer authentication foundation. It does not
implement password authentication, OAuth, WooCommerce login, a frontend login
UI, checkout, email delivery, live Stripe mutation, Kinguin procurement or key
retrieval.

## Trust Boundary

Customer authentication starts at `CustomerAuthenticationAuthorityPort`. A
future adapter must derive the provider subject from trusted provider-side
context, not from request input. The verified assertion contains:

- provider;
- provider subject;
- assurance level;
- authenticated timestamp;
- expiration timestamp;
- opaque authentication context ID.

Only `AUTHENTICATED` assertions can create production sessions. `TEST`
assurance remains test-only and cannot become a production delivery principal.
Email is not authentication, and no session is created by matching email.

## Identity Resolution

The assertion resolves through persisted
`(provider, providerSubject) -> customer_identity_bindings -> customerId`.

If the assertion is valid but no binding exists, session creation fails closed
with `IDENTITY_UNBOUND`. The service never accepts caller-supplied `customerId`
as proof of authentication and never auto-binds by provider email.

KS-08-01 customer account reads consume the resulting
`AuthenticatedCustomerPrincipal`. The account service does not resolve raw
session tokens itself and does not accept request-supplied `customerId` as an
authorization source.

KS-08-02 registration and email verification do not create a session. Future
registration transports must still authenticate through the KS-07-07 assertion
and session flow after a trusted identity binding exists.

## Session Model

`customer_auth_sessions` stores server-side sessions with:

- session ID UUID;
- customer ID;
- identity binding reference;
- provider;
- SHA-256 session token hash;
- created, authenticated, expiration, last-seen and revoked timestamps;
- record version;
- assurance;
- opaque authentication context ID.

Raw tokens are random 32-byte base64url values. They are returned exactly once
from create or rotate operations and are never stored, inspected or audited.
The database stores only the unique SHA-256 hash.

Runtime configuration:

- `KEYCORE_CUSTOMER_SESSION_TTL_MS`, default `28800000`;
- `KEYCORE_CUSTOMER_SESSION_IDLE_TIMEOUT_MS`, default `3600000`;
- `KEYCORE_CUSTOMER_SESSION_TOUCH_INTERVAL_MS`, default `300000`.

Invalid values fail closed. The touch interval must not exceed the idle timeout,
and the idle timeout must not exceed the absolute TTL.

## Resolution, Rotation And Revocation

Session resolution hashes the raw token, finds the server-side session, checks
revocation, absolute expiration, idle timeout, customer existence and the
authoritative identity binding ID, then returns an
`AuthenticatedCustomerPrincipal` with `AUTHENTICATED` assurance. A session is
invalid if its stored `identityBindingId` no longer exists or if that binding no
longer belongs to the same customer/provider pair. Resolution does not fall back
to email, provider subject or caller-supplied customer ID.

Rotation replaces the stored hash atomically. The old token becomes unusable;
only one concurrent rotation can win. Rotation uses the same session validation,
so a missing or non-authoritative identity binding cannot receive a replacement
token. Logout/revoke is idempotent. Revoke-all marks all active sessions for a
customer revoked through an internal service operation.

`lastSeenAt` is updated only when the prior value is older than the configured
touch interval to avoid write amplification.

## Cookie And Transport Policy

KS-07-07 is transport-neutral. A future HTTP adapter must send the opaque token
only in a secure server-managed cookie:

- `HttpOnly`;
- `Secure` outside local development;
- `SameSite=Lax` or stricter unless a future flow explicitly requires another
  reviewed setting;
- `Path=/`;
- no token in URLs, localStorage, logs, analytics, audit metadata or inspect
  output.

Future state-changing customer HTTP endpoints must include CSRF protection
appropriate to the selected cookie policy.

KS-07-08 defines that customer delivery mutations use a secure cookie session
credential, configured allowed origins and an HMAC double-submit CSRF token
bound to the session credential hash. The CSRF token is not an authentication
credential and cannot create a principal.

KS-08-03 reuses that session-resolution chain for account transport:

```text
request cookie/header -> opaque session token -> KS-07-07 session resolver
-> AuthenticatedCustomerPrincipal -> account or registration application handler
```

Request `customerId` is never accepted as a principal source. The browser cookie
contract remains `HttpOnly; Secure; SameSite=Lax; Path=/`, with no session token
in URLs or localStorage.

## Audit And Inspect

Safe audit events include authentication failure and session create, rotate and
revoke. Audit metadata may contain customer ID, provider, assurance, opaque auth
context ID and safe reason codes. It must not contain raw tokens, token hashes,
provider subjects, provider tokens, emails when customer ID is sufficient,
product keys or decrypted secrets.

DB-only inspection:

```sh
npm run customer-session:inspect -- <sessionId>
```

The command prints safe state such as status, customer ID, provider, assurance,
timestamps and record version. It does not print raw tokens, token hashes,
provider subjects, product keys or customer/order data beyond the session's
customer ID.

## Live Data Rule

The known live fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` remains
untouched by KS-07-07. This task does not decrypt, display, deliver, retrieve,
assign fabricated ownership, mutate Kinguin or change its delivery state.
