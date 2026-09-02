# PHASE_12_ACCOUNT_TRANSPORT Implementation Report

## Status

Implementation was completed on a stacked feature branch and subsequently
squash-merged to `main` as PR #48. The product owner later accepted UAT-015 and
UAT-018. This report does not approve KS-11-07, `SECURITY-READINESS` or
production release.

## Reused Components

- `CustomerRegistrationService.claimGuestOrder`
- `PersistedGuestOrderClaimAuthority`
- `CustomerOrderIdentityService`
- `PostgresGuestOrderClaimRepository`
- `PostgresCustomerOrderIdentityRepository`
- `PostgresCustomerRegistrationChallengeRepository`
- `PostgresAuditEventRepository`
- Existing signed staging bridge, WordPress identity mapping, account projection
  and secure reveal boundary

No second claim rule set, migration or production business behavior was added.

## Implementation

The bridge exposes `POST /v1/account/claim` only after HMAC verification and
server-side identity mapping. It requires the CSRF assertion and exact
`claimCode` schema, applies a bounded per-customer attempt window and delegates
to the existing application service. Only `CLAIMED` is public success. Every
invalid/unavailable claim state is enumeration-resistant; outages return a
generic temporary-unavailability response.

WordPress now renders a German password-style claim-code form and submits it to
an authenticated `admin-post.php` handler. The handler verifies login, nonce
and same origin before calling the signed bridge. Result pages use no-store and
no-referrer headers and never echo the submitted code.

The staging bootstrap creates one deterministic synthetic guest order and
claim challenge. The raw synthetic code comes from environment configuration;
only its SHA-256 hash is stored. Repeated bootstrap preserves consumed state and
ownership, while changed fixture identity fails closed.

## Tests And Evidence

- Staging bridge coverage: authenticated success, schema rejection, missing
  identity, CSRF denial, generic replay denial, outage and secret omission.
- PostgreSQL coverage: wrong customer, successful ownership, owner projection,
  cross-owner denial, replay, later adapter/session persistence, hash-only
  storage, audit omission, idempotent reseed and fixture conflict.
- WordPress coverage: route registration, password input, nonce binding and
  omission of an unnecessary order identifier.
- `npm run check`: passed; 750 tests passed and 128 service-dependent tests
  skipped in the ordinary service-free run. Formatting, ESLint, TypeScript and
  secret scanning passed.
- Focused staging bridge: 11 passed. Focused Guest Claim, ownership, account and
  staging PostgreSQL: 8 passed. E2E acceptance: 16 passed.
- Security assessment with PostgreSQL: 60 passed and 342 intentionally filtered
  tests skipped. Focused staging/account/domain suite: 86 passed.
- PHP 8.3 syntax for every plugin file and the deterministic WordPress adapter
  test passed in an isolated container.
- Compose validation, UAT artifact validation, `npm audit --audit-level=low`,
  dedicated secret scan and `git diff --check` passed; audit reported zero
  vulnerabilities.
- A fully parallel local PostgreSQL run was not used as evidence because the
  shared staging service caused unrelated schema-initialization tests to hit
  their existing five-second limits. The affected suites passed in bounded
  isolated groups; GitHub Actions remains the full service-matrix authority.

## Rollback And Limitations

Rollback removes only the new presentation/transport composition and synthetic
fixture. Existing Guest Claim domain code and migration 019 remain unchanged.
The task does not add guest checkout, production authentication, invoice
documents, procurement, fulfillment, live payment/supplier operations or real
key delivery.

UAT-015 is `PASS` from the product owner's 2026-09-02 result, and UAT-018 is
`PASS` from the separate 2026-09-01 result. UAT-002 remains `PASS`. Other UAT
scenarios remain open, so KS-11-07 stays incomplete and
`SECURITY-READINESS` stays `NOT_APPROVED`.
