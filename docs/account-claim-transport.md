# Account Claim Transport

## Boundary

`Kauf hinzufügen` posts a WordPress nonce-protected form to the plugin. The
plugin resolves the logged-in WordPress user and its server-maintained KeyCore
customer mapping, then sends an exact-schema request through the existing HMAC
bridge. The browser supplies only the claim code. It cannot select the customer,
order, email, ownership, payment, fulfillment or Product Key state.

The staging claim adapter composes the existing `CustomerRegistrationService`,
`PersistedGuestOrderClaimAuthority`, `CustomerOrderIdentityService` and
PostgreSQL repositories. These existing services verify the authenticated and
verified customer, compare the immutable checkout-email snapshot, atomically
consume the hash-only challenge and bind ownership. PostgreSQL remains the
durable authority.

## Threat Controls

- WordPress authentication, nonce verification and strict same-origin checking
  precede the internal request.
- HMAC request/response signatures bind method, path, origin, trusted identity,
  CSRF assertion and body hash. Redirects are disabled.
- Only `{ "claimCode": string }` is accepted; unknown fields and malformed or
  oversized inputs fail closed.
- Claim attempts are bounded per mapped customer. Invalid, wrong-owner,
  consumed, revoked and unknown claims share `CLAIM_INVALID` externally.
- Backend exceptions become `TEMPORARILY_UNAVAILABLE`; raw exceptions and claim
  values are never returned or written to audit metadata.
- Successful responses do not echo the claim code or internal order identifier.
- Account list/detail access remains owner-filtered and Product Key reveal
  remains a separate explicit, authorized, no-store action.

## Synthetic Fixture

The staging bootstrap requires `KEYRANO_STAGING_GUEST_CLAIM_CODE`. It must be a
locally generated, obviously synthetic value beginning with `SYNTHETIC_`. The
bootstrap stores only its SHA-256 hash with one deterministic synthetic guest
order whose immutable checkout-email snapshot matches customer A.
The checked-in `GENERATE_LOCALLY` placeholder is rejected at runtime.

Insertion is idempotent. A consumed challenge is not recreated, its order is
not unbound, and a changed code or conflicting owner makes bootstrap fail
closed. To repeat the complete human scenario, confirm `KEYCORE_ENV=STAGING`
and recreate the isolated staging data volumes; never reset a production or
shared environment.

## Human Evidence

The product owner confirmed UAT-015 `PASS` on 2026-09-02; the scoped textual
record is `docs/uat/human-uat-2026-09-02-account-history.md`. UAT-018 already
remains `PASS` from 2026-09-01. Neither result approves KS-11-07,
`SECURITY-READINESS` or production. Any later screenshots must remain redacted
and omit claim codes, customer email, cookies, request signatures, Product Keys
and credentials.
